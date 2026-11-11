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

function writeProject(name, project, active) {
  const record = { name, project, revision: crypto.randomUUID(), updatedAt: Date.now() };
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
      const write = store.put(record);
      write.onsuccess = () => done(record);
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
        const renamed = { ...existing, name: newName, revision: crypto.randomUUID(), updatedAt: Date.now() };
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

export function setupSavedProjects({ panel, editor, normalize, getActive, setActive, onError }) {
  const form = panel.querySelector('#saved-project-form');
  const nameField = form.elements.name;
  const saveButton = panel.querySelector('#save-project');
  const list = panel.querySelector('#saved-project-list');
  const message = panel.querySelector('#saved-project-status');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let busy = false;
  let opening = false;
  let writes = Promise.resolve();
  const queuedSnapshots = new WeakMap();
  let refreshRevision = 0;

  function enqueue(action) {
    const job = writes.then(action);
    writes = job.catch(() => {});
    return job;
  }

  function updateSaveButton() {
    const name = nameField.value.trim();
    const current = name && getActive()?.name === name;
    saveButton.disabled = busy || !name || Boolean(current);
    saveButton.textContent = current ? 'Autosave on' : 'Save project';
  }

  function makeButton(label, action, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (name) button.setAttribute('aria-label', label + ' ' + name);
    button.onclick = action;
    return button;
  }

  async function manage(record, newName) {
    if (busy) return;
    busy = true;
    try {
      await enqueue(async () => {
        const active = getActive();
        const current = active?.name === record.name;
        const updated = await manageProject(current ? active : record, newName);
        if (current) {
          if (updated) Object.assign(active, { name: updated.name, revision: updated.revision });
          else active.deleted = true;
          if (getActive() === active) setActive(updated, { reuse: Boolean(updated) });
        }
      });
      message.textContent = newName ? 'Project renamed.' : 'Saved project deleted.';
      await refresh();
    } catch (error) {
      message.textContent = error.name === 'ConstraintError' ? 'That name already exists.' : error.message;
    } finally {
      busy = false;
      updateSaveButton();
    }
  }

  function showActions(row, actions, record, rename) {
    if (busy) return;
    panel.querySelector('.project-action-form')?.remove();
    const form = document.createElement('form');
    form.className = 'project-action-form';
    const label = document.createElement('label');
    label.textContent = rename ? 'New project name' : `Delete “${record.name}”?`;
    const field = document.createElement('input');
    if (rename) {
      field.value = record.name;
      field.maxLength = 80;
      field.required = true;
      label.append(field);
    }
    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.textContent = rename ? 'Save name' : 'Delete project';
    const cancel = makeButton('Cancel', () => { form.remove(); actions.querySelector('button').focus(); });
    form.append(label, confirm, cancel);
    form.onsubmit = event => {
      event.preventDefault();
      const name = field.value.trim();
      if (rename && (!name || name === record.name)) return;
      manage(record, rename ? name : undefined);
    };
    row.append(form);
    (rename ? field : cancel).focus();
  }

  async function refresh() {
    const revision = ++refreshRevision;
    let records;
    try { records = await readProjects(); }
    catch {
      if (revision === refreshRevision) message.textContent = 'Could not read saved projects in this browser.';
      return;
    }
    if (revision !== refreshRevision) return;
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No saved projects yet.';
      list.append(empty);
      return;
    }
    for (const record of records) {
      const row = document.createElement('li');
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = record.name;
      name.dataset.projectName = record.name;
      const date = document.createElement('small');
      date.textContent = dateFormat.format(record.updatedAt);
      details.append(name, date);
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
      actions.append(open, makeButton('Rename', () => showActions(row, actions, record, true), record.name),
        makeButton('Delete', () => showActions(row, actions, record, false), record.name));
      row.append(details, actions);
      list.append(row);
    }
    markCurrentProject();
  }

  function markCurrentProject() {
    for (const name of list.querySelectorAll('[data-project-name]')) {
      if (name.dataset.projectName === getActive()?.name) name.setAttribute('aria-current', 'true');
      else name.removeAttribute('aria-current');
    }
  }

  function syncActive() {
    nameField.value = getActive()?.name ?? '';
    markCurrentProject();
    updateSaveButton();
  }
  syncActive();
  nameField.addEventListener('input', updateSaveButton);
  form.onsubmit = async event => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name || busy) return;
    busy = true;
    nameField.readOnly = true;
    updateSaveButton();
    try {
      const active = getActive();
      const project = normalize(editor.getProject());
      const record = await enqueue(() => writeProject(name, project, active));
      if (getActive() === active && (active?.name === name ||
          JSON.stringify(normalize(editor.getProject())) === JSON.stringify(project))) setActive(record);
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
  return { refresh, syncActive, autosave(project) {
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
    }).catch(error => {
      if (queuedSnapshots.get(active) === snapshot) queuedSnapshots.delete(active);
      const text = 'Could not autosave ' + active.name + '. ' + error.message;
      message.textContent = text;
      onError(text);
    });
  } };
}
