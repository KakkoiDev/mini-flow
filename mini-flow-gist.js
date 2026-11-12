const interval = 5 * 60 * 1000;
const idPattern = /^[0-9a-f]{5,64}$/i;
const snapshotPattern = /^mini-flow-(\d{8}T\d{9}Z)-([0-9a-f]{64})\.json$/;

export function gistId(value) {
  const text = value.trim();
  if (idPattern.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text);
    const id = url.pathname.split('/').filter(Boolean).at(-1);
    if (url.origin === 'https://gist.github.com' && idPattern.test(id ?? '')) return id.toLowerCase();
  } catch {}
  throw new Error('Enter a GitHub Gist URL or ID.');
}

async function gistRequest(id, token, body) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch('https://api.github.com/gists/' + gistId(id), {
    method: body ? 'PATCH' : 'GET', headers, body: body && JSON.stringify(body),
    cache: 'no-store', redirect: 'error'
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'GitHub denied access. Check the token and Gist permissions.'
    : 'GitHub could not open or update this Gist (' + response.status + ').');
  return response.json();
}

function snapshots(gist) {
  return Object.keys(gist.files ?? {}).filter(name => snapshotPattern.test(name)).sort().reverse();
}

function snapshotTime(name) {
  return snapshotPattern.exec(name)[1].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
}

async function saveGistSnapshot(id, token, backup) {
  const content = JSON.stringify(backup);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const gist = await gistRequest(id, token);
  const latest = snapshots(gist)[0];
  if (latest?.endsWith('-' + hash + '.json')) return { changed: false, time: snapshotTime(latest) };
  const time = new Date().toISOString();
  const timestamp = time.replace(/[-:.]/g, '');
  const filename = 'mini-flow-' + timestamp + '-' + hash + '.json';
  await gistRequest(id, token, { files: { [filename]: { content } } });
  return { changed: true, time };
}

export async function backUpGist(id, token, backup) {
  return (await saveGistSnapshot(id, token, backup)).changed;
}

async function readSnapshot(id, token, name) {
  const gist = await gistRequest(id, token);
  const file = gist.files?.[name];
  if (!file || !snapshotPattern.test(name)) throw new Error('This backup is no longer available.');
  let text = file.content;
  if (file.truncated) {
    const url = new URL(file.raw_url);
    if (url.origin !== 'https://gist.githubusercontent.com' || !url.pathname.split('/').includes(id)) {
      throw new Error('GitHub returned an unexpected backup URL.');
    }
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw new Error('Could not read the backup file.');
    text = await response.text();
  }
  const backup = JSON.parse(text);
  if (backup?.version !== 1 || typeof backup.name !== 'string' || !backup.project) {
    throw new Error('This file is not a Mini Flow backup.');
  }
  return backup;
}

export function setupGistBackups({ panel, getActive, getProject, canBackUp, link, openProject, onBackupChange }) {
  const get = key => panel.querySelector('[data-gist-' + key + ']');
  const address = get('id'), token = get('token'), status = get('status');
  const picker = get('picker'), select = get('snapshot'), load = get('load');
  const lastBackup = get('last-backup'), backupTime = get('backup-time'), autoBackup = get('auto');
  const credentials = new Map(), backupTimes = new Map();
  const backedUp = new WeakMap();
  let current, currentGist, tokenGist, foundId, busy = false;

  function readStored(storage, key) {
    try { return globalThis[storage].getItem(key) ?? undefined; } catch {}
  }

  function writeStored(storage, key, value) {
    try {
      if (value === undefined) globalThis[storage].removeItem(key);
      else globalThis[storage].setItem(key, value);
    } catch {}
  }

  function tokenKey(id) { return 'mini-flow-gist-token:' + id; }
  function timeKey(id) { return 'mini-flow-gist-last-backup:' + id; }

  function savedToken(id) {
    return id && (credentials.get(id) ?? readStored('sessionStorage', tokenKey(id)));
  }

  function enteredGist() {
    try { return gistId(address.value); } catch {}
  }

  function accessFor(id) {
    return ((!tokenGist || tokenGist === id) && token.value.trim()) || savedToken(id);
  }

  address.addEventListener('input', () => {
    const id = enteredGist();
    if ((tokenGist && tokenGist !== id) || !token.value) token.value = savedToken(id) ?? '';
    tokenGist = id;
    autoBackup.checked = Boolean(id && id === currentGist && current?.autoBackup !== false);
    picker.hidden = true;
  });
  token.addEventListener('input', () => { tokenGist = enteredGist(); });

  function getBackupTime(id) {
    const time = id && (backupTimes.get(id) ?? readStored('localStorage', timeKey(id)));
    return time && Number.isFinite(Date.parse(time)) ? time : undefined;
  }

  function refresh() {
    const active = getActive();
    const id = active?.gist;
    if (current !== active || currentGist !== id) {
      if (current !== active) status.textContent = '';
      current = active;
      currentGist = tokenGist = id;
      address.value = id ?? '';
      token.value = savedToken(id) ?? '';
      autoBackup.checked = Boolean(id && active?.autoBackup !== false);
      picker.hidden = true;
    }
    const time = getBackupTime(id);
    lastBackup.hidden = !id;
    if (time) {
      backupTime.dateTime = time;
      backupTime.textContent = new Date(time).toLocaleString();
    } else {
      backupTime.removeAttribute('datetime');
      backupTime.textContent = 'No backup recorded yet';
    }
    get('connect').disabled = busy || !active;
    autoBackup.disabled = busy || !active;
    get('sync').disabled = busy || !active?.gist;
    get('disconnect').hidden = !active?.gist;
    get('disconnect').disabled = busy;
    get('open').disabled = load.disabled = busy;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    refresh();
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; refresh(); }
  }

  async function backup(record, access, automatic = false) {
    const active = getActive();
    const isCurrent = active?.name === record.name;
    if (isCurrent && !canBackUp()) {
      if (!automatic) throw new Error('Finish editing before backing up.');
      return;
    }
    const id = record.gist;
    const data = { version: 1, name: record.name, project: isCurrent ? getProject() : record.project };
    const key = JSON.stringify([id, data]);
    if (automatic && backedUp.get(active) === key) return;
    const { changed, time } = await saveGistSnapshot(id, access, data);
    credentials.set(id, access);
    writeStored('sessionStorage', tokenKey(id), access);
    if (tokenGist === id && !token.value) token.value = access;
    backupTimes.set(id, time);
    writeStored('localStorage', timeKey(id), time);
    if (isCurrent) backedUp.set(active, key);
    onBackupChange();
    const message = changed ? 'Gist backup saved.' : 'Gist backup is up to date.';
    if (isCurrent && getActive() === active) status.textContent = message;
    return message;
  }

  get('connect').onclick = () => run(async () => {
    const active = getActive();
    if (!active) throw new Error('Save or open a local project first.');
    const id = gistId(address.value);
    const access = accessFor(id);
    if (!access) throw new Error('Enter a GitHub token with Gists write permission.');
    const gist = await gistRequest(id, access);
    await link(id, active, autoBackup.checked);
    credentials.set(id, access);
    writeStored('sessionStorage', tokenKey(id), access);
    if (getActive() === active) {
      token.value = access;
      status.textContent = 'Gist connected. Use Back up now to save a snapshot.';
    }
    const latest = snapshots(gist)[0];
    if (latest) {
      const time = snapshotTime(latest);
      backupTimes.set(id, time);
      writeStored('localStorage', timeKey(id), time);
      onBackupChange();
    }
  });
  autoBackup.addEventListener('change', () => {
    const active = getActive();
    if (!active?.gist || enteredGist() !== active.gist) return;
    const enabled = autoBackup.checked;
    return run(async () => {
      try { await link(active.gist, active, enabled); }
      finally { autoBackup.checked = active.autoBackup !== false; }
    });
  });
  get('sync').onclick = () => run(async () => {
    const active = getActive();
    if (!active?.gist) throw new Error('Connect this project to a Gist first.');
    if (gistId(address.value) !== active.gist) throw new Error('Connect the entered Gist before backing up to it.');
    const access = accessFor(active.gist);
    if (!access) throw new Error('Enter a GitHub token to resume backups.');
    await backup(active, access);
  });
  get('disconnect').onclick = () => run(async () => {
    const active = getActive();
    if (!active?.gist) return;
    const id = active.gist;
    await link(null, active);
    credentials.delete(id);
    writeStored('sessionStorage', tokenKey(id), undefined);
    address.value = token.value = '';
    picker.hidden = true;
    status.textContent = 'Gist disconnected.';
  });
  get('open').onclick = () => run(async () => {
    picker.hidden = true;
    const id = gistId(address.value);
    const gist = await gistRequest(id, accessFor(id));
    const names = snapshots(gist);
    if (!names.length) throw new Error('No Mini Flow backups found in this Gist.');
    foundId = id;
    select.replaceChildren(...names.map(name => {
      const time = snapshotTime(name);
      return new Option(new Date(time).toLocaleString() + ' · ' + name.slice(-12, -5), name);
    }));
    picker.hidden = false;
    status.textContent = '';
  });
  load.onclick = () => run(async () => {
    const id = gistId(address.value);
    if (id !== foundId) throw new Error('Find backups for the entered Gist first.');
    const item = await readSnapshot(id, accessFor(id), select.value);
    openProject(item.project);
    status.textContent = 'Opened “' + item.name + '” as a working copy.';
  });
  setInterval(() => {
    const active = getActive();
    const access = savedToken(active?.gist);
    if (access && active.autoBackup !== false) return run(() => backup(active, access, true));
  }, interval);
  refresh();
  return { refresh, getBackupTime, async backupProject(record) {
    if (busy) throw new Error('A Gist action is already running.');
    const access = enteredGist() === record.gist ? accessFor(record.gist) : savedToken(record.gist);
    if (!access) throw new Error('Open this project and enter its GitHub token to back it up.');
    busy = true;
    refresh();
    try { return await backup(record, access); }
    finally { busy = false; refresh(); }
  } };
}
