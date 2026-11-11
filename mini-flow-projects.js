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

export function setupSavedProjects({ dialog, trigger, editor, normalize, getActive, setActive }) {
  const form = dialog.querySelector('#saved-project-form');
  const nameField = form.elements.name;
  const saveButton = dialog.querySelector('#save-project');
  const list = dialog.querySelector('#saved-project-list');
  const message = dialog.querySelector('#saved-project-status');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let busy = false;

  function updateSaveButton() {
    const name = nameField.value.trim();
    saveButton.disabled = busy || !name;
    saveButton.textContent = name && getActive()?.name === name ? 'Save changes' : 'Save project';
  }

  async function refresh() {
    const records = await readProjects();
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
      const date = document.createElement('small');
      date.textContent = dateFormat.format(record.updatedAt);
      details.append(name, date);
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.setAttribute('aria-label', 'Open ' + record.name);
      open.onclick = () => {
        if (busy) return;
        try {
          editor.setProject(normalize(record.project), { message: 'Opened ' + record.name + '.' });
          setActive(record);
          dialog.close();
        } catch (error) {
          message.textContent = 'Could not open project. ' + error.message;
        }
      };
      row.append(details, open);
      list.append(row);
    }
  }

  trigger.onclick = async () => {
    nameField.value = getActive()?.name ?? '';
    message.textContent = '';
    list.replaceChildren();
    updateSaveButton();
    dialog.showModal();
    try { await refresh(); }
    catch { message.textContent = 'Could not read saved projects in this browser.'; }
  };
  nameField.addEventListener('input', updateSaveButton);
  form.onsubmit = async event => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name || busy) return;
    busy = true;
    nameField.readOnly = true;
    updateSaveButton();
    try {
      const record = await writeProject(name, normalize(editor.getProject()), getActive());
      setActive(record);
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
}
