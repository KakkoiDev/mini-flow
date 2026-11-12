// Capture WebRTC milestones before Trystero adds the peer to its public room.
export function traceConnection(config, connection, initiator) {
  if (!config.onDebug) return;
  const attempt = config.nextDebugAttempt();
  const record = (event, fields) => config.onDebug(event, { attempt, ...fields });
  const state = () => ({
    connection: connection.connectionState,
    ice: connection.iceConnectionState,
    gathering: connection.iceGatheringState,
    signaling: connection.signalingState,
  });
  const candidate = value => ({
    type: value.candidateType ?? value.type,
    protocol: value.protocol,
    tcpType: value.tcpType,
    relayProtocol: value.relayProtocol,
  });
  async function stats() {
    try {
      const reports = await connection.getStats();
      const candidates = { local: {}, remote: {} };
      const pairs = {};
      let selected;
      let requestsSent = 0;
      let responsesReceived = 0;
      reports.forEach(report => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          const counts = report.type === 'local-candidate' ? candidates.local : candidates.remote;
          const key = [report.candidateType, report.protocol, report.relayProtocol].filter(Boolean).join('/');
          counts[key] = (counts[key] || 0) + 1;
        }
        if (report.type === 'candidate-pair') {
          requestsSent += report.requestsSent ?? 0;
          responsesReceived += report.responsesReceived ?? 0;
          pairs[report.state] = (pairs[report.state] || 0) + 1;
          if (report.selected || (report.nominated && report.state === 'succeeded')) selected = report;
        }
      });
      reports.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selected = reports.get(report.selectedCandidatePairId) ?? selected;
        }
      });
      record('rtc.stats', {
        candidates, pairs, requestsSent, responsesReceived, selected: selected && {
          local: candidate(reports.get(selected.localCandidateId) ?? {}),
          remote: candidate(reports.get(selected.remoteCandidateId) ?? {}),
          rttMs: Number.isFinite(selected.currentRoundTripTime)
            ? Math.round(selected.currentRoundTripTime * 1000) : undefined,
          requestsSent: selected.requestsSent,
          responsesReceived: selected.responsesReceived,
        },
      });
    } catch {
      record('rtc.stats-unavailable');
    }
  }
  record('rtc.created', { initiator, ...state() });
  for (const event of ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange']) {
    connection.addEventListener(event, () => {
      record('rtc.state', { change: event, ...state() });
      if ((event === 'connectionstatechange' && ['connected', 'failed', 'disconnected'].includes(connection.connectionState))
        || (event === 'icegatheringstatechange' && connection.iceGatheringState === 'complete')) {
        void stats();
      }
    });
  }
  connection.addEventListener('icecandidate', ({ candidate: value }) => {
    record(value ? 'rtc.ice-candidate' : 'rtc.ice-candidates-complete', value ? candidate(value) : {});
  });
  connection.addEventListener('icecandidateerror', ({ errorCode, url }) => {
    record('rtc.ice-server-error', { errorCode, scheme: typeof url === 'string' ? /^(stuns?|turns?):/.exec(url)?.[1] : undefined });
  });

  return {
    record,
    stats,
    channel(channel) {
      record('rtc.data-channel', { state: channel.readyState });
      for (const event of ['open', 'close', 'error']) {
        channel.addEventListener(event, () => record('rtc.data-channel', { state: channel.readyState, change: event }));
      }
    },
  };
}
