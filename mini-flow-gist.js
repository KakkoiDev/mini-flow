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

export async function backUpGist(id, token, backup) {
  const content = JSON.stringify(backup);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const gist = await gistRequest(id, token);
  if (snapshots(gist)[0]?.endsWith('-' + hash + '.json')) return false;
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const filename = 'mini-flow-' + timestamp + '-' + hash + '.json';
  await gistRequest(id, token, { files: { [filename]: { content } } });
  return true;
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

export function setupGistBackups({ panel, getActive, getProject, canBackUp, link, openProject }) {
  const get = key => panel.querySelector('[data-gist-' + key + ']');
  const address = get('id'), token = get('token'), status = get('status');
  const picker = get('picker'), select = get('snapshot'), load = get('load');
  const credentials = new Map();
  const backedUp = new WeakMap();
  let current, foundId, busy = false;

  function refresh() {
    const active = getActive();
    if (current !== active) {
      current = active;
      address.value = active?.gist ?? '';
      status.textContent = '';
      picker.hidden = load.hidden = true;
    }
    get('connect').disabled = busy || !active;
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

  async function backup(active, access, automatic = false) {
    if (!canBackUp()) {
      if (!automatic) throw new Error('Finish editing before backing up.');
      return;
    }
    const id = active.gist;
    const data = { version: 1, name: active.name, project: getProject() };
    const key = JSON.stringify([id, data]);
    if (automatic && backedUp.get(active) === key) return;
    const changed = await backUpGist(id, access, data);
    backedUp.set(active, key);
    if (getActive() === active) status.textContent = changed ? 'Gist backup saved.' : 'Gist backup is up to date.';
  }

  get('connect').onclick = () => run(async () => {
    const active = getActive();
    if (!active) throw new Error('Save or open a local project first.');
    const id = gistId(address.value);
    const access = token.value.trim() || credentials.get(id);
    if (!access) throw new Error('Enter a GitHub token with Gists write permission.');
    await gistRequest(id, access);
    await link(id, active);
    credentials.set(id, access);
    token.value = '';
    if (getActive() === active) await backup(active, access);
  });
  get('sync').onclick = () => run(async () => {
    const active = getActive();
    if (!active?.gist) throw new Error('Connect this project to a Gist first.');
    if (gistId(address.value) !== active.gist) throw new Error('Connect the entered Gist before backing up to it.');
    const access = token.value.trim() || credentials.get(active.gist);
    if (!access) throw new Error('Enter a GitHub token to resume backups.');
    await backup(active, access);
    credentials.set(active.gist, access);
    token.value = '';
  });
  get('disconnect').onclick = () => run(async () => {
    const active = getActive();
    if (!active?.gist) return;
    const id = active.gist;
    await link(null, active);
    credentials.delete(id);
    address.value = token.value = '';
    picker.hidden = load.hidden = true;
    status.textContent = 'Gist disconnected.';
  });
  get('open').onclick = () => run(async () => {
    picker.hidden = load.hidden = true;
    const id = gistId(address.value);
    const gist = await gistRequest(id, token.value.trim() || credentials.get(id));
    const names = snapshots(gist);
    if (!names.length) throw new Error('No Mini Flow backups found in this Gist.');
    foundId = id;
    select.replaceChildren(...names.map(name => {
      const date = snapshotPattern.exec(name)[1];
      const time = date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
      return new Option(new Date(time).toLocaleString() + ' · ' + name.slice(-12, -5), name);
    }));
    picker.hidden = load.hidden = false;
    status.textContent = '';
  });
  load.onclick = () => run(async () => {
    const id = gistId(address.value);
    if (id !== foundId) throw new Error('Find backups for the entered Gist first.');
    const item = await readSnapshot(id, token.value.trim() || credentials.get(id), select.value);
    openProject(item.project);
    status.textContent = 'Opened “' + item.name + '” as a working copy.';
  });
  setInterval(() => {
    const active = getActive();
    const access = credentials.get(active?.gist);
    if (access) run(() => backup(active, access, true));
  }, interval);
  refresh();
  return { refresh };
}
