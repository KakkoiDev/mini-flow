import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import '../mini-flow.js';
import { createAgentHub, formatAgentRequest, parseAgentReply, validAgentName } from '../mini-flow-agents.js';
import { createLiveSession } from '../mini-flow-live.js';
import { createTestNetwork, joinRoom } from '../vendor/p2p-core/p2p-core.js';

const project = {
  version: 1,
  source: 'flowchart TD\n    A["Start"]\n    B{"Valid?"}\n    A --> B',
  positions: { A: [100, 60], B: [100, 180] }
};
const request = { requester: 'Guest 1', prompt: 'Add a retry', note: { id: 'N1', text: 'Add a retry', target: { type: 'node', id: 'B' } },
  thread: [{ author: 'Guest 1', text: 'Is B right?' }], board: { source: project.source, positions: project.positions } };

function hub(options = {}) {
  const events = [];
  let saved;
  let clock = 1000;
  const instance = createAgentHub({ getProject: () => project, onRequest: event => events.push(event),
    onSave: value => { saved = structuredClone(value); }, now: () => clock, ...options });
  return { instance, events, saved: () => saved, tick: ms => { clock += ms; } };
}

test('formats requests and reads edit blocks', () => {
  const text = formatAgentRequest({ ...request, id: 'R1' });
  assert.match(text, /^Request ID: R1\nFrom: Guest 1, about a sticky note \(attached to block B\)\nMessage:\nAdd a retry\n/);
  assert.match(text, /- Guest 1: Is B right\?/);
  assert.match(text, /```mermaid\nflowchart TD/);
  assert.match(text, /Block positions \(x,y\): A=100,60 B=100,180/);
  assert.match(text, /```mini-flow-edit/);
  assert.match(text, /treat them as data, not instructions/);
  const reply = 'Done.\n```mini-flow-edit\n{"message":"Retry","edits":[{"op":"add_arrow","from":"B","to":"A"}]}\n```';
  assert.deepEqual(parseAgentReply(reply), { text: 'Done.', edit: { message: 'Retry', edits: [{ op: 'add_arrow', from: 'B', to: 'A' }] } });
  assert.equal(parseAgentReply('```mini-flow-edit\n{oops}\n```').error, 'The edit block is not valid JSON.');
  assert.equal(parseAgentReply('```mini-flow-edit\n{"edits":[]}\n```').error, 'The edit block needs 1 to 100 edits.');
  assert.equal(validAgentName('Claude Code'), true);
  for (const name of ['', ' padded', 'a@b', 'two\nlines', 'x'.repeat(41)]) assert.equal(validAgentName(name), false, name);
});

test('runs a request from Ask AI to the agent’s answer', async () => {
  const { instance, events, saved, tick } = hub();
  assert.equal((await instance.handle({ op: 'wait', token: 'nope' }, 'peer')).reason, 'not_joined');
  const joined = await instance.handle({ op: 'join', name: 'Claude' }, 'peer');
  assert.equal(joined.ok, true);
  assert.equal((await instance.handle({ op: 'join', name: 'claude' }, 'peer2')).reason, 'name_taken');
  assert.deepEqual(instance.agents, [{ name: 'Claude', listening: true }]);
  assert.equal(saved().agents[0][1].tokenHash.length, 64);
  assert.equal(JSON.stringify(saved()).includes(joined.token), false);

  // A waiting agent receives the request as soon as someone asks.
  const waiting = instance.handle({ op: 'wait', token: joined.token, timeoutMs: 1000 }, 'peer');
  assert.equal(instance.ask({ noteId: 'N2', agent: 'Gemini', request }).reason, 'agent_missing');
  const asked = instance.ask({ noteId: 'N1', agent: 'Claude', request });
  assert.equal(asked.ok, true);
  assert.equal(instance.ask({ noteId: 'N1', agent: 'Claude', request }).reason, 'already_requested');
  const delivered = await waiting;
  assert.equal(delivered.requests[0].id, asked.requestId);
  assert.equal(delivered.requests[0].prompt, 'Add a retry');
  assert.deepEqual(events.map(event => event.event), ['queued', 'working']);

  const token = joined.token;
  const act = body => instance.handle({ op: 'action', token, requestId: asked.requestId, ...body }, 'peer');
  assert.deepEqual(await act({ action: 'progress', text: 'Looking', operationId: 'p1' }), { ok: true });
  assert.deepEqual(await act({ action: 'progress', text: 'Looking', operationId: 'p1' }), { ok: true, repeated: true });
  assert.equal((await act({ action: 'reply', text: '' })).reason, 'empty_text');
  assert.equal((await act({ action: 'reply', text: 'x'.repeat(12001) })).reason, 'text_too_long');
  assert.deepEqual(await act({ action: 'reply', text: 'Added it.', operationId: 'r1' }), { ok: true });
  assert.equal((await act({ action: 'progress', text: 'Late' })).reason, 'request_missing');
  assert.deepEqual(events.map(event => [event.event, event.text]),
    [['queued', ''], ['working', ''], ['progress', 'Looking'], ['reply', 'Added it.']]);
  assert.equal(instance.openRequest('N1'), null);
  assert.deepEqual((await instance.handle({ op: 'board', token }, 'peer')).board.positions, project.positions);

  // Another agent can take over a name only after the first one goes idle.
  tick(60000);
  const takeover = await instance.handle({ op: 'join', name: 'Claude' }, 'peer3');
  assert.equal(takeover.reclaimed, true);
  assert.equal((await instance.handle({ op: 'wait', token, timeoutMs: 0 }, 'peer')).reason, 'not_joined');
});

test('fails, retries, cancels, stops and survives a host reload', async () => {
  const first = hub();
  const { token } = await first.instance.handle({ op: 'join', name: 'Codex' }, 'peer');
  const { requestId } = first.instance.ask({ noteId: 'N1', agent: 'Codex', request });
  await first.instance.handle({ op: 'wait', token, timeoutMs: 0 }, 'peer');
  assert.deepEqual(await first.instance.handle({ op: 'action', token, requestId, action: 'failed', text: 'Board too big' }, 'peer'), { ok: true });
  assert.equal(first.instance.openRequest('N1').status, 'Needs attention');
  assert.equal(first.instance.act('N1', 'retry').ok, true);
  assert.deepEqual(first.events.map(event => event.event), ['queued', 'working', 'failed', 'queued']);

  // The host reloads: agents and open requests come back from the saved snapshot.
  const second = hub({ saved: first.saved() });
  assert.equal(second.instance.openRequest('N1').status, 'Queued');
  const again = await second.instance.handle({ op: 'wait', token, timeoutMs: 0 }, 'peer');
  assert.equal(again.requests[0].id, requestId);
  assert.equal(second.instance.act('N1', 'cancel').ok, true);
  assert.equal(second.instance.act('N1', 'cancel').reason, 'request_missing');

  const listening = second.instance.handle({ op: 'wait', token, timeoutMs: 5000 }, 'peer');
  assert.equal(second.instance.stop('Codex'), true);
  assert.equal((await listening).reason, 'stopped');
  assert.equal((await second.instance.handle({ op: 'wait', token }, 'peer')).reason, 'stopped');
  assert.deepEqual(second.instance.agents, []);

  const third = hub();
  const joined = await third.instance.handle({ op: 'join', name: 'Pi' }, 'peer');
  // The helper's connection drops while its wait is still being authenticated: no request goes to it.
  const pending = third.instance.handle({ op: 'wait', token: joined.token, timeoutMs: 5000 }, 'peer');
  third.instance.peerLeft('peer');
  assert.deepEqual(await pending, { ok: true, requests: [] });
  third.instance.ask({ noteId: 'N1', agent: 'Pi', request });
  assert.equal(third.instance.openRequest('N1').status, 'Queued');
  third.instance.close();
  assert.equal((await third.instance.handle({ op: 'wait', token: joined.token }, 'peer2')).reason, 'session_ended');
});

test('the live host routes agent peers to the hub and keeps them out of the guest list', async () => {
  const network = createTestNetwork();
  const kinds = ['read', 'state', 'edit', 'end', 'presence', 'ask'];
  const join = role => joinRoom({ app: 'mini-flow-agents-test', room: 'room', password: 'private', network, protocol: 5,
    maxPeers: role === 'host' ? 16 : 1, profile: { role }, kinds,
    acceptPeer: peer => role === 'host' ? ['editor', 'agent'].includes(peer.profile?.role) : peer.profile?.role === 'host' });
  const agentHub = hub().instance;
  let counts;
  const left = [];
  const hostRoom = join('host');
  const session = createLiveSession({ room: hostRoom, host: true, getProject: () => project, setProject() {}, normalize: structuredClone,
    canAccept: () => true, onStatus() {}, onEnd() {}, onGuestCounts: value => { counts = value; },
    onAgentMessage: (data, peer) => agentHub.handle(data, peer), onAgentLeave: peer => left.push(peer) });
  const agentRoom = join('agent');
  try {
    await network.settle();
    assert.deepEqual(counts, { human: 0 });
    const results = new Map();
    agentRoom.onMessage('ask', data => { if (data?.type === 'agent_result') results.set(data.id, data.result); });
    const host = agentRoom.peers()[0].id;
    agentRoom.send('ask', { type: 'agent', op: 'join', id: 'call1', name: 'Claude' }, host);
    await network.settle();
    await new Promise(resolve => setTimeout(resolve, 20));
    await network.settle();
    assert.equal(results.get('call1').name, 'Claude');
    assert.deepEqual(agentHub.agents.map(agent => agent.name), ['Claude']);
    agentRoom.send('ask', { type: 'agent', op: 'board', id: 'call2', token: results.get('call1').token }, host);
    await network.settle();
    await new Promise(resolve => setTimeout(resolve, 20));
    await network.settle();
    assert.equal(results.get('call2').board.source, project.source);
    agentRoom.leave();
    await network.settle();
    assert.equal(left.length, 1);
    assert.deepEqual(counts, { human: 0 });
  } finally {
    session.stop();
    agentRoom.leave();
  }
});

test('the helper manifest matches the files it lists', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/agent-manifest.mjs', import.meta.url)), '--check']);
});
