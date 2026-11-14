import assert from 'node:assert/strict';
import test from 'node:test';
import '../mini-flow.js';
import { createLiveSession, liveInviteHash, newLiveInvite, readLiveInvite } from '../mini-flow-live.js';
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
    let colors = {};
    let requests = {};
    const threads = new Map();
    const ai = { calls: [], result: { ok: true } };
    const room = joinRoom({ app: 'mini-flow-live-test', room: 'room', password: 'private', network,
      protocol: 3, maxPeers: host ? 8 : 1, profile: { role: host ? 'host' : 'editor' },
      acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host'),
      kinds: ['read', 'state', 'edit', 'end', 'presence', 'ask'] });
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
    readNote: (_, id) => ['N1', 'N2', 'N3'].includes(id) ? { id, text: 'Review this step', target: { type: 'node', id: 'A' } } : null,
    noteIds: value => MiniFlow.parse(value.source).nodes.filter(node => node.type === 'note').map(node => node.id),
    onNoteColors(value) { colors = value; }, onAIRequests(value) { requests = value; },
    onAIRequest: host ? async request => { ai.calls.push(request); return ai.result; } : undefined,
    onAIThread(id, messages) {
      if (messages) threads.set(id, messages);
      else threads.delete(id);
    } });
    return { id: room.selfId, session, getProject, setProject, commits: () => commits, ended: () => ended, ai,
      threads, presence: () => presence, counts: () => counts, colors: () => colors, requests: () => requests };
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
      tabId: 'guest', isReady: guest.session.ready, commitProject: guest.session.submit
    });
    assert.deepEqual([...tools.keys()].sort(), ['apply_board_edit', 'get_board']);
    assert.deepEqual(host.counts(), { human: 2 });
    assert.deepEqual(await secondGuest.session.comment('N1', 'A comment before anyone asked AI'), { ok: true });
    const [guestComment] = host.threads.get('N1');
    assert.equal(guestComment.author, 'Guest 2');
    assert.match(guestComment.owner, /^[a-f0-9]{32}$/);
    assert.notEqual(guestComment.owner, secondGuest.id);
    assert.equal(secondGuest.session.canManageReply(guestComment), true);
    assert.equal(guest.session.canManageReply(guestComment), false);
    assert.match(guestComment.replyId, /^[a-f0-9]{32}$/);
    const change = { replyId: guestComment.replyId, previousText: guestComment.text, text: 'Corrected guest comment' };
    assert.equal((await guest.session.manageReply('N1', change)).reason, 'reply_forbidden');
    assert.deepEqual(await secondGuest.session.manageReply('N1', change), { ok: true });
    assert.equal((await host.session.manageReply('N1', change)).reason, 'reply_changed');

    // A guest's Ask AI reaches the host, which hands it to agent-room.
    assert.deepEqual(await secondGuest.session.askAI('N1', 'What changed?'), { ok: true });
    const [request] = host.ai.calls;
    assert.equal(request.noteId, 'N1');
    assert.equal(request.requester, 'Guest 2');
    assert.equal(request.prompt, 'What changed?');
    assert.deepEqual(request.note, { id: 'N1', text: 'What changed?', target: { type: 'node', id: 'A' } });
    assert.equal(request.thread[0].text, 'Corrected guest comment');
    assert.equal(host.threads.get('N1').at(-1).text, 'What changed?');
    // Asking again without a prompt reuses the latest question and adds no message.
    assert.deepEqual(await host.session.askAI('N1'), { ok: true });
    assert.equal(host.ai.calls[1].prompt, 'What changed?');
    assert.equal(host.ai.calls[1].requester, 'Host');
    assert.equal(host.threads.get('N1').length, 2);
    // A refused hand-off leaves the conversation unchanged.
    host.ai.result = { ok: false, reason: 'no_agents', message: 'No agents are in the agent-room yet.' };
    assert.equal((await guest.session.askAI('N1', 'Anyone there?')).reason, 'no_agents');
    host.ai.result = undefined;
    assert.equal((await guest.session.askAI('N1', 'Anyone there?')).reason, 'ai_unavailable');
    assert.equal(host.threads.get('N1').length, 2);
    host.ai.result = { ok: true };
    assert.equal((await host.session.askAI('missing')).reason, 'note_missing');
    assert.equal(host.ai.calls.length, 4);

    // The host publishes request status and agent replies to every guest.
    host.session.setAIRequests({ N1: { phase: 'working', label: 'Claude' } });
    await network.settle();
    assert.deepEqual(secondGuest.requests().N1, { phase: 'working', label: 'Claude' });
    assert.deepEqual(host.requests().N1, secondGuest.requests().N1);
    assert.equal(host.session.appendAIMessage('N1', { role: 'assistant', author: 'Claude', text: 'Renamed the step.' }), true);
    assert.equal(host.session.appendAIMessage('missing', { role: 'assistant', author: 'Claude', text: 'Lost' }), false);
    host.session.setAIRequests({ N1: { phase: 'result', label: 'Renamed the step.', author: 'Claude' } });
    await network.settle();
    assert.equal(secondGuest.threads.get('N1').at(-1).text, 'Renamed the step.');
    assert.deepEqual(guest.threads.get('N1'), host.threads.get('N1'));
    assert.equal(guest.requests().N1.phase, 'result');
    guest.session.setAIRequests?.({ N1: { phase: 'waiting', label: 'Forged' } });
    await network.settle();
    assert.equal(secondGuest.requests().N1.phase, 'result');
    const getBoard = tools.get('get_board');
    const edit = tools.get('apply_board_edit');
    const commitsBeforeEdit = host.commits();
    const { revision } = await getBoard();
    const result = await edit({ revision, edits: [{ op: 'rename_node', id: 'A', label: 'Agent edit' }], message: 'Rename A' });
    assert.equal(result.ok, true);
    assert.deepEqual(host.getProject(), makeProject('Agent edit'));
    assert.deepEqual(host.getProject(), guest.getProject());
    await network.settle();
    assert.deepEqual(host.getProject(), secondGuest.getProject());
    assert.equal(host.commits(), commitsBeforeEdit + 1);

    guest.setProject(makeProject('Human guest edit'));
    await new Promise(resolve => setTimeout(resolve, 40));
    await network.settle();
    assert.deepEqual(host.getProject(), makeProject('Human guest edit'));
    assert.deepEqual(secondGuest.getProject(), host.getProject());
    assert.equal(host.commits(), commitsBeforeEdit + 2);

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
    assert.equal(secondGuest.presence().find(peer => peer.id === guest.id)?.color, 1);
    assert.deepEqual(secondGuest.presence().find(peer => peer.id === guest.id)?.laser, laser);
    assert.deepEqual(host.presence().find(peer => peer.id === guest.id)?.laser, laser);
    assert.deepEqual(host.presence().find(peer => peer.id === secondGuest.id)?.point, [-20, 31]);
    assert.equal(guest.presence().some(peer => peer.id === guest.id), false);
    secondGuest.session.stop();
    await network.settle();
    assert.equal(guest.presence().some(peer => peer.id === secondGuest.id), false);
    assert.deepEqual(host.counts(), { human: 1 });
    const storedReply = host.threads.get('N1')[0];
    const hostChange = { replyId: storedReply.replyId, previousText: storedReply.text, text: 'Edited after the guest left' };
    assert.deepEqual(await host.session.manageReply('N1', hostChange), { ok: true });
    await network.settle();
    assert.deepEqual(guest.threads.get('N1')[0], { ...storedReply, text: hostChange.text, edited: 'host' });
    assert.deepEqual(await host.session.manageReply('N1', { ...hostChange, previousText: hostChange.text, text: null }), { ok: true });
    await network.settle();
    assert.equal(guest.threads.get('N1').some(message => message.replyId === storedReply.replyId), false);


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
    const beforeNotes = await getBoard();
    const notes = await edit({ revision: beforeNotes.revision, edits: [
      { op: 'add_node', id: 'AI_NOTE', type: 'note', label: 'AI note', position: [12, 34] }
    ], message: 'Add note' });
    assert.equal(notes.ok, true);
    assert.equal(host.colors().AI_NOTE, 1);
    assert.deepEqual(host.colors(), guest.colors());
    guest.session.updatePresence({ point: [12, 34], focus: 'AI_NOTE', tool: 'note',
      draft: { id: 'AI_NOTE', type: 'note', text: 'Typing live', position: [14, 35] } });
    await new Promise(resolve => setTimeout(resolve, 125));
    await network.settle();
    const preview = host.presence().find(peer => peer.id === guest.id);
    assert.equal(preview.color, host.colors().AI_NOTE);
    assert.equal(preview.tool, 'note');
    assert.equal(preview.draft.text, 'Typing live');
    assert.deepEqual(host.getProject().positions.AI_NOTE, [12, 34]);

    host.session.stop();
    await network.settle();
    assert.equal(guest.ended(), true);
    assert.deepEqual(host.colors(), {});
    assert.deepEqual(guest.colors(), {});
    assert.deepEqual(guest.presence(), []);
    assert.equal((await getBoard()).reason, 'live_not_ready');
  } finally {
    host.session.stop();
    guest.session.stop();
    secondGuest.session.stop();
  }
});

test('reopens the room with its conversations after a host reload', { timeout: 10000 }, async () => {
  const { deriveRoomKey, secureRoom } = await import('../mini-flow-secure-room.js');
  const network = createTestNetwork();
  const invite = { room: 'recover', password: 'private-room-key' };
  const key = await deriveRoomKey(invite);
  const diagram = (label = 'Initial', ids = ['N1', 'N2']) => ({
    version: 1,
    source: `flowchart TD\n    %% mini-flow ${JSON.stringify({ notes: ids.map(id => ({ id, label })), bends: [] })}`,
    positions: Object.fromEntries(ids.map((id, index) => [id, [index * 200, 0]]))
  });
  let snapshot;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function open(host, restored) {
    let project = restored?.project ?? diagram();
    let requests = {};
    const threads = new Map();
    const room = secureRoom(joinRoom({ app: 'mini-flow-live-recovery-test', ...invite, network, protocol: 5,
      kinds: ['read', 'state', 'edit', 'end', 'presence', 'ask'],
      profile: { role: host ? 'host' : 'editor' },
      acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host') }), key);
    const session = createLiveSession({ room, host, getProject: () => project, setProject: next => { project = next; },
      normalize: structuredClone, canAccept: () => true, onStatus() {}, onEnd() {},
      noteIds: value => Object.keys(value.positions),
      readNote: (value, id) => Object.hasOwn(value.positions, id) ? { id, text: 'Review ' + id, target: null } : null,
      initialThreads: restored?.threads,
      onAIRequests: next => { requests = next; },
      onAIThread: (id, messages) => messages ? threads.set(id, messages) : threads.delete(id),
      onCheckpoint: next => { snapshot = structuredClone(next); },
      onAIRequest: host ? async () => ({ ok: true }) : undefined
    });
    return { session, threads, requests: () => requests,
      project: () => project, setProject(next) { project = next; session.changed(); } };
  }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) {
      await network.settle();
      if (predicate()) return;
      await pause(10);
    }
    assert.fail('Live state did not converge');
  }

  let host = open(true);
  const guest = open(false);
  try {
    await until(() => guest.session.ready());
    for (let i = 0; i < 18; i++) assert.equal((await host.session.comment('N1', 'Comment ' + i)).ok, true);
    await until(() => guest.threads.get('N1')?.length === 18);
    // Deleting a note hides its conversation; undoing the deletion brings it back.
    host.setProject(diagram('Initial', ['N2']));
    await until(() => !guest.threads.has('N1'));
    host.setProject(diagram());
    await until(() => guest.threads.get('N1')?.length === 18);

    assert.deepEqual(await guest.session.askAI('N2', 'Summarise this'), { ok: true });
    host.session.setAIRequests({ N2: { phase: 'waiting', label: 'Waiting for Claude' } });
    await until(() => guest.requests().N2?.phase === 'waiting');
    assert.equal(guest.session.submit(diagram('Guest edit'), 'Guest edit') instanceof Promise, true);
    await until(() => JSON.stringify(host.project()) === JSON.stringify(diagram('Guest edit')));

    host.session.suspend();
    await until(() => !guest.session.ready());
    assert.deepEqual(guest.requests(), {});
    assert.deepEqual(Object.keys(snapshot), ['project', 'threads']);
    host = open(true, snapshot);
    await until(() => guest.session.ready());
    assert.deepEqual(guest.project(), diagram('Guest edit'));
    await until(() => guest.threads.get('N1')?.length === 18 && guest.threads.get('N2')?.at(-1).text === 'Summarise this');
    host.session.setAIRequests({ N2: { phase: 'result', label: 'Done', author: 'Claude' } });
    await until(() => guest.requests().N2?.phase === 'result');
    host.session.stop();
    await until(() => !guest.session.ready());
  } finally {
    host.session.stop();
    guest.session.stop();
  }
});

test('encrypts payloads, binds the sender and kind, and rejects replay', async () => {
  const { deriveRoomKey, secureRoom } = await import('../mini-flow-secure-room.js');
  const key = await deriveRoomKey({ room: 'test', password: 'test secret' });
  const callbacks = new Map();
  let sent;
  const sender = secureRoom({ selfId: 'host', send(_kind, packet) { sent = packet; } }, key);
  const receiver = secureRoom({ selfId: 'guest', peer: () => true,
    onMessage(kind, callback) { callbacks.set(kind, callback); } }, key);
  const accepted = [];
  receiver.onMessage('state', value => accepted.push(value));
  receiver.onMessage('edit', value => accepted.push(value));
  const board = { source: 'Confidential board' };
  await sender.send('state', board, 'guest');
  assert.equal(JSON.stringify(sent).includes(board.source), false);
  callbacks.get('edit')(sent, 'host');
  callbacks.get('state')(sent, 'impostor');
  callbacks.get('state')(sent, 'host');
  callbacks.get('state')(sent, 'host');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(accepted, [board]);
});

test('live invites carry custom relay settings and accept older invite links', () => {
  const legacy = newLiveInvite();
  assert.deepEqual(readLiveInvite(liveInviteHash(legacy)), legacy);
  const custom = newLiveInvite('https://relay.example.org/private/ws');
  assert.equal(custom.relay, 'wss://relay.example.org/private/ws');
  assert.deepEqual(readLiveInvite(liveInviteHash(custom)), custom);
  assert.equal(readLiveInvite(liveInviteHash({ ...legacy, relay: 'ws://relay.example.org' })), null);
  assert.throws(() => newLiveInvite('wss://alice:secret@relay.example.org'));
});

test('only the invite host can prove its identity and sign board messages', async () => {
  const { createHostKey, deriveRoomKey, hostSigner, secureRoom, verifyHostProfile } = await import('../mini-flow-secure-room.js');
  const { withHostKey } = await import('../mini-flow-live.js');
  const invite = await withHostKey(newLiveInvite());
  const shared = readLiveInvite(liveInviteHash(invite));
  assert.equal(shared.host, invite.host);
  assert.equal(liveInviteHash(invite).includes(invite.hostKey.d), false);

  const signer = await hostSigner(invite.hostKey, invite.room, 'host');
  assert.ok(await verifyHostProfile(signer.profile, invite.host, invite.room, 'host'));
  assert.equal(await verifyHostProfile(signer.profile, invite.host, invite.room, 'impostor'), null);
  const impostorKey = await createHostKey();
  const impostor = await hostSigner(impostorKey.hostKey, invite.room, 'host');
  assert.equal(await verifyHostProfile(impostor.profile, invite.host, invite.room, 'host'), null);
  assert.equal(await verifyHostProfile({ ...impostor.profile, hostKey: signer.profile.hostKey }, invite.host, invite.room, 'host'), null);

  const verified = await verifyHostProfile(signer.profile, invite.host, invite.room, 'host');
  const key = await deriveRoomKey(invite);
  async function deliver(signKey) {
    let sent;
    const callbacks = new Map();
    const sender = secureRoom({ selfId: 'host', send(_kind, packet) { sent = packet; } }, key, { signKey });
    const receiver = secureRoom({ selfId: 'guest', peer: () => true,
      onMessage(kind, callback) { callbacks.set(kind, callback); } }, key,
      { verifyKey: from => from === 'host' ? verified : false });
    const accepted = [];
    receiver.onMessage('state', value => accepted.push(value));
    await sender.send('state', { source: 'board' }, 'guest');
    callbacks.get('state')(sent, 'host');
    await new Promise(resolve => setTimeout(resolve, 40));
    return accepted;
  }
  assert.deepEqual(await deliver(signer.key), [{ source: 'board' }]);
  assert.deepEqual(await deliver(impostor.key), []);
  assert.deepEqual(await deliver(undefined), []);
});
