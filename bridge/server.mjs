import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import '../mini-flow.js';
import { createLiveSession } from '../mini-flow-live.js';
import { registerMiniFlowTools } from '../mini-flow-webmcp.js';

const token = () => randomBytes(32).toString('hex');
const inviteId = /^[a-f0-9]{32}$/;
const kinds = new Set(['read', 'state', 'edit', 'end', 'presence', 'agent', 'ask']);
const maxBody = 512 * 1024;
const guide = 'https://github.com/KakkoiDev/mini-flow#join-as-an-ai-guest-with-curl';

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw error(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw error(400, 'Send a JSON object.');
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function openStream(response, onClose) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'
  });
  response.write(': connected\n\n');
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000);
  response.once('close', () => {
    clearInterval(heartbeat);
    onClose();
  });
  function write(frame) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > maxBody) response.destroy();
    else response.write(frame);
  }
  return {
    emit(event, data) { write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); },
    end() { response.end(); }
  };
}

export function createBridgeServer({ origins = ['https://mini-flow.kakkoi.dev', 'http://localhost:8080'] } = {}) {
  const rooms = new Map();

  function removeAgent(room, agent) {
    if (!room.agents.delete(agent.id)) return;
    clearTimeout(agent.expiry);
    agent.session.stop(false);
    room.stream?.emit('room', { type: 'leave', peer: agent.id });
    agent.stream?.end();
  }

  function closeRoom(room) {
    if (!rooms.delete(room.id)) return;
    clearTimeout(room.expiry);
    for (const agent of room.agents.values()) {
      agent.stream?.emit('session_ended', {});
      removeAgent(room, agent);
    }
    room.stream?.end();
  }

  async function addAgent(room) {
    const id = 'http-ai-' + token().slice(0, 32);
    const agent = { id, token: token(), tools: new Map(), notifications: new Map() };
    room.agents.set(id, agent);
    const handlers = new Map();
    let join;
    let project;
    let ready;
    const available = new Promise(resolve => { ready = resolve; });
    agent.receive = (kind, data) => handlers.get(kind)?.(data, 'host');
    agent.session = createLiveSession({
      room: {
        selfId: id,
        onPeerJoin(callback) { join = callback; },
        onPeerLeave() {},
        onMessage(kind, callback) { handlers.set(kind, callback); },
        send(kind, data) {
          if (!rooms.has(room.id) || !room.agents.has(id)) throw new Error('Live session disconnected.');
          room.stream.emit('room', { type: 'message', peer: id, kind, data });
        },
        leave() {}
      },
      host: false,
      getProject: () => project,
      setProject: next => { project = next; },
      normalize: value => value,
      canAccept: () => true,
      onStatus() {},
      onEnd() { ready(false); },
      onAvailability(value) { if (value) ready(true); },
      onAIRequest(event) {
        agent.notifications.set(event.sequence, event);
        if (agent.notifications.size > 32) agent.notifications.delete(agent.notifications.keys().next().value);
        agent.stream?.emit('ask_ai', event);
      }
    });
    try {
      room.stream.emit('room', { type: 'join', peer: id });
      join('host');
      const deadline = setTimeout(() => ready(false), 5000);
      const connected = await available.finally(() => clearTimeout(deadline));
      if (!connected || !(await agent.session.registerAgent()).ok) throw error(503, 'The host could not register this AI guest.');
      await registerMiniFlowTools({ getProject: () => project }, globalThis.MiniFlow, {
        registerTool(tool) { agent.tools.set(tool.name, tool); }
      }, {
        isReady: agent.session.ready,
        commitProject: agent.session.submitAIEdit,
        waitForAIRequest: agent.session.waitForAIRequest,
        reportAIActivity: agent.session.reportAIActivity
      });
      if (!room.agents.has(id)) throw error(503, 'The live session ended.');
      agent.expiry = setTimeout(() => removeAgent(room, agent), 30000);
      return agent;
    } catch (cause) {
      removeAgent(room, agent);
      throw cause;
    }
  }

  async function route(request, response) {
    const origin = request.headers.origin;
    if (origin) {
      if (!origins.includes(origin)) throw error(403, 'This origin is not allowed.');
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    response.setHeader('Cache-Control', 'no-store, no-transform');
    const { method } = request;
    if (method === 'OPTIONS') return response.writeHead(204).end();
    const { pathname } = new URL(request.url, 'http://localhost');
    if (method === 'GET' && (pathname === '/' || pathname === '/v1')) {
      return json(response, 200, {
        name: 'Mini Flow AI bridge', version: 1, guide,
        join: 'POST /v1/rooms/{room}/agents with the live invite password as a bearer token',
        events: 'GET the events path returned by join with the agent bearer token. Keep the SSE stream open.',
        tools: 'GET the tools path for schemas. POST to {tools}/{name} to run a tool.',
        askAI: 'On ask_ai, call wait_for_ai_request with after set to the previous sequence and timeoutMs set to 0. Act only when it returns a request.'
      });
    }
    if (method === 'POST' && pathname === '/v1/rooms') {
      const { room: id, password } = await readBody(request);
      if (typeof id !== 'string' || typeof password !== 'string' || !inviteId.test(id) || !inviteId.test(password)) {
        throw error(400, 'Invalid live room credentials.');
      }
      if (rooms.has(id)) throw error(409, 'This room already exists.');
      if (rooms.size >= 64) throw error(503, 'The bridge has reached its room limit.');
      const room = { id, password, token: token(), agents: new Map() };
      rooms.set(id, room);
      room.expiry = setTimeout(() => closeRoom(room), 15000);
      return json(response, 201, { token: room.token });
    }

    const match = pathname.match(/^\/v1\/rooms\/([a-f0-9]{32})\/(host|agents)(?:\/(.*))?$/);
    if (!match) throw error(404, 'Unknown endpoint.');
    const [, roomId, role, action = ''] = match;
    const room = rooms.get(roomId);
    if (!room) throw error(404, 'The live host is unavailable.');
    const auth = request.headers.authorization;

    if (role === 'host') {
      if (auth !== 'Bearer ' + room.token) throw error(401, 'Invalid host credential.');
      if (action === 'events' && method === 'GET') {
        if (room.stream) throw error(409, 'The host is already connected.');
        clearTimeout(room.expiry);
        room.stream = openStream(response, () => closeRoom(room));
        return;
      }
      if (action === 'messages' && method === 'POST') {
        const { kind, data, to } = await readBody(request);
        if (!kinds.has(kind) || !Array.isArray(to) || to.length > 8) throw error(400, 'Invalid room message.');
        for (const id of to) await room.agents.get(id)?.receive(kind, data);
        return response.writeHead(204).end();
      }
      if (!action && method === 'DELETE') {
        closeRoom(room);
        return response.writeHead(204).end();
      }
      throw error(404, 'Unknown host endpoint.');
    }

    if (!action && method === 'POST') {
      if (auth !== 'Bearer ' + room.password) throw error(401, 'Invalid live invite.');
      if (!room.stream) throw error(503, 'The live host is unavailable.');
      if (room.agents.size >= 8) throw error(503, 'The live room has reached its AI guest limit.');
      const agent = await addAgent(room);
      const path = '/v1/rooms/' + roomId + '/agents/' + agent.id;
      return json(response, 201, { token: agent.token, events: path + '/events', tools: path + '/tools', leave: path });
    }

    const [id, endpoint, toolName, extra] = action.split('/');
    const agent = room.agents.get(id);
    if (!agent || auth !== 'Bearer ' + agent.token) throw error(401, 'Invalid AI guest credential.');
    if (!endpoint && method === 'DELETE') {
      removeAgent(room, agent);
      return response.writeHead(204).end();
    }
    if (endpoint === 'events' && toolName === undefined && method === 'GET') {
      if (agent.stream) throw error(409, 'This AI guest already has an event stream.');
      clearTimeout(agent.expiry);
      agent.stream = openStream(response, () => removeAgent(room, agent));
      agent.stream.emit('ready', { guest: agent.id });
      for (const event of agent.notifications.values()) agent.stream.emit('ask_ai', event);
      return;
    }
    if (endpoint === 'tools' && toolName === undefined && method === 'GET') {
      return json(response, 200, { tools: [...agent.tools.values()].map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema })) });
    }
    if (endpoint === 'tools' && method === 'POST' && extra === undefined) {
      const tool = agent.tools.get(toolName);
      if (!tool) throw error(404, 'Unknown AI tool.');
      const input = await readBody(request);
      const result = await tool.execute(input);
      if (toolName === 'wait_for_ai_request') {
        for (const sequence of agent.notifications.keys()) {
          if (sequence <= (result.request?.sequence ?? input.after ?? 0)) agent.notifications.delete(sequence);
        }
      }
      return json(response, 200, result);
    }
    throw error(404, 'Unknown AI guest endpoint.');
  }

  return createServer((request, response) => {
    route(request, response).catch(cause => {
      if (response.headersSent) return response.destroy();
      json(response, cause.status ?? 500, { error: cause.status ? cause.message : 'Bridge request failed.' });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origins = process.env.MINI_FLOW_ORIGINS?.split(',').map(origin => origin.trim());
  const port = Number(process.env.PORT ?? 8787);
  createBridgeServer({ origins }).listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log('Mini Flow AI bridge listening on port ' + port);
  });
}
