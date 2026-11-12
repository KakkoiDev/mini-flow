const MAX_EVENTS = 600;

function probeWebRTC(scope) {
  const peerConnectionType = typeof scope.RTCPeerConnection;
  const webkitPeerConnectionType = typeof scope.webkitRTCPeerConnection;
  const result = { peerConnectionType, webkitPeerConnectionType, localDataChannel: 'api-unavailable' };
  if (peerConnectionType !== 'function') return result;

  let connection;
  try {
    // No offer, signaling, or ICE servers are needed to test the local API.
    connection = new scope.RTCPeerConnection({ iceServers: [] });
    connection.createDataChannel('p2p-core-debug');
    result.localDataChannel = 'passed';
  } catch (error) {
    result.localDataChannel = connection ? 'data-channel-failed' : 'constructor-failed';
    const knownNames = ['TypeError', 'NotSupportedError', 'NotAllowedError', 'SecurityError',
      'InvalidStateError', 'OperationError', 'NotReadableError'];
    result.errorName = knownNames.includes(error?.name) ? error.name : 'Error';
  } finally {
    try { connection?.close(); } catch { /* A debug probe must not interrupt joining. */ }
  }
  return result;
}

export function createDebugReport({ app, mode, version, protocol, roomFingerprint }, scope = globalThis) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const webRTCProbe = probeWebRTC(scope);
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
          userAgent: scope.navigator?.userAgent,
          online: scope.navigator?.onLine,
          secureContext: scope.isSecureContext,
          webSocket: typeof scope.WebSocket === 'function',
          webRTC: webRTCProbe.peerConnectionType === 'function',
          webRTCProbe,
        },
        omittedEvents: Math.max(0, count - MAX_EVENTS),
        events,
      });
    },
  };
}
