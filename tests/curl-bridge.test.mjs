import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeServer } from '../bridge/server.mjs';
import { connectAgentBridge } from '../mini-flow-bridge.js';
import { createLiveSession, newLiveInvite } from '../mini-flow-live.js';

function listenWithCurl(url, token, t) {
  const child = spawn('curl', ['--silent', '--show-error', '--fail', '--no-buffer',
    '--header', 'Authorization: Bearer ' + token, url]);
  t.after(() => child.kill());
  let buffer = '';
  const events = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const [event, data] = buffer.slice(0, end).split('\n');
      buffer = buffer.slice(end + 2);
      if (event.startsWith('event: ')) events.push([event.slice(7), JSON.parse(data.slice(6))]);
    }
  });
  return async name => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const event = events.find(([type]) => type === name);
      if (event) return event[1];
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('curl did not receive ' + name);
  };
}

test('curl receives Ask AI, and only one guest can claim and edit', { timeout: 16000 }, async t => {
  const server = createBridgeServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const invite = newLiveInvite();
  const room = await connectAgentBridge({
    selfId: 'host', onPeerJoin() {}, onPeerLeave() {}, onMessage() {}, leave() {}
  }, invite, base, () => {});
  let project = { version: 1, source: 'flowchart TD\n    %% mini-flow {"notes":[{"id":"N1","label":"Update the diagram"}],"bends":[]}', positions: { N1: [100, 100] } };
  let counts;
  let requests;
  const host = createLiveSession({
    room, host: true, getProject: () => project, setProject: next => { project = next; },
    normalize: next => next, canAccept: () => true, onStatus() {}, onEnd() {},
    onGuestCounts: next => { counts = next; }, onAIRequests: next => { requests = next; },
    readNote: (_, id) => ({ id, text: 'Update the diagram', target: null })
  });
  t.after(() => host.stop());
  const joinPath = '/v1/rooms/' + invite.room + '/agents';

  async function post(path, credential, input) {
    return fetch(base + path, { method: 'POST', headers: {
      Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json'
    }, body: JSON.stringify(input) });
  }

  assert.equal((await post(joinPath, 'invalid', {})).status, 401);
  const guests = await Promise.all([0, 1].map(async () => {
    const response = await post(joinPath, invite.password, {});
    assert.equal(response.status, 201, await response.clone().text());
    const guest = await response.json();
    return { ...guest, next: listenWithCurl(base + guest.events, guest.token, t) };
  }));
  await Promise.all(guests.map(guest => guest.next('ready')));
  assert.equal(counts.ai, 2);
  assert.equal((await host.askAI('N1')).ok, true);
  assert.equal(requests.N1.phase, 'waiting');
  assert.deepEqual(await Promise.all(guests.map(guest => guest.next('ask_ai'))), [
    { sequence: 1, noteId: 'N1' }, { sequence: 1, noteId: 'N1' }
  ]);
  assert.equal((await host.askAI('N1')).reason, 'already_requested');

  const call = async (guest, name, input = {}) =>
    (await post(guest.tools + '/' + name, guest.token, input)).json();
  const claims = await Promise.all(guests.map(guest => call(guest, 'wait_for_ai_request', { after: 0, timeoutMs: 0 })));
  assert.equal(claims.filter(claim => claim.request).length, 1);
  assert.equal(requests.N1.phase, 'working');
  const winner = guests[claims.findIndex(claim => claim.request)];
  const { revision } = await call(winner, 'get_board');
  assert.equal((await call(winner, 'report_ai_activity', { message: 'Updating note…' })).ok, true);
  assert.equal((await call(winner, 'apply_board_edit', {
    revision, message: 'Updated note', edits: [{ op: 'rename_node', id: 'N1', label: 'Updated via curl' }]
  })).ok, true);
  assert.match(project.source, /Updated via curl/);
  assert.equal((await call(winner, 'report_ai_activity', { message: '', result: 'Done' })).ok, true);
  for (let attempt = 0; requests.N1?.phase !== 'result' && attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual(requests.N1, { phase: 'result', label: 'Done' });
  host.stop();
  await Promise.all(guests.map(guest => guest.next('session_ended')));
});
