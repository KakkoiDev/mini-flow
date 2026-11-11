const kinds = ['read', 'state', 'edit', 'end', 'presence', 'agent', 'ask'];
const maxGuests = 8;
const invitePattern = /^#live=([a-f0-9]{32})\.([a-f0-9]{32})$/;
const id = () => crypto.randomUUID().replaceAll('-', '');

export function readLiveInvite(hash) {
  const match = hash.match(invitePattern);
  return match && { room: match[1], password: match[2] };
}

export function createLiveSession({ room, host, getProject, setProject, normalize, canAccept, onStatus, onEnd,
  onAvailability = () => {}, onPresence = () => {}, onGuestCounts = () => {}, readNote = () => null }) {
  let hostPeer;
  const guests = new Map();
  let closed = false;
  let applying = false;
  let pending;
  let state = host ? { revision: 0, project: getProject() } : undefined;
  let localDirty = false;
  let deferredState;
  let flushTimer;
  let presenceTimer;
  let presenceRevision = 0;
  let presence = { point: null, focus: null };
  let agentRegistration;
  let agentRegistered = false;
  const requests = [];
  const requestWaiters = new Set();
  const pendingAsks = new Map();
  const pendingDeliveries = new Map();
  let requestSequence = 0;

  function waitForAIRequest(after = 0, timeoutMs = 12000) {
    if (host || closed || !hostPeer || !agentRegistered) {
      return Promise.resolve(failure('ai_not_connected', 'Register as a live AI guest first.'));
    }
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000) {
      return Promise.resolve(failure('invalid_wait', 'Use a nonnegative cursor and a timeout of up to 15000 ms.'));
    }
    const request = requests.find(item => item.sequence > after);
    if (request || !timeoutMs) return Promise.resolve({ ok: true, request: request ?? null });
    if (requestWaiters.size >= 8) return Promise.resolve(failure('too_many_waiters', 'Finish a pending request check first.'));
    return new Promise(resolve => {
      const waiter = { after, finish(result) {
        clearTimeout(timer);
        requestWaiters.delete(waiter);
        resolve(result);
      } };
      const timer = setTimeout(() => waiter.finish({ ok: true, request: null }), timeoutMs);
      requestWaiters.add(waiter);
    });
  }

  function clearAIRequests() {
    const result = failure('live_disconnected', 'The live connection ended.');
    for (const waiter of requestWaiters) waiter.finish(result);
    for (const finish of pendingAsks.values()) finish(result);
    for (const delivery of pendingDeliveries.values()) delivery.finish(result);
    requests.length = 0;
  }

  function forwardAIRequest(noteId, from) {
    const note = readNote(getProject(), noteId);
    if (!note) return failure('note_missing', 'The note is no longer on the board.');
    const agents = [...guests].filter(([peer, guest]) => guest.agent && peer !== from).map(([peer]) => peer);
    if (!agents.length) return failure('no_ai_guest', 'No other AI guest is connected.');
    if (pendingDeliveries.size >= 32) return failure('too_many_requests', 'Wait for a pending request to finish.');
    const requestId = id();
    return new Promise(resolve => {
      const failed = failure('ask_failed', 'No AI guest confirmed receipt of the note.');
      const finish = result => {
        clearTimeout(timer);
        pendingDeliveries.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish(failed), 3000);
      pendingDeliveries.set(requestId, { agents: new Set(agents), finish });
      send('ask', { type: 'delivery', requestId, note, requester: guests.get(from)?.label ?? 'Host' }, agents)
        .catch(() => finish(failed));
    });
  }

  function askAI(noteId) {
    if (closed || !state || (!host && !hostPeer)) {
      return Promise.resolve(failure('live_not_ready', 'The live board is disconnected.'));
    }
    if (host) return Promise.resolve(forwardAIRequest(noteId, room.selfId));
    if (pendingAsks.size >= 8) return Promise.resolve(failure('too_many_requests', 'Wait for a pending request to finish.'));
    return new Promise(resolve => {
      const requestId = id();
      const finish = result => {
        clearTimeout(timer);
        pendingAsks.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish(failure('ask_timeout', 'The host did not confirm the request.')), 5000);
      pendingAsks.set(requestId, finish);
      send('ask', { type: 'request', requestId, noteId }).catch(() =>
        finish(failure('ask_failed', 'Could not send the request to the host.')));
    });
  }

  function finishAgentRegistration(ok) {
    if (!agentRegistration) return;
    const { resolve, timer } = agentRegistration;
    agentRegistration = undefined;
    clearTimeout(timer);
    resolve(ok ? { ok: true } : failure('agent_registration_failed', 'The host did not confirm registration. Try again.'));
  }

  function registerAgent() {
    if (host || closed || !hostPeer || !state) {
      return Promise.resolve(failure('live_not_ready', 'Join a live session as a guest before registering.'));
    }
    if (agentRegistration) return agentRegistration.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    agentRegistration = { promise, resolve, timer: setTimeout(() => finishAgentRegistration(false), 5000) };
    send('agent', true).catch(() => finishAgentRegistration(false));
    return promise;
  }

  function available() {
    onAvailability(!closed && (host || Boolean(hostPeer && state && !pending)));
  }

  function send(kind, data, to = hostPeer) {
    return Promise.resolve().then(() => room.send(kind, data, to));
  }

  function install(project, message) {
    if (JSON.stringify(getProject()) === JSON.stringify(project)) return;
    applying = true;
    try {
      setProject(project, { message, preserveView: Boolean(state) });
    } finally {
      applying = false;
    }
  }

  function refresh() {
    const project = getProject();
    if (JSON.stringify(project) === JSON.stringify(state.project)) return false;
    state = { revision: state.revision + 1, project };
    return true;
  }

  function publish(extra = {}, to = [...guests.keys()]) {
    if (Array.isArray(to) && !to.length) return;
    send('state', { ...state, ...extra }, to).catch(() => onStatus('Could not send the board.'));
  }

  function finish(result) {
    if (!pending) return;
    const request = pending;
    pending = undefined;
    clearTimeout(request.timer);
    if (state) install(state.project);
    available();
    onStatus(result.ok ? 'Live · Connected' : result.message);
    request.resolve(result);
  }

  function submit(project, message) {
    if (!hostPeer || !state || closed) return Promise.resolve(failure('live_not_ready', 'The host is not connected.'));
    if (pending) return Promise.resolve(failure('edit_pending', 'Wait for the current edit to finish.'));
    return new Promise(resolve => {
      const request = { id: id(), resolve };
      request.timer = setTimeout(() => {
        finish(failure('live_timeout', 'The host did not acknowledge the edit. Check the board before retrying.'));
        if (hostPeer) send('read', null).catch(() => {});
      }, 10000);
      pending = request;
      available();
      onStatus('Sending edit…');
      send('edit', { id: request.id, revision: state.revision, project, message }).catch(() => {
        if (pending === request) finish(failure('live_send_failed', 'Could not send the edit.'));
      });
    });
  }

  function flushGuest() {
    if (flushTimer || closed) return;
    // Shape creation is followed by inline label editing. Publish the finished gesture as one change.
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (!canAccept()) { flushGuest(); return; }
      if (localDirty) {
        localDirty = false;
        const project = getProject();
        if (hostPeer && state && !pending && JSON.stringify(project) !== JSON.stringify(state.project)) {
          submit(project, 'Collaborator updated the diagram.');
        }
      }
      if (deferredState) {
        const data = deferredState;
        deferredState = undefined;
        receiveState(data);
      }
    }, 32);
  }

  function reportGuestCount() {
    const count = guests.size;
    onStatus(count ? `Live · ${count} ${count === 1 ? 'guest' : 'guests'} connected` : 'Waiting for guests…');
    onGuestCounts(guestCounts());
  }

  function guestCounts() {
    const ai = Array.from(guests.values()).filter(guest => guest.agent).length;
    return { human: guests.size - ai, ai };
  }

  function presenceSnapshot() {
    return [{ id: room.selfId, label: 'Host', ...presence },
      ...Array.from(guests, ([id, guest]) => ({ id, label: guest.label, ...guest.presence }))];
  }

  function publishPresence() {
    if (!host || !guests.size) return;
    const snapshot = presenceSnapshot();
    onPresence(snapshot.filter(item => item.id !== room.selfId));
    send('presence', { revision: ++presenceRevision, peers: snapshot, counts: guestCounts() }, [...guests.keys()]).catch(() => {});
  }

  function schedulePresence() {
    if (presenceTimer || closed) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      if (host) publishPresence();
      else if (hostPeer) send('presence', presence).catch(() => {});
    }, 50);
  }

  room.onPeerJoin(from => {
    if (closed) return;
    if (host) {
      if (guests.has(from) || guests.size >= maxGuests) return;
      const numbers = new Set(Array.from(guests.values(), guest => guest.number));
      const number = Array.from({ length: maxGuests }, (_, i) => i + 1).find(i => !numbers.has(i));
      guests.set(from, { number, label: `Guest ${number}`, presence: { point: null, focus: null } });
      publish({}, from);
      reportGuestCount();
      schedulePresence();
    } else {
      if (hostPeer) return;
      hostPeer = from;
      if (agentRegistered) send('agent', true).catch(() => {});
      onStatus('Receiving the board…');
      send('read', null).catch(() => onStatus('Could not request the board.'));
    }
  });
  room.onPeerLeave(from => {
    if (closed) return;
    if (host) {
      if (!guests.delete(from)) return;
      reportGuestCount();
      if (guests.size) publishPresence();
      else onPresence([]);
      return;
    }
    if (from !== hostPeer) return;
    hostPeer = undefined;
    finishAgentRegistration(false);
    finish(failure('live_disconnected', 'The other tab disconnected.'));
    state = undefined;
    presenceRevision = 0;
    deferredState = undefined;
    localDirty = false;
    available();
    onPresence([]);
    onGuestCounts(null);
    clearAIRequests();
    onStatus('Host disconnected. You can wait or choose Leave session to keep editing a copy.');
  });
  room.onRefused?.((_, reason) => {
    if (host || hostPeer || closed) return;
    if (reason === 'they-refused:version' || reason === 'version') {
      onStatus('Reload Mini Flow in both browsers to join this session.');
    }
  });
  room.onMessage('read', (_, from) => {
    if (!host || !guests.has(from) || closed) return;
    publish({}, from);
  });
  room.onMessage('edit', (data, from) => {
    if (!host || !guests.has(from) || closed || typeof data?.id !== 'string') return;
    if (data.revision !== state.revision) {
      publish({ id: data.id, ...failure('revision_conflict', 'The board changed. Review the latest version before retrying.') }, from);
      return;
    }
    if (!canAccept()) {
      publish({ id: data.id, ...failure('host_editing', 'The host is editing. Read the board again before retrying.') }, from);
      return;
    }
    const message = typeof data.message === 'string' && data.message.trim()
      ? data.message.trim().slice(0, 200) : 'Live edit applied.';
    try {
      install(normalize(data.project), message);
      const changed = refresh();
      publish({ id: data.id, ok: true, message }, from);
      if (changed) publish({ message }, [...guests.keys()].filter(id => id !== from));
    } catch {
      publish({ id: data.id, ...failure('invalid_edit', 'The host rejected an invalid board.') }, from);
    }
  });
  function receiveState(data) {
    if (!state || data.revision > state.revision) {
      try {
        const project = normalize(data.project);
        install(project, data.ok === false ? undefined : data.message);
        state = { revision: data.revision, project };
      } catch {
        onStatus('Could not read the live board.');
        return;
      }
    }
    if (pending && data.id === pending.id) finish(data.ok ? { ok: true } : failure(data.reason, data.message));
    else if (!pending) onStatus('Live · Connected');
    available();
  }
  room.onMessage('state', (data, from) => {
    if (host || from !== hostPeer || closed || !Number.isSafeInteger(data?.revision) || data.revision < 0) return;
    if (!pending && (localDirty || !canAccept())) {
      if (!deferredState || data.revision >= deferredState.revision) deferredState = data;
      flushGuest();
      return;
    }
    receiveState(data);
  });
  room.onMessage('presence', (data, from) => {
    if (closed) return;
    if (host) {
      const guest = guests.get(from);
      if (!guest) return;
      guest.presence = readPresence(data);
      schedulePresence();
    } else if (from === hostPeer && Array.isArray(data?.peers) &&
      Number.isSafeInteger(data.revision) && data.revision > presenceRevision) {
      presenceRevision = data.revision;
      if ([data.counts?.human, data.counts?.ai].every(n => Number.isInteger(n) && n >= 0 && n <= maxGuests)) {
        onGuestCounts(data.counts);
      }
      onPresence(data.peers.slice(0, maxGuests + 1).filter(item => typeof item?.id === 'string' &&
        item.id !== room.selfId && typeof item.label === 'string').map(item => ({
        id: item.id, label: item.label.slice(0, 32), ...readPresence(item)
      })));
    }
  });
  room.onMessage('agent', (data, from) => {
    if (closed || data !== true) return;
    if (host) {
      const guest = guests.get(from);
      if (!guest) return;
      guest.agent = true;
      guest.label = `AI ${guest.number}`;
      onGuestCounts(guestCounts());
      publishPresence();
      send('agent', true, from).catch(() => {});
    } else if (from === hostPeer) {
      agentRegistered = true;
      finishAgentRegistration(true);
    }
  });
  room.onMessage('ask', async (data, from) => {
    if (closed) return;
    if (host) {
      if (data?.type === 'received') {
        const delivery = pendingDeliveries.get(data.requestId);
        if (delivery?.agents.has(from)) delivery.finish({ ok: true });
        return;
      }
      if (!guests.has(from) || data?.type !== 'request' ||
          typeof data.noteId !== 'string' || data.noteId.length > 128 ||
          typeof data.requestId !== 'string' || data.requestId.length !== 32) return;
      const result = await forwardAIRequest(data.noteId, from);
      await send('ask', { type: 'result', requestId: data.requestId, result }, from).catch(() => {});
    } else if (from === hostPeer && data?.type === 'result') {
      pendingAsks.get(data.requestId)?.(data.result);
    } else if (from === hostPeer && agentRegistered && data?.type === 'delivery' && data.note) {
      const request = { sequence: ++requestSequence, note: data.note, requester: data.requester };
      requests.push(request);
      if (requests.length > 32) requests.shift();
      for (const waiter of requestWaiters) {
        if (request.sequence > waiter.after) waiter.finish({ ok: true, request });
      }
      send('ask', { type: 'received', requestId: data.requestId }).catch(() => {});
    }
  });
  room.onMessage('end', (_, from) => {
    if (!host && from === hostPeer && !closed) stop(false);
  });

  function stop(notify = true) {
    if (closed) return;
    closed = true;
    clearTimeout(flushTimer);
    clearTimeout(presenceTimer);
    let departure;
    if (host && guests.size && notify) {
      try { departure = room.send('end', null, [...guests.keys()]); } catch {}
    }
    Promise.resolve(departure).catch(() => {}).finally(() => room.leave());
    finish(failure('live_disconnected', 'The live session ended.'));
    finishAgentRegistration(false);
    available();
    onPresence([]);
    onGuestCounts(null);
    clearAIRequests();
    onEnd();
  }

  onStatus(host ? 'Waiting for guests…' : 'Waiting for the host…');
  if (host) onGuestCounts(guestCounts());
  available();
  return {
    host,
    ready: () => !closed && (host || Boolean(hostPeer && state && !pending && !localDirty && canAccept())),
    changed() {
      if (closed || applying) return;
      if (host) {
        if (refresh()) publish();
      } else if (hostPeer && state && !pending) {
        localDirty = true;
        flushGuest();
      }
    },
    updatePresence(next) {
      if (closed) return;
      presence = readPresence(next);
      schedulePresence();
    },
    submit,
    askAI,
    waitForAIRequest,
    registerAgent,
    stop
  };
}

function readPresence(data) {
  const point = Array.isArray(data?.point) && data.point.length === 2 && data.point.every(Number.isFinite) ? data.point : null;
  const focus = typeof data?.focus === 'string' && data.focus.length <= 128 ? data.focus : null;
  const laser = Array.isArray(data?.laser) ? data.laser.slice(-40).filter(sample =>
    Array.isArray(sample) && sample.length === 4 && Number.isSafeInteger(sample[0]) && sample[0] > 0 &&
    Number.isFinite(sample[1]) && Number.isFinite(sample[2]) && typeof sample[3] === 'boolean') : [];
  return { point, focus, ...(laser.length ? { laser } : {}) };
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

export async function connectLiveBoard(invite, host, handlers) {
  const { joinRoom } = await import('./vendor/p2p-core/p2p-core.js');
  const role = host ? 'host' : 'editor';
  const room = joinRoom({ app: 'mini-flow-live', ...invite, mode: 'online', protocol: 2, maxPeers: host ? maxGuests : 1,
    maxMessageBytes: 256 * 1024, rateLimit: 60, kinds, profile: { role },
    acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host') });
  return createLiveSession({ ...handlers, room, host });
}

export function newLiveInvite() {
  return { room: id(), password: id() };
}
