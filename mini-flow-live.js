const kinds = ['read', 'state', 'edit', 'end', 'presence', 'agent', 'ask'];
const maxGuests = 8;
export const maxThreadMessages = 12;
export const maxReplyLength = 1000;
export const maxAnswerLength = 2000;
// Set to your trusted Cloudflare relay's wss:// origin to enable fallback.
const liveRelayUrl = 'wss://p2p-core-cloudflare.kakkoidev.workers.dev';
const invitePattern = /^#live=([a-f0-9]{32})\.([a-f0-9]{32})$/;
const id = () => crypto.randomUUID().replaceAll('-', '');

export function readLiveInvite(hash) {
  const match = hash.match(invitePattern);
  return match && { room: match[1], password: match[2] };
}

export function readThreadMessages(messages, assignIds = false) {
  if (!Array.isArray(messages) || !messages.length || messages.length > maxThreadMessages) return null;
  if (!messages.every(message => ['user', 'assistant', 'status'].includes(message?.role) &&
    typeof message.author === 'string' && message.author.length <= 32 &&
    typeof message.text === 'string' && message.text.length <= 4000)) return null;
  return messages.map(message => {
    const { role, author, text, original, replyId, owner, edited } = message;
    const validId = typeof replyId === 'string' && /^[a-f0-9]{32}$/.test(replyId);
    return { role, author, text,
      ...(original === true && { original }),
      ...((validId || assignIds) && { replyId: validId ? replyId : id() }),
      ...(typeof owner === 'string' && owner.length <= 128 && { owner }),
      ...(['author', 'host'].includes(edited) && { edited })
    };
  });
}

export function canManageReply(message, host, selfId) {
  return Boolean(message?.replyId && !message.original &&
    (host ? message.role !== 'status' : message.role === 'user' && selfId && message.owner === selfId));
}

export function changeThreadReply(messages, { replyId, previousText, text }, host, selfId) {
  const message = messages.find(item => item.replyId === replyId);
  if (!message) return failure('reply_missing', 'This reply is no longer in the conversation.');
  if (!canManageReply(message, host, selfId)) return failure('reply_forbidden', 'You can only change your own replies.');
  if (message.text !== previousText) return failure('reply_changed', 'This reply changed. Reopen it to try again.');
  if (text === null) return { ok: true, messages: messages.filter(item => item !== message) };
  const limit = message.role === 'assistant' ? maxAnswerLength : maxReplyLength;
  if (typeof text !== 'string' || !text.trim() || text.length > limit) {
    return failure('invalid_reply', 'Enter a reply of up to ' + limit + ' characters.');
  }
  if (text.trim() === message.text) return { ok: true, messages };
  const edited = host && (!selfId || message.owner !== selfId) && !['Host', 'You'].includes(message.author) ? 'host' : 'author';
  return { ok: true, messages: messages.map(item => item === message ? { ...item, text: text.trim(), edited } : item) };
}

export function createLiveSession({ room, host, getProject, setProject, normalize, canAccept, onStatus, onEnd,
  onAvailability = () => {}, onPresence = () => {}, onGuestCounts = () => {}, readNote = () => null,
  noteIds = () => [], onNoteColors = () => {}, onAIRequests = () => {}, onAIThread = () => {}, initialThreads = [] }) {
  let hostPeer;
  const guests = new Map();
  let closed = false;
  let applying = false;
  let pending;
  let state = host ? { revision: 0, project: getProject() } : undefined;
  const noteColors = new Map();
  let nextColor = 0;
  let localDirty = false;
  let deferredState;
  let flushTimer;
  let presenceTimer;
  let presenceRevision = 0;
  let presence = { point: null, focus: null };
  let agentRegistration;
  let agentRegistered = false;
  let reportedActivity = false;
  const requests = [];
  const requestWaiters = new Set();
  const pendingAsks = new Map();
  const pendingDeliveries = new Map();
  const offers = new Map();
  const results = new Map();
  const threads = new Map(host ? initialThreads : []);
  let nextGuestNumber = 0;
  function reserveGuestNumbers(entries) {
    for (const messages of entries.values()) for (const { author } of messages) {
      const number = Number(author.match(/^(?:Guest|AI) (\d+)$/)?.[1]);
      if (Number.isSafeInteger(number)) nextGuestNumber = Math.max(nextGuestNumber, number);
    }
  }
  reserveGuestNumbers(threads);
  const pendingClaims = new Map();
  let requestSequence = 0;

  function publishThread(noteId, to) {
    const messages = threads.get(noteId);
    send('ask', { type: 'thread', noteId, messages }, to).catch(() => {});
  }

  function updateThread(noteId, messages) {
    if (messages.length) threads.set(noteId, messages);
    else threads.delete(noteId);
    onAIThread(noteId, messages.length ? messages : null);
    publishThread(noteId);
  }

  function appendThread(noteId, message) {
    updateThread(noteId, [...(threads.get(noteId) ?? []), { ...message, replyId: id() }].slice(-maxThreadMessages));
  }

  function manageReply(noteId, from, change) {
    const messages = threads.get(noteId) ?? [];
    const result = changeThreadReply(messages, change, from === room.selfId, from);
    if (!result.ok) return result;
    const latest = messages.findLast(message => message.role === 'assistant');
    const preview = results.get(noteId);
    if (latest?.replyId === change.replyId && preview?.author === latest.author && preview.label === latest.text.slice(0, 200)) {
      const edited = result.messages.find(message => message.replyId === change.replyId);
      if (edited) results.set(noteId, { ...preview, label: edited.text.slice(0, 200) });
      else results.delete(noteId);
      publishPresence();
    }
    updateThread(noteId, result.messages);
    return { ok: true };
  }

  function finishOffer(requestId, label, author) {
    const offer = offers.get(requestId);
    if (!offer) return;
    clearTimeout(offer.timer);
    offers.delete(requestId);
    if (label) {
      results.delete(offer.noteId);
      results.set(offer.noteId, { phase: 'result', label: label.slice(0, 200), ...(author && { author }) });
      if (results.size > 32) results.delete(results.keys().next().value);
      appendThread(offer.noteId, { role: author ? 'assistant' : 'status', author: author ?? 'Mini Flow', text: label });
    }
    if (!closed) publishPresence();
  }

  function waitForAIRequest(after = 0, timeoutMs = 12000) {
    if (host || closed || !hostPeer || !agentRegistered) {
      return Promise.resolve(failure('ai_not_connected', 'Register as a live AI guest first.'));
    }
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 15000) {
      return Promise.resolve(failure('invalid_wait', 'Use a nonnegative cursor and a timeout of up to 15000 ms.'));
    }
    const request = requests.find(item => item.sequence > after);
    if (request) return claimRequest(request);
    if (!timeoutMs) return Promise.resolve({ ok: true, request: null });
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

  function claimRequest(request) {
    const existing = pendingClaims.get(request.id);
    if (existing) return existing.promise;
    let finish;
    const promise = new Promise(resolve => {
      finish = granted => {
        clearTimeout(timer);
        pendingClaims.delete(request.id);
        const index = requests.indexOf(request);
        if (index >= 0) requests.splice(index, 1);
        resolve({ ok: true, request: granted ? request : null });
      };
      const timer = setTimeout(() => finish(false), 3000);
    });
    pendingClaims.set(request.id, { promise, finish });
    send('ask', { type: 'claim', requestId: request.id }).catch(() => finish(false));
    return promise;
  }

  function clearAIRequests() {
    const result = failure('live_disconnected', 'The live connection ended.');
    for (const waiter of requestWaiters) waiter.finish(result);
    for (const finish of pendingAsks.values()) finish(result);
    for (const delivery of pendingDeliveries.values()) delivery.finish(result);
    for (const claim of pendingClaims.values()) claim.finish(false);
    for (const offer of offers.values()) clearTimeout(offer.timer);
    offers.clear();
    results.clear();
    if (!host) threads.clear();
    onAIRequests({});
    requests.length = 0;
  }

  function forwardAIRequest(noteId, from, prompt) {
    const note = readNote(getProject(), noteId);
    if (!note) return failure('note_missing', 'The note is no longer on the board.');
    const agents = [...guests].filter(([peer, guest]) => guest.agent && peer !== from).map(([peer]) => peer);
    if (!agents.length) return failure('no_ai_guest', 'No other AI guest is connected.');
    if ([...offers.values()].some(offer => offer.noteId === noteId)) {
      return failure('already_requested', 'This note already has an active AI request.');
    }
    if (offers.size >= 32) return failure('too_many_requests', 'Wait for a pending request to finish.');
    if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > maxReplyLength)) {
      return failure('invalid_reply', 'Enter a reply of up to 1000 characters.');
    }
    const requester = guests.get(from)?.label ?? 'Host';
    const thread = threads.get(noteId);
    const text = prompt?.trim() ?? thread?.findLast(message => message.role === 'user')?.text ?? note.text;
    const requestId = id();
    results.delete(noteId);
    const expire = () => finishOffer(requestId, 'No AI claimed the request');
    offers.set(requestId, { noteId, agents: new Set(agents), timer: setTimeout(expire, 90000) });
    if (!thread || prompt !== undefined) {
      appendThread(noteId, { role: 'user', author: requester, owner: from, text, ...(!thread && prompt === undefined && { original: true }) });
    }
    publishPresence();
    return new Promise(resolve => {
      const failed = failure('ask_failed', 'No AI guest confirmed receipt of the note.');
      const finish = result => {
        clearTimeout(timer);
        pendingDeliveries.delete(requestId);
        if (!result.ok) finishOffer(requestId, result.message);
        resolve(result);
      };
      const timer = setTimeout(() => finish(failed), 3000);
      pendingDeliveries.set(requestId, { agents: new Set(agents), finish });
      send('ask', { type: 'delivery', requestId, note: { ...note, text }, requester, ...(thread && { thread }) }, agents)
        .catch(() => finish(failed));
    });
  }

  function appendComment(noteId, from, text) {
    if (!readNote(getProject(), noteId)) return failure('note_missing', 'The note is no longer on the board.');
    if (typeof text !== 'string' || !text.trim() || text.length > maxReplyLength) {
      return failure('invalid_reply', 'Enter a reply of up to 1000 characters.');
    }
    appendThread(noteId, { role: 'user', author: guests.get(from)?.label ?? 'Host', owner: from, text: text.trim() });
    return { ok: true };
  }

  function handleNoteMessage(type, noteId, from, value) {
    if (type === 'comment') return appendComment(noteId, from, value);
    if (type === 'manage_reply') return manageReply(noteId, from, value ?? {});
    return forwardAIRequest(noteId, from, value);
  }

  function submitNoteMessage(type, noteId, prompt) {
    if (closed || !state || (!host && !hostPeer)) {
      return Promise.resolve(failure('live_not_ready', 'The live board is disconnected.'));
    }
    if (host) return Promise.resolve(handleNoteMessage(type, noteId, room.selfId, prompt));
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
      send('ask', { type, requestId, noteId, prompt }).catch(() =>
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

  function refresh(color = 0) {
    const project = getProject();
    if (JSON.stringify(project) === JSON.stringify(state.project)) return false;
    const before = new Set(noteIds(state.project));
    const after = new Set(noteIds(project));
    for (const noteId of threads.keys()) {
      if (!before.has(noteId) || after.has(noteId)) continue;
      threads.delete(noteId);
      onAIThread(noteId, null);
      publishThread(noteId);
    }
    for (const note of noteColors.keys()) if (!after.has(note)) noteColors.delete(note);
    for (const note of after) if (!before.has(note) && color) noteColors.set(note, color);
    onNoteColors(Object.fromEntries(noteColors));
    state = { revision: state.revision + 1, project };
    return true;
  }

  function publish(extra = {}, to = [...guests.keys()]) {
    if (Array.isArray(to) && !to.length) return;
    send('state', { ...state, noteColors: Object.fromEntries(noteColors), ...extra }, to)
      .catch(() => onStatus('Could not send the board.'));
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

  function submit(project, message, { keepClaim = false } = {}) {
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
      send('edit', { id: request.id, revision: state.revision, project, message, keepClaim }).catch(() => {
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
      ...Array.from(guests, ([id, guest]) => ({ id, label: guest.label, color: guest.color, ...guest.presence }))];
  }

  function publishPresence() {
    if (!host) return;
    const aiRequests = Object.fromEntries([...results, ...[...offers.values()].map(offer => [
      offer.noteId, offer.winner
        ? { phase: 'working', label: guests.get(offer.winner)?.label ?? 'AI' }
        : { phase: 'waiting', label: 'Waiting for AI' }
    ])]);
    onAIRequests(aiRequests);
    if (!guests.size) return;
    const snapshot = presenceSnapshot();
    onPresence(snapshot.filter(item => item.id !== room.selfId));
    send('presence', { revision: ++presenceRevision, peers: snapshot, counts: guestCounts(), aiRequests },
      [...guests.keys()]).catch(() => {});
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
      const number = ++nextGuestNumber;
      guests.set(from, { number, color: ++nextColor, label: `Guest ${number}`, presence: { point: null, focus: null } });
      publish({}, from);
      for (const noteId of threads.keys()) publishThread(noteId, from);
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
      for (const [requestId, offer] of offers) {
        offer.agents.delete(from);
        if (offer.winner === from || !offer.agents.size) finishOffer(requestId, 'AI guest disconnected');
      }
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
    onNoteColors({});
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
      const guest = guests.get(from);
      install(normalize(data.project), message);
      const changed = refresh(guest.color);
      publish({ id: data.id, ok: true, message }, from);
      if (changed) publish({ message }, [...guests.keys()].filter(id => id !== from));
      if (guest.agent) for (const [requestId, offer] of offers) {
        if (offer.winner !== from) continue;
        if (data.keepClaim === true) offer.lastEdit = message;
        else finishOffer(requestId, message, guest.label);
      }
    } catch {
      publish({ id: data.id, ...failure('invalid_edit', 'The host rejected an invalid board.') }, from);
    }
  });
  function receiveState(data) {
    if (!state || data.revision > state.revision) {
      try {
        const project = normalize(data.project);
        onNoteColors(Object.fromEntries(Object.entries(data.noteColors ?? {}).filter(([id, color]) =>
          Object.hasOwn(project.positions, id) && Number.isSafeInteger(color) && color > 0)));
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
      guest.presence = readPresence(data, guest.agent);
      schedulePresence();
    } else if (from === hostPeer && Array.isArray(data?.peers) &&
      Number.isSafeInteger(data.revision) && data.revision > presenceRevision) {
      presenceRevision = data.revision;
      if ([data.counts?.human, data.counts?.ai].every(n => Number.isInteger(n) && n >= 0 && n <= maxGuests)) {
        onGuestCounts(data.counts);
      }
      onPresence(data.peers.slice(0, maxGuests + 1).filter(item => typeof item?.id === 'string' &&
        item.id !== room.selfId && typeof item.label === 'string').map(item => ({
        id: item.id, label: item.label.slice(0, 32),
        ...(Number.isSafeInteger(item.color) && item.color > 0 ? { color: item.color } : {}),
        ...readPresence(item, /^AI \d+$/.test(item.label))
      })));
      onAIRequests(Object.fromEntries(Object.entries(data.aiRequests ?? {}).slice(0, 64)
        .filter(([id, status]) => id.length <= 128 && (typeof status === 'string' && status.length <= 32 ||
          ['waiting', 'working', 'result'].includes(status?.phase) &&
          typeof status.label === 'string' && status.label.length <= 200))));
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
      if (data?.type === 'done' && guests.get(from)?.agent) {
        for (const [requestId, offer] of offers) {
          if (offer.winner === from) finishOffer(requestId,
            typeof data.result === 'string' && data.result.trim() ? data.result.trim().slice(0, maxAnswerLength)
              : offer.lastEdit ?? 'AI finished the request', guests.get(from).label);
        }
        return;
      }
      if (data?.type === 'claim') {
        const offer = offers.get(data.requestId);
        if (!guests.get(from)?.agent) return;
        const busy = [...offers.values()].some(other => other !== offer && other.winner === from);
        if (offer?.agents.has(from) && !offer.winner && !busy) {
          offer.winner = from;
          clearTimeout(offer.timer);
          offer.timer = setTimeout(() => finishOffer(data.requestId, 'AI request timed out'), 300000);
          const guest = guests.get(from);
          guest.presence = { ...guest.presence, activity: 'Reviewing a note…' };
          publishPresence();
        }
        await send('ask', { type: 'claim_result', requestId: data.requestId, granted: offer?.winner === from }, from)
          .catch(() => {});
        return;
      }
      if (data?.type === 'received') {
        const delivery = pendingDeliveries.get(data.requestId);
        if (delivery?.agents.has(from)) delivery.finish({ ok: true });
        return;
      }
      if (!guests.has(from) || !['request', 'comment', 'manage_reply'].includes(data?.type) ||
          typeof data.noteId !== 'string' || data.noteId.length > 128 ||
          typeof data.requestId !== 'string' || data.requestId.length !== 32) return;
      const result = await handleNoteMessage(data.type, data.noteId, from, data.prompt);
      await send('ask', { type: 'result', requestId: data.requestId, result }, from).catch(() => {});
    } else if (from === hostPeer && data?.type === 'result') {
      pendingAsks.get(data.requestId)?.(data.result);
    } else if (from === hostPeer && data?.type === 'thread' &&
      typeof data.noteId === 'string' && data.noteId.length <= 128) {
      if (data.messages === undefined) {
        threads.delete(data.noteId);
        onAIThread(data.noteId, null);
      } else {
        const messages = readThreadMessages(data.messages);
        if (messages) {
          threads.set(data.noteId, messages);
          onAIThread(data.noteId, messages);
        }
      }
    } else if (from === hostPeer && data?.type === 'claim_result') {
      if (data.granted === true && pendingClaims.has(data.requestId)) {
        presence = { ...presence, activity: 'Reviewing a note…' };
        schedulePresence();
      }
      pendingClaims.get(data.requestId)?.finish(data.granted === true);
    } else if (from === hostPeer && agentRegistered && data?.type === 'delivery' && data.note) {
      const request = { id: data.requestId, sequence: ++requestSequence, note: data.note, requester: data.requester,
        ...(Array.isArray(data.thread) && { thread: data.thread }) };
      requests.push(request);
      if (requests.length > 32) requests.shift();
      for (const waiter of requestWaiters) {
        if (request.sequence > waiter.after) waiter.finish(claimRequest(request));
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
    onNoteColors({});
    clearAIRequests();
    onEnd();
  }

  onStatus(host ? 'Waiting for guests…' : 'Waiting for the host…');
  if (host) onGuestCounts(guestCounts());
  available();
  return {
    host,
    canManageReply: message => canManageReply(message, host, room.selfId),
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
      presence = readPresence({ ...next, activity: presence.activity }, agentRegistered);
      schedulePresence();
    },
    reportAIActivity(message, result) {
      if (host || closed || !hostPeer || !agentRegistered) return failure('ai_not_connected', 'Register as a live AI guest first.');
      if (typeof message !== 'string' || message.length > 200) return failure('invalid_activity', 'Use a status of up to 200 characters.');
      if (result !== undefined && (typeof result !== 'string' || result.length > maxAnswerLength || message.trim())) {
        return failure('invalid_result', 'Send a result of up to 2000 characters with an empty progress message.');
      }
      reportedActivity = Boolean(message.trim());
      presence = { ...presence, activity: message.trim() || undefined };
      schedulePresence();
      if (!presence.activity) send('ask', { type: 'done', result }).catch(() => {});
      return { ok: true };
    },
    submit,
    submitAIEdit(project, message) {
      if (!agentRegistered || reportedActivity) return submit(project, message, { keepClaim: reportedActivity });
      presence = { ...presence, activity: 'Applying board edits…' };
      schedulePresence();
      return submit(project, message).then(result => {
        if (!reportedActivity) {
          presence = { ...presence, activity: result.ok ? undefined : 'Edit needs a retry' };
          schedulePresence();
        }
        return result;
      });
    },
    askAI: (noteId, prompt) => submitNoteMessage('request', noteId, prompt),
    comment: (noteId, text) => submitNoteMessage('comment', noteId, text),
    manageReply: (noteId, change) => submitNoteMessage('manage_reply', noteId, change),
    replaceThreads(next) {
      if (!host || closed) return;
      for (const requestId of offers.keys()) finishOffer(requestId);
      results.clear();
      publishPresence();
      const changed = new Set([...threads.keys(), ...next.keys()]);
      threads.clear();
      for (const [noteId, messages] of next) threads.set(noteId, messages);
      reserveGuestNumbers(threads);
      for (const noteId of changed) publishThread(noteId);
    },
    waitForAIRequest,
    registerAgent,
    stop
  };
}

const presenceTools = new Set(['terminal', 'step', 'decision', 'note', 'connect', 'laser', 'bend']);
function readPresence(data, ai = false) {
  const point = Array.isArray(data?.point) && data.point.length === 2 && data.point.every(Number.isFinite) ? data.point : null;
  const focus = typeof data?.focus === 'string' && data.focus.length <= 128 ? data.focus : null;
  const laser = Array.isArray(data?.laser) ? data.laser.slice(-40).filter(sample =>
    Array.isArray(sample) && sample.length === 4 && Number.isSafeInteger(sample[0]) && sample[0] > 0 &&
    Number.isFinite(sample[1]) && Number.isFinite(sample[2]) && typeof sample[3] === 'boolean') : [];
  const tool = presenceTools.has(data?.tool) ? data.tool : undefined;
  const draft = data?.draft;
  const validDraft = draft && typeof draft.id === 'string' && draft.id.length <= 128 &&
    typeof draft.text === 'string' && (draft.type === 'edge'
      ? Number.isSafeInteger(draft.index) && typeof draft.to === 'string' && draft.to.length <= 128
      : presenceTools.has(draft.type) && Array.isArray(draft.position) &&
        draft.position.length === 2 && draft.position.every(Number.isFinite));
  const activity = ai && typeof data?.activity === 'string' ? data.activity.slice(0, 200) : undefined;
  return { point, focus, ...(laser.length ? { laser } : {}), ...(tool ? { tool } : {}),
    ...(validDraft ? { draft: { id: draft.id, type: draft.type, text: draft.text.slice(0, 4000),
      ...(draft.type === 'edge' ? { index: draft.index, to: draft.to } : { position: draft.position }) } } : {}),
    ...(activity ? { activity } : {}) };
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

export async function connectLiveBoard(invite, host, handlers) {
  const { joinRoom } = await import('./vendor/p2p-core/p2p-core.js');
  const role = host ? 'host' : 'editor';
  const room = joinRoom({ app: 'mini-flow-live', ...invite, mode: 'online', protocol: 3, maxPeers: host ? maxGuests : 1,
    server: liveRelayUrl ? { url: liveRelayUrl, roomInUrl: true } : false,
    maxMessageBytes: 256 * 1024, rateLimit: 60, kinds, profile: { role }, debug: handlers.debug === true,
    acceptPeer: peer => peer.profile?.role === (host ? 'editor' : 'host') });
  if (handlers.onNetworkStatus) {
    room.onStatus(handlers.onNetworkStatus);
    handlers.onNetworkStatus(room.status());
  }
  const session = createLiveSession({ ...handlers, room, host });
  return { ...session, debugReport: room.debugReport };
}

export function newLiveInvite() {
  return { room: id(), password: id() };
}
