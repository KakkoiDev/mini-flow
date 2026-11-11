const kinds = ['read', 'state', 'edit', 'end', 'presence'];
const invitePattern = /^#live=([a-f0-9]{32})\.([a-f0-9]{32})$/;
const id = () => crypto.randomUUID().replaceAll('-', '');

export function readLiveInvite(hash) {
  const match = hash.match(invitePattern);
  return match && { room: match[1], password: match[2] };
}

export function createLiveSession({ room, host, getProject, setProject, normalize, canAccept, onStatus, onEnd,
  onAvailability = () => {}, onPresence = () => {} }) {
  let peer;
  let closed = false;
  let applying = false;
  let pending;
  let state = host ? { revision: 0, project: getProject() } : undefined;
  let localDirty = false;
  let deferredState;
  let flushTimer;
  let presenceTimer;
  let presence;

  function available() {
    onAvailability(!closed && (host || Boolean(peer && state && !pending)));
  }

  function send(kind, data, to = peer) {
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

  function publish(extra = {}, to = peer) {
    if (!to) return;
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
    if (!peer || !state || closed) return Promise.resolve(failure('live_not_ready', 'The host is not connected.'));
    if (pending) return Promise.resolve(failure('edit_pending', 'Wait for the current edit to finish.'));
    return new Promise(resolve => {
      const request = { id: id(), resolve };
      request.timer = setTimeout(() => {
        finish(failure('live_timeout', 'The host did not acknowledge the edit. Check the board before retrying.'));
        if (peer) send('read', null).catch(() => {});
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
        if (peer && state && !pending && JSON.stringify(project) !== JSON.stringify(state.project)) {
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

  room.onPeerJoin((from) => {
    if (closed || peer) return;
    peer = from;
    if (host) {
      publish();
      onStatus('Live · Connected');
    } else {
      onStatus('Receiving the board…');
      send('read', null).catch(() => onStatus('Could not request the board.'));
    }
  });
  room.onPeerLeave(from => {
    if (from !== peer) return;
    peer = undefined;
    finish(failure('live_disconnected', 'The other tab disconnected.'));
    if (!host) state = undefined;
    deferredState = undefined;
    localDirty = false;
    available();
    onPresence(null);
    onStatus(host ? 'Waiting for an editor…' : 'Waiting for the host to reconnect…');
  });
  room.onMessage('read', (_, from) => {
    if (!host || from !== peer || closed) return;
    publish();
  });
  room.onMessage('edit', (data, from) => {
    if (!host || from !== peer || closed || typeof data?.id !== 'string') return;
    if (data.revision !== state.revision) {
      publish({ id: data.id, ...failure('revision_conflict', 'The host changed the board. Read it again before retrying.') });
      return;
    }
    if (!canAccept()) {
      publish({ id: data.id, ...failure('host_editing', 'The host is editing. Read the board again before retrying.') });
      return;
    }
    const message = typeof data.message === 'string' && data.message.trim()
      ? data.message.trim().slice(0, 200) : 'Live edit applied.';
    try {
      install(normalize(data.project), message);
      refresh();
      publish({ id: data.id, ok: true, message });
    } catch {
      publish({ id: data.id, ...failure('invalid_edit', 'The host rejected an invalid board.') });
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
    if (host || from !== peer || closed || !Number.isSafeInteger(data?.revision) || data.revision < 0) return;
    if (!pending && (localDirty || !canAccept())) {
      if (!deferredState || data.revision >= deferredState.revision) deferredState = data;
      flushGuest();
      return;
    }
    receiveState(data);
  });
  room.onMessage('presence', (data, from) => {
    if (from !== peer || closed || !data || typeof data !== 'object') return;
    const point = Array.isArray(data.point) && data.point.length === 2 && data.point.every(Number.isFinite) ? data.point : null;
    const focus = typeof data.focus === 'string' && data.focus.length <= 128 ? data.focus : null;
    onPresence({ point, focus, label: host ? 'Collaborator' : 'Host' });
  });
  room.onMessage('end', (_, from) => {
    if (!host && from === peer && !closed) stop(false);
  });

  function stop(notify = true) {
    if (closed) return;
    closed = true;
    clearTimeout(flushTimer);
    clearTimeout(presenceTimer);
    const departure = host && peer && notify ? send('end', null).catch(() => {}) : Promise.resolve();
    departure.finally(() => room.leave());
    finish(failure('live_disconnected', 'The live session ended.'));
    available();
    onPresence(null);
    onEnd();
  }

  onStatus(host ? 'Waiting for an editor…' : 'Waiting for the host…');
  available();
  return {
    host,
    ready: () => !closed && (host || Boolean(peer && state && !pending && !localDirty && canAccept())),
    changed() {
      if (closed || applying) return;
      if (host) {
        if (refresh()) publish();
      } else if (peer && state && !pending) {
        localDirty = true;
        flushGuest();
      }
    },
    updatePresence(next) {
      if (!peer || closed) return;
      presence = next;
      if (presenceTimer) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = undefined;
        if (peer) send('presence', presence).catch(() => {});
      }, 40);
    },
    submit,
    stop
  };
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

export async function connectLiveBoard(invite, host, handlers) {
  const { joinRoom } = await import('./vendor/p2p-core/p2p-core.js');
  const role = host ? 'host' : 'editor';
  const room = joinRoom({ app: 'mini-flow-live', ...invite, mode: 'online', protocol: 1, maxPeers: 1,
    maxMessageBytes: 256 * 1024, kinds, profile: { role },
    acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host') });
  return createLiveSession({ ...handlers, room, host });
}

export function newLiveInvite() {
  return { room: id(), password: id() };
}
