export function bridgeAddress(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS bridge URL or HTTP on localhost.');
  }
  return url.href.replace(/\/$/, '');
}

// Add HTTP/SSE AI peers to the host's existing browser room.
export async function connectAgentBridge(room, invite, address, onDisconnect) {
  const base = bridgeAddress(address);
  const controller = new AbortController();
  const listeners = new Map();
  const peers = new Set();
  let joined, left, token, stopped;
  let pending = Promise.resolve();

  function request(path, { method = 'GET', data, signal = controller.signal, keepalive = false } = {}) {
    return fetch(base + path, {
      method, signal, keepalive, redirect: 'error',
      headers: {
        ...(token && { Authorization: 'Bearer ' + token }),
        ...(data && { 'Content-Type': 'application/json' })
      },
      body: data && JSON.stringify(data)
    }).then(response => {
      if (!response.ok) throw new Error('AI bridge returned HTTP ' + response.status + '.');
      return response;
    });
  }

  const created = await request('/v1/rooms', {
    method: 'POST', data: invite, signal: AbortSignal.timeout(8000)
  });
  ({ token } = await created.json());
  const path = '/v1/rooms/' + invite.room + '/host';
  function disconnect() {
    if (stopped) return;
    stopped = true;
    request(path, { method: 'DELETE', signal: AbortSignal.timeout(3000), keepalive: true }).catch(() => {});
    controller.abort();
    for (const peer of peers) left?.(peer);
    peers.clear();
  }

  let stream;
  const deadline = setTimeout(() => controller.abort(), 8000);
  try {
    stream = await request(path + '/events');
  } catch (error) {
    disconnect();
    throw error;
  } finally {
    clearTimeout(deadline);
  }

  async function listen() {
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = frame.split('\n').find(line => line.startsWith('data: '));
          if (!line) continue;
          const { type, peer, kind, data } = JSON.parse(line.slice(6));
          if (type === 'join') {
            peers.add(peer);
            joined?.(peer);
          } else if (type === 'leave') {
            peers.delete(peer);
            left?.(peer);
          } else if (type === 'message' && peers.has(peer)) {
            listeners.get(kind)?.(data, peer);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // The room handlers are installed synchronously after this function returns.
  setTimeout(() => listen().catch(() => {}).finally(() => {
    if (stopped) return;
    disconnect();
    onDisconnect();
  }), 0);
  return {
    selfId: room.selfId,
    onPeerJoin(callback) { joined = callback; room.onPeerJoin(callback); },
    onPeerLeave(callback) { left = callback; room.onPeerLeave(callback); },
    onRefused: (...args) => room.onRefused?.(...args),
    onMessage(kind, callback) { listeners.set(kind, callback); room.onMessage(kind, callback); },
    send(kind, data, to) {
      const targets = Array.isArray(to) ? to : [to];
      const ai = targets.filter(peer => peer?.startsWith('http-ai-') && peers.has(peer));
      const browser = targets.filter(peer => !peer?.startsWith('http-ai-'));
      const sends = [];
      if (browser.length) sends.push(room.send(kind, data, browser));
      if (ai.length) {
        const send = pending.then(() => request(path + '/messages', { method: 'POST', data: { kind, data, to: ai } }));
        pending = send.catch(() => {});
        sends.push(send);
      }
      return Promise.all(sends);
    },
    leave() { disconnect(); room.leave(); }
  };
}
