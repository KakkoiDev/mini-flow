function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('mini-flow', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'name' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function projects(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('projects', mode);
      const store = transaction.objectStore('projects');
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Project storage was interrupted.'));
      action(store, value => { result = value; }, error => {
        reject(error);
        transaction.abort();
      });
    });
  } finally {
    database.close();
  }
}

function readProjects() {
  return projects('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
  });
}

function writeProject(name, project, active, gist = active?.name === name ? active.gist : undefined, autoBackup = active?.autoBackup) {
  const record = { name, project, revision: crypto.randomUUID(), updatedAt: Date.now(), ...(gist ? { gist, autoBackup } : {}) };
  return projects('readwrite', (store, done, abort) => {
    const existing = store.get(name);
    existing.onsuccess = () => {
      if (existing.result && active?.name !== name) {
        abort(new Error('That name already exists. Open the saved project to update it, or choose a different name.'));
        return;
      }
      if (active?.name === name && existing.result?.revision !== active.revision) {
        abort(new Error('This project changed in another tab. Save your board under a different name to keep both copies.'));
        return;
      }
      function save() {
        const write = store.put(record);
        write.onsuccess = () => done(record);
      }
      if (gist && existing.result?.gist !== gist) {
        const linked = store.getAll();
        linked.onsuccess = () => {
          if (linked.result.some(item => item.name !== name && item.gist === gist)) {
            abort(new Error('This Gist is already linked to another saved project in this browser.'));
          } else save();
        };
      } else save();
    };
  });
}

function manageProject(record, newName) {
  return projects('readwrite', (store, done, abort) => {
    const read = store.get(record.name);
    read.onsuccess = () => {
      const existing = read.result;
      if (existing?.revision !== record.revision) {
        abort(new Error('This project changed in another tab. Reopen it and try again.'));
        return;
      }
      if (newName) {
        const renamed = { ...existing, name: newName, revision: crypto.randomUUID() };
        store.add(renamed).onsuccess = () => {
          store.delete(record.name);
          done(renamed);
        };
      } else {
        store.delete(record.name);
      }
    };
  });
}

export function setupSavedProjects({ panel, editor, normalize, getActive, setActive, onError, onBackup, getBackupTime }) {
  const form = panel.querySelector('#saved-project-form');
  const nameField = form.elements.name;
  const saveButton = panel.querySelector('#save-project');
  const list = panel.querySelector('#saved-project-list');
  const hint = panel.querySelector('#saved-project-hint');
  const message = panel.querySelector('#saved-project-status');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  let busy = false;
  let opening = false;
  let writes = Promise.resolve();
  const queuedSnapshots = new WeakMap();
  let refreshRevision = 0;
  const rows = new Map();

  function enqueue(action) {
    const job = writes.then(action);
    writes = job.catch(() => {});
    return job;
  }

  function updateSaveButton() {
    const name = nameField.value.trim();
    const current = name && getActive()?.name === name;
    saveButton.disabled = busy || !name || Boolean(current);
  }

  function makeButton(label, action, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (name) button.setAttribute('aria-label', label + ' ' + name);
    button.onclick = action;
    return button;
  }

  async function deleteProject(record) {
    if (busy) return;
    busy = true;
    try {
      await enqueue(async () => {
        const active = getActive();
        const current = active?.name === record.name;
        await manageProject(current ? active : record);
        if (current) {
          active.deleted = true;
          if (getActive() === active) setActive(null);
        }
      });
      message.textContent = 'Saved project deleted.';
      await refresh();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      updateSaveButton();
    }
  }

  function confirmDelete(row, actions, record) {
    if (busy) return;
    panel.querySelector('.project-action-form')?.remove();
    const form = document.createElement('form');
    form.className = 'project-action-form';
    const question = document.createElement('span');
    question.textContent = `Delete “${record.name}”?`;
    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.textContent = 'Delete project';
    const cancel = makeButton('Cancel', () => {
      form.remove();
      actions.querySelector('button').focus();
    });
    form.append(question, confirm, cancel);
    form.onsubmit = event => {
      event.preventDefault();
      deleteProject(record);
    };
    row.append(form);
    cancel.focus();
  }

  function editTitle(entry) {
    const { title, field, record } = entry;
    if (busy) return;
    field.value = record.name;
    title.hidden = true;
    field.hidden = false;
    field.focus();
    field.select();

    let draftVersion = 0;
    function saveTitle() {
      if (field.hidden) return;
      const version = ++draftVersion;
      const next = field.value.trim();
      if (!next) {
        message.textContent = 'Enter a project name.';
        return;
      }
      enqueue(async () => {
        if (version !== draftVersion) return;
        if (next === record.name) {
          message.textContent = '';
          return;
        }
        const previous = record.name;
        const active = getActive();
        const current = active?.name === previous;
        const renamed = await manageProject(current ? active : record, next);
        rows.delete(previous);
        Object.assign(record, renamed);
        rows.set(record.name, entry);
        updateRow(entry);
        if (current) {
          Object.assign(active, { name: renamed.name, revision: renamed.revision });
          if (getActive() === active) setActive(renamed, { reuse: true });
        }
        markCurrentProject();
        if (version === draftVersion) message.textContent = '';
      }).catch(error => {
        if (version === draftVersion) {
          message.textContent = error.name === 'ConstraintError' ? 'That project name already exists.' : error.message;
        }
      });
    }

    field.oninput = event => { if (!event.isComposing) saveTitle(); };
    field.oncompositionend = saveTitle;
    field.onblur = () => {
      field.hidden = true;
      title.hidden = false;
    };
    field.onkeydown = event => {
      if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
      event.preventDefault();
      event.stopPropagation();
      field.blur();
      title.focus();
    };
  }

  function syncBackupTimes() {
    for (const { record, backupTime } of rows.values()) {
      if (!backupTime) continue;
      const timestamp = getBackupTime(record.gist);
      if (timestamp) setSavedTime(backupTime, Date.parse(timestamp));
      else {
        backupTime.removeAttribute('datetime');
        backupTime.textContent = 'No backup yet';
      }
    }
  }

  function updateRow({ record, title, open, remove, time }) {
    title.textContent = record.name;
    title.dataset.projectName = record.name;
    title.setAttribute('aria-label', 'Rename ' + record.name);
    open.setAttribute('aria-label', 'Open ' + record.name);
    remove.setAttribute('aria-label', 'Delete ' + record.name);
    setSavedTime(time, record.updatedAt);
  }

  async function refresh() {
    const revision = ++refreshRevision;
    let records;
    try { await writes; records = await readProjects(); }
    catch {
      if (revision === refreshRevision) message.textContent = 'Could not read saved projects in this browser.';
      return;
    }
    if (revision !== refreshRevision) return;
    list.replaceChildren();
    rows.clear();
    if (!records.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No saved projects yet.';
      list.append(empty);
      return;
    }
    for (const record of records) {
      const row = document.createElement('li');
      const details = document.createElement('div');
      const title = makeButton(record.name, () => editTitle(entry));
      title.className = 'project-title';
      title.title = 'Click to rename';
      const field = document.createElement('input');
      field.className = 'project-title-input';
      field.setAttribute('aria-label', 'Project title');
      field.maxLength = 80;
      field.hidden = true;
      const current = document.createElement('span');
      current.className = 'project-current';
      current.textContent = 'Current';
      current.hidden = true;
      const date = document.createElement('small');
      const time = document.createElement('time');
      date.append('Last saved ', time, current);
      details.append(title, field, date);
      const open = makeButton('Open', async () => {
        if (busy) return;
        busy = true;
        try {
          await writes;
          const latest = await projects('readonly', (store, done) => {
            const request = store.get(record.name);
            request.onsuccess = () => done(request.result);
          });
          if (!latest) throw new Error('This project is no longer saved.');
          opening = true;
          editor.setProject(normalize(latest.project), { message: 'Opened ' + latest.name + '.' });
          Object.assign(record, latest);
          updateRow(entry);
          setActive(latest);
          message.textContent = '';
          open.focus({ preventScroll: true });
        } catch (error) {
          message.textContent = 'Could not open project. ' + error.message;
        } finally {
          opening = busy = false;
          updateSaveButton();
        }
      }, record.name);
      const actions = document.createElement('div');
      actions.className = 'project-row-actions';
      const remove = makeButton('Delete', () => confirmDelete(row, actions, record), record.name);
      const entry = { record, title, field, open, remove, time, current };
      rows.set(record.name, entry);
      updateRow(entry);
      actions.append(open, remove);
      row.append(details, actions);
      if (record.gist) {
        const backupRow = document.createElement('div');
        backupRow.className = 'project-gist-actions';
        const backup = makeButton('Back up to Gist', async () => {
          backup.disabled = true;
          try {
            await writes;
            const latest = (await readProjects()).find(item => item.name === record.name);
            if (!latest || latest.gist !== record.gist) throw new Error('Reopen this project to refresh its Gist settings.');
            message.textContent = await onBackup(latest);
          } catch (error) {
            message.textContent = error.message;
          } finally {
            backup.disabled = false;
          }
        }, record.name);
        const gistLink = document.createElement('a');
        gistLink.href = 'https://gist.github.com/' + encodeURIComponent(record.gist);
        gistLink.target = '_blank';
        gistLink.rel = 'noopener noreferrer';
        gistLink.textContent = 'Open Gist';
        const lastBackup = document.createElement('small');
        const backupTime = document.createElement('time');
        lastBackup.append('Last backup · ', backupTime);
        entry.backupTime = backupTime;
        backupRow.append(backup, gistLink, lastBackup);
        row.append(backupRow);
      }
      list.append(row);
    }
    markCurrentProject();
    syncBackupTimes();
  }

  function markCurrentProject() {
    const active = getActive();
    hint.hidden = !rows.size || Boolean(active);
    for (const { record, title, current } of rows.values()) {
      const isCurrent = record.name === active?.name;
      current.hidden = !isCurrent;
      if (isCurrent) title.setAttribute('aria-current', 'true');
      else title.removeAttribute('aria-current');
    }
  }

  function setSavedTime(time, timestamp) {
    time.dateTime = new Date(timestamp).toISOString();
    time.textContent = dateFormat.format(timestamp);
  }

  function syncActive() {
    markCurrentProject();
    updateSaveButton();
  }
  syncActive();
  nameField.addEventListener('input', updateSaveButton);
  form.onsubmit = async event => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name || busy || name === getActive()?.name) return;
    busy = true;
    nameField.readOnly = true;
    updateSaveButton();
    try {
      const active = getActive();
      const project = normalize(editor.getProject());
      const record = await enqueue(() => writeProject(name, project, active));
      if (getActive() === active && (active?.name === name ||
          JSON.stringify(normalize(editor.getProject())) === JSON.stringify(project))) setActive(record);
      nameField.value = '';
      form.hidden = true;
      message.textContent = 'Project saved.';
      await refresh();
    } catch (error) {
      message.textContent = 'Could not save project. ' + error.message;
    } finally {
      busy = false;
      nameField.readOnly = false;
      updateSaveButton();
    }
  };
  return { refresh, syncActive, syncBackupTimes, async applyRemote(project, active, canApply) {
    return enqueue(async () => {
      if (getActive() !== active || active.deleted || !canApply()) throw new Error('The board changed during sync. Try again.');
      const previous = JSON.stringify(normalize(editor.getProject()));
      const record = await writeProject(active.name, project, active);
      active.revision = record.revision;
      if (getActive() !== active || !canApply() || JSON.stringify(normalize(editor.getProject())) !== previous) {
        throw new Error('The board changed during sync. Your current edits are still open.');
      }
      opening = true;
      try {
        editor.setProject(project, { message: 'Applied cloud changes.' });
        queuedSnapshots.set(active, JSON.stringify(project));
        setActive(record, { reuse: true, silent: true });
      } finally { opening = false; }
      void refresh().catch(error => onError(error.message));
    });
  }, async linkGist(gist, active, autoBackup = false) {
    await enqueue(async () => {
      if (!active || getActive() !== active || active.deleted) throw new Error('Open the project you want to connect.');
      const record = await writeProject(active.name, normalize(editor.getProject()), active, gist, autoBackup);
      Object.assign(active, { revision: record.revision, gist, autoBackup });
      if (getActive() === active) setActive(record, { reuse: true });
    });
    await refresh();
  }, autosave(project) {
    const active = getActive();
    if (opening || !active) return;
    const snapshot = JSON.stringify(project);
    if (queuedSnapshots.get(active) === snapshot) return;
    queuedSnapshots.set(active, snapshot);
    enqueue(async () => {
      if (active.deleted) return;
      const record = await writeProject(active.name, project, active);
      active.revision = record.revision;
      if (getActive() === active) setActive(record, { reuse: true, silent: true });
      const entry = rows.get(record.name);
      if (entry) {
        Object.assign(entry.record, record);
        setSavedTime(entry.time, record.updatedAt);
      }
    }).catch(error => {
      if (queuedSnapshots.get(active) === snapshot) queuedSnapshots.delete(active);
      const text = 'Could not autosave ' + active.name + '. ' + error.message;
      message.textContent = text;
      onError(text);
    });
  } };
}
