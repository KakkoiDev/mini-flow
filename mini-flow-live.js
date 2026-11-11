const kinds = ['read', 'state', 'edit', 'end', 'presence'];
const maxGuests = 8;
const invitePattern = /^#live=([a-f0-9]{32})\.([a-f0-9]{32})$/;
const id = () => crypto.randomUUID().replaceAll('-', '');

export function readLiveInvite(hash) {
  const match = hash.match(invitePattern);
  return match && { room: match[1], password: match[2] };
}

export function createLiveSession({ room, host, getProject, setProject, normalize, canAccept, onStatus, onEnd,
  onAvailability = () => {}, onPresence = () => {} }) {
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
  }

  function presenceSnapshot() {
    return [{ id: room.selfId, label: 'Host', ...presence },
      ...Array.from(guests, ([id, guest]) => ({ id, label: guest.label, ...guest.presence }))];
  }

  function publishPresence() {
    if (!host || !guests.size) return;
    const snapshot = presenceSnapshot();
    onPresence(snapshot.filter(item => item.id !== room.selfId));
    send('presence', { revision: ++presenceRevision, peers: snapshot }, [...guests.keys()]).catch(() => {});
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
    finish(failure('live_disconnected', 'The other tab disconnected.'));
    state = undefined;
    presenceRevision = 0;
    deferredState = undefined;
    localDirty = false;
    available();
    onPresence([]);
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
      onPresence(data.peers.slice(0, maxGuests + 1).filter(item => typeof item?.id === 'string' &&
        item.id !== room.selfId && typeof item.label === 'string').map(item => ({
        id: item.id, label: item.label.slice(0, 32), ...readPresence(item)
      })));
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
    available();
    onPresence([]);
    onEnd();
  }

  onStatus(host ? 'Waiting for guests…' : 'Waiting for the host…');
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
    stop
  };
}

function readPresence(data) {
  const point = Array.isArray(data?.point) && data.point.length === 2 && data.point.every(Number.isFinite) ? data.point : null;
  const focus = typeof data?.focus === 'string' && data.focus.length <= 128 ? data.focus : null;
  return { point, focus };
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
