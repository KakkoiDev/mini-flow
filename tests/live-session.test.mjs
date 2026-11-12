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
    let colors = {};
    let requests = {};
    const threads = new Map();
    const room = joinRoom({ app: 'mini-flow-live-test', room: 'room', password: 'private', network,
      protocol: 3, maxPeers: host ? 8 : 1, profile: { role: host ? 'host' : 'editor' },
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
    readNote: (_, id) => ['N1', 'N2', 'N3'].includes(id) ? { id, text: 'Review this step', target: { type: 'node', id: 'A' } } : null,
    noteIds: value => MiniFlow.parse(value.source).nodes.filter(node => node.type === 'note').map(node => node.id),
    onNoteColors(value) { colors = value; }, onAIRequests(value) { requests = value; },
    onAIThread(id, messages) {
      if (messages) threads.set(id, messages);
      else threads.delete(id);
    } });
    return { id: room.selfId, session, getProject, setProject, commits: () => commits, ended: () => ended,
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
      tabId: 'guest', isReady: guest.session.ready, commitProject: guest.session.submitAIEdit,
      registerAgent: guest.session.registerAgent, waitForAIRequest: guest.session.waitForAIRequest
    });
    assert.deepEqual(host.counts(), { human: 2, ai: 0 });
    assert.deepEqual(await secondGuest.session.comment('N1', 'A comment before any AI joined'), { ok: true });
    const [guestComment] = host.threads.get('N1');
    assert.equal(guestComment.author, 'Guest 2');
    assert.equal(guestComment.owner, secondGuest.id);
    assert.match(guestComment.replyId, /^[a-f0-9]{32}$/);
    assert.deepEqual(await host.session.askAI('N1'), { ok: true });
    assert.equal(host.requests().N1.phase, 'waiting');
    assert.deepEqual(await tools.get('register_live_agent')({}), { ok: true });
    await network.settle();
    assert.deepEqual(host.counts(), { human: 1, ai: 1 });
    assert.deepEqual(secondGuest.counts(), host.counts());
    const wait = tools.get('wait_for_ai_request');
    const listening = wait({ timeoutMs: 1000 });
    const first = await listening;
    assert.equal(host.requests().N1.phase, 'working');
    assert.equal(first.request.requester, 'Host');
    assert.deepEqual(first.request.note, { id: 'N1', text: 'A comment before any AI joined', target: { type: 'node', id: 'A' } });
    assert.deepEqual(first.request.thread, host.threads.get('N1'));
    const change = { replyId: guestComment.replyId, previousText: guestComment.text, text: 'Corrected guest comment' };
    assert.equal((await guest.session.manageReply('N1', change)).reason, 'reply_forbidden');
    assert.deepEqual(await secondGuest.session.manageReply('N1', change), { ok: true });
    assert.equal((await host.session.manageReply('N1', change)).reason, 'reply_changed');
    assert.equal(first.request.thread[0].text, guestComment.text);
    assert.equal((await secondGuest.session.waitForAIRequest()).reason, 'ai_not_connected');
    assert.equal((await host.session.askAI('N1')).reason, 'already_requested');
    assert.deepEqual(await host.session.askAI('N2'), { ok: true });
    assert.deepEqual(await host.session.askAI('N3'), { ok: true });
    await network.settle();
    assert.deepEqual(await wait({ after: first.request.sequence, timeoutMs: 0 }), { ok: true, request: null });
    assert.equal(host.session.cancelAIRequest('N2'), true);
    assert.equal(host.requests().N2.label, 'AI request cancelled');
    assert.deepEqual(guest.session.reportAIActivity('Building in batches'), { ok: true });
    assert.equal((await guest.session.submitAIEdit(makeProject('First batch'), 'First batch')).ok, true);
    assert.deepEqual(host.getProject(), makeProject('First batch'));
    assert.equal((await host.session.askAI('N1')).reason, 'already_requested');
    assert.equal((await guest.session.submitAIEdit(makeProject('Second batch'), 'Second batch')).ok, true);
    await network.settle();
    assert.deepEqual(secondGuest.getProject(), makeProject('Second batch'));
    guest.session.reportAIActivity('', 'Two batches added');
    await network.settle();
    assert.deepEqual(host.requests().N1, { phase: 'result', label: 'Two batches added', author: 'AI 1' });
    assert.deepEqual(secondGuest.requests().N1, host.requests().N1);
    assert.deepEqual(await secondGuest.session.askAI('N1', 'What changed?'), { ok: true });
    const queued = await wait({ after: first.request.sequence, timeoutMs: 1000 });
    assert.equal(queued.request.note.id, 'N3');
    assert.equal(host.session.cancelAIRequest('N3'), true);
    // Attempt an edit immediately, before the guest receives the cancellation.
    assert.equal((await guest.session.submitAIEdit(makeProject('Cancelled edit'), 'Late edit')).reason, 'ai_request_cancelled');
    await network.settle();
    assert.equal(guest.session.reportAIActivity('', 'Late reply').reason, 'ai_request_cancelled');
    assert.deepEqual(host.getProject(), makeProject('Second batch'));
    assert.equal(host.requests().N3.label, 'AI request cancelled');
    const next = await wait({ after: queued.request.sequence, timeoutMs: 1000 });
    assert.equal(next.request.requester, 'Guest 2');
    assert.equal(next.request.note.text, 'What changed?');
    assert.deepEqual(next.request.thread[0], { ...guestComment, text: 'Corrected guest comment', edited: 'author' });
    assert.equal(next.request.thread[1].author, 'AI 1');
    assert.equal(next.request.thread[1].text, 'Two batches added');
    assert.deepEqual(await wait({ after: next.request.sequence, timeoutMs: 0 }), { ok: true, request: null });
    assert.equal((await host.session.askAI('missing')).reason, 'note_missing');
    const fullReply = 'Here are the changes. '.repeat(16).trim();
    assert.deepEqual(guest.session.reportAIActivity('', fullReply), { ok: true });
    await network.settle();
    assert.equal(host.requests().N1.label, fullReply.slice(0, 200));
    assert.equal(host.threads.get('N1').at(-1).text, fullReply);
    assert.deepEqual(secondGuest.threads.get('N1'), host.threads.get('N1'));
    assert.deepEqual(await secondGuest.session.registerAgent(), { ok: true });
    const competing = [
      wait({ after: next.request.sequence, timeoutMs: 1000 }),
      secondGuest.session.waitForAIRequest(0, 1000)
    ];
    assert.deepEqual(await host.session.askAI('N1'), { ok: true });
    assert.equal((await Promise.all(competing)).filter(result => result.request).length, 1);
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
    assert.deepEqual(host.counts(), { human: 0, ai: 1 });
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
    guest.session.reportAIActivity('Drafting an example');
    guest.session.updatePresence({ point: [12, 34], focus: 'AI_NOTE', tool: 'note',
      draft: { id: 'AI_NOTE', type: 'note', text: 'Typing live', position: [14, 35] } });
    await new Promise(resolve => setTimeout(resolve, 125));
    await network.settle();
    const preview = host.presence().find(peer => peer.id === guest.id);
    assert.equal(preview.activity, 'Drafting an example');
    assert.equal(preview.color, host.colors().AI_NOTE);
    assert.equal(preview.tool, 'note');
    assert.equal(preview.draft.text, 'Typing live');
    assert.deepEqual(host.getProject().positions.AI_NOTE, [12, 34]);

    const waitingWhenClosed = wait({ after: next.request.sequence, timeoutMs: 1000 });
    host.session.stop();
    await network.settle();
    assert.equal((await waitingWhenClosed).reason, 'live_disconnected');
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
