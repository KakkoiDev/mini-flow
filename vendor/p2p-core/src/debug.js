const MAX_EVENTS = 600;

export function createDebugReport({ app, mode, version, protocol, roomFingerprint }) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const entries = [];
  const peers = new Map();
  let count = 0;
  function record(event, details = {}) {
    const { peerId, ...fields } = details;
    if (peerId !== undefined) {
      if (!peers.has(peerId)) peers.set(peerId, 'peer-' + (peers.size + 1));
      fields.peer = peers.get(peerId);
    }
    entries[count++ % MAX_EVENTS] = { ms: Math.round(performance.now() - started), event, ...fields };
  }

  return {
    record,
    report() {
      const start = count % MAX_EVENTS;
      const events = count <= MAX_EVENTS ? entries : [...entries.slice(start), ...entries.slice(0, start)];
      return structuredClone({
        schemaVersion: 1, app, mode, version, protocol, roomFingerprint, startedAt,
        elapsedMs: Math.round(performance.now() - started),
        browser: {
          userAgent: globalThis.navigator?.userAgent,
          online: globalThis.navigator?.onLine,
          secureContext: globalThis.isSecureContext,
          webSocket: typeof globalThis.WebSocket === 'function',
          webRTC: typeof globalThis.RTCPeerConnection === 'function',
        },
        omittedEvents: Math.max(0, count - MAX_EVENTS),
        events,
      });
    },
  };
}
