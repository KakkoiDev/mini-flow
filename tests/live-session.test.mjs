import assert from 'node:assert/strict';
import test from 'node:test';
import '../mini-flow.js';
import { createLiveSession } from '../mini-flow-live.js';
import { registerMiniFlowTools } from '../mini-flow-webmcp.js';
import { createTestNetwork, joinRoom } from '../vendor/p2p-core/p2p-core.js';

test('a live board syncs multiple guests, rejects stale edits, and closes', async () => {
  const network = createTestNetwork();
  const makeProject = label => ({ version: 1, source: `flowchart TD\n    A["${label}"]`, positions: { A: [0, 0] } });
  let hostEditing = false;
  let guestEditing = false;
  function connect(host) {
    let project = makeProject(host ? 'Host board' : 'Waiting');
    let commits = 0;
    let ended = false;
    let presence;
    let counts;
    const room = joinRoom({ app: 'mini-flow-live-test', room: 'room', password: 'private', network,
      protocol: 2, maxPeers: host ? 8 : 1, profile: { role: host ? 'host' : 'editor' },
      acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host'),
      kinds: ['read', 'state', 'edit', 'end', 'presence', 'agent', 'ask'] });
    const getProject = () => structuredClone(project);
    const setProject = next => {
      project = structuredClone(next);
      commits++;
      session.changed();
    };
    const session = createLiveSession({ room, host, getProject, setProject, normalize: next => {
      if (next.version !== 1) throw new Error('Invalid project');
      return structuredClone(next);
    }, canAccept: () => host ? !hostEditing : !guestEditing, onStatus() {}, onEnd() { ended = true; },
    onPresence(value) { presence = value; }, onGuestCounts(value) { counts = value; },
    readNote: (_, id) => id === 'N1' ? { id, text: 'Review this step', target: { type: 'node', id: 'A' } } : null });
    return { id: room.selfId, session, getProject, setProject, commits: () => commits, ended: () => ended, presence: () => presence, counts: () => counts };
  }

  const host = connect(true);
  const guest = connect(false);
  const secondGuest = connect(false);
  try {
    await network.settle();
    assert.equal(guest.session.ready(), true);
    assert.deepEqual(guest.getProject(), host.getProject());
    assert.equal(secondGuest.session.ready(), true);
    assert.deepEqual(secondGuest.getProject(), host.getProject());

    const tools = new Map();
    await registerMiniFlowTools(guest, MiniFlow, { registerTool: tool => tools.set(tool.name, tool.execute) }, {
      tabId: 'guest', isReady: guest.session.ready, commitProject: guest.session.submit,
      registerAgent: guest.session.registerAgent, waitForAIRequest: guest.session.waitForAIRequest
    });
    assert.deepEqual(host.counts(), { human: 2, ai: 0 });
    assert.deepEqual(await tools.get('register_live_agent')({}), { ok: true });
    await network.settle();
    assert.deepEqual(host.counts(), { human: 1, ai: 1 });
    assert.deepEqual(secondGuest.counts(), host.counts());
    const wait = tools.get('wait_for_ai_request');
    const listening = wait({ timeoutMs: 1000 });
    assert.deepEqual(await host.session.askAI('N1'), { ok: true });
    const first = await listening;
    assert.equal(first.request.requester, 'Host');
    assert.deepEqual(first.request.note, { id: 'N1', text: 'Review this step', target: { type: 'node', id: 'A' } });
    assert.equal((await secondGuest.session.waitForAIRequest()).reason, 'ai_not_connected');
    assert.deepEqual(await secondGuest.session.askAI('N1'), { ok: true });
    const next = await wait({ after: first.request.sequence, timeoutMs: 1000 });
    assert.equal(next.request.requester, 'Guest 2');
    assert.deepEqual(await wait({ after: next.request.sequence, timeoutMs: 0 }), { ok: true, request: null });
    assert.equal((await host.session.askAI('missing')).reason, 'note_missing');
    const getBoard = tools.get('get_board');
    const edit = tools.get('apply_board_edit');
    const { revision } = await getBoard();
    const result = await edit({ revision, edits: [{ op: 'rename_node', id: 'A', label: 'Agent edit' }], message: 'Rename A' });
    assert.equal(result.ok, true);
    assert.deepEqual(host.getProject(), makeProject('Agent edit'));
    assert.deepEqual(host.getProject(), guest.getProject());
    await network.settle();
    assert.deepEqual(host.getProject(), secondGuest.getProject());
    assert.equal(host.commits(), 1);

    guest.setProject(makeProject('Human guest edit'));
    await new Promise(resolve => setTimeout(resolve, 40));
    await network.settle();
    assert.deepEqual(host.getProject(), makeProject('Human guest edit'));
    assert.deepEqual(secondGuest.getProject(), host.getProject());
    assert.equal(host.commits(), 2);

    const concurrent = await Promise.all([
      guest.session.submit(makeProject('First guest edit'), 'First'),
      secondGuest.session.submit(makeProject('Second guest edit'), 'Second')
    ]);
    assert.equal(concurrent.filter(result => result.ok).length, 1);
    assert.equal(concurrent.filter(result => result.reason === 'revision_conflict').length, 1);
    await network.settle();
    assert.deepEqual(guest.getProject(), host.getProject());
    assert.deepEqual(secondGuest.getProject(), host.getProject());

    guestEditing = true;
    guest.setProject(makeProject('Unfinished guest edit'));
    host.setProject(makeProject('Newer host edit'));
    await network.settle();
    assert.deepEqual(guest.getProject(), makeProject('Unfinished guest edit'));
    guestEditing = false;
    await new Promise(resolve => setTimeout(resolve, 40));
    await network.settle();
    assert.deepEqual(host.getProject(), makeProject('Newer host edit'));
    assert.deepEqual(guest.getProject(), host.getProject());

    host.session.updatePresence({ point: [25, -10], focus: 'A' });
    const laser = [[1, 8, 30, true], [2, 12, 34, false]];
    guest.session.updatePresence({ point: [12, 34], focus: 'A', laser: [...laser, ['invalid']] });
    secondGuest.session.updatePresence({ point: [-20, 31], focus: 'A' });
    await new Promise(resolve => setTimeout(resolve, 115));
    await network.settle();
    assert.deepEqual(guest.presence().find(peer => peer.id === host.id), { id: host.id, point: [25, -10], focus: 'A', label: 'Host' });
    assert.deepEqual(secondGuest.presence().find(peer => peer.id === guest.id)?.point, [12, 34]);
    assert.deepEqual(secondGuest.presence().find(peer => peer.id === guest.id)?.laser, laser);
    assert.deepEqual(host.presence().find(peer => peer.id === guest.id)?.laser, laser);
    assert.deepEqual(host.presence().find(peer => peer.id === secondGuest.id)?.point, [-20, 31]);
    assert.equal(guest.presence().some(peer => peer.id === guest.id), false);
    secondGuest.session.stop();
    await network.settle();
    assert.equal(guest.presence().some(peer => peer.id === secondGuest.id), false);
    assert.deepEqual(host.counts(), { human: 0, ai: 1 });

    const stale = guest.session.submit(makeProject('Stale edit'), 'Stale');
    host.setProject(makeProject('Host edit'));
    assert.equal((await stale).reason, 'revision_conflict');
    assert.deepEqual(guest.getProject(), makeProject('Host edit'));

    hostEditing = true;
    assert.equal((await guest.session.submit(makeProject('During drag'), 'Drag')).reason, 'host_editing');
    hostEditing = false;
    const beforeDelete = await getBoard();
    const deleted = await edit({ revision: beforeDelete.revision, edits: [{ op: 'delete_node', id: 'A' }], message: 'Delete A' });
    assert.equal(deleted.ok, true);
    assert.deepEqual(host.getProject().positions, {});

    const waitingWhenClosed = wait({ after: next.request.sequence, timeoutMs: 1000 });
    host.session.stop();
    await network.settle();
    assert.equal((await waitingWhenClosed).reason, 'live_disconnected');
    assert.equal(guest.ended(), true);
    assert.deepEqual(guest.presence(), []);
    assert.equal((await getBoard()).reason, 'live_not_ready');
  } finally {
    host.session.stop();
    guest.session.stop();
    secondGuest.session.stop();
  }
});
