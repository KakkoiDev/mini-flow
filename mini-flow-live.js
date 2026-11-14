import { createHostKey, deriveRoomKey, hostSigner, secureRoom, verifyHostProfile } from './mini-flow-secure-room.js?v=agent-run-2';

const kinds = ['read', 'state', 'edit', 'end', 'presence', 'ask'];
const maxGuests = 8;
const maxAgents = 8;
const liveProtocol = 5;
const maxMessageBytes = 360 * 1024;
const threadPageSize = 12;
export const maxThreadMessages = 200;
const commentRateWindowMs = 60_000;
const commentRateLimit = 20;
export const maxReplyLength = 1000;
export const maxAnswerLength = 2000;
export const defaultRelayUrl = 'wss://p2p-core-cloudflare.kakkoidev.workers.dev';
const invitePattern = /^#live=([a-f0-9]{32})\.([a-f0-9]{32})(?:&relay=([^&]+))?(?:&host=([A-Za-z0-9_-]{43}))?$/;
const id = () => crypto.randomUUID().replaceAll('-', '');

export function normalizeLiveRelay(value) {
  const url = new URL(value.trim());
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a secure WebSocket relay URL without credentials, a query, or a fragment.');
  }
  return url.href;
}

export function readLiveInvite(hash) {
  const match = hash.match(invitePattern);
  if (!match) return null;
  try {
    return { room: match[1], password: match[2], ...(match[3] && { relay: normalizeLiveRelay(decodeURIComponent(match[3])) }),
      ...(match[4] && { host: match[4] }) };
  } catch { return null; }
}

export function liveInviteHash({ room, password, relay, host }) {
  return `#live=${room}.${password}${relay ? '&relay=' + encodeURIComponent(relay) : ''}${host ? '&host=' + host : ''}`;
}

// Adds the host signing key to a new invite. Keep hostKey private: liveInviteHash shares only its fingerprint.
export async function withHostKey(invite) {
  return { ...invite, ...await createHostKey() };
}

export function readThreadMessages(messages, assignIds = false) {
  if (!Array.isArray(messages) || !messages.length) return null;
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

// Reply ownership is a hash of a secret only the author's tab holds, so a peer that
// reuses another participant's transport ID cannot manage that participant's replies.
export async function ownerTag(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mini-flow-owner:' + secret));
  return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canManageReply(message, host, selfId) {
  return Boolean(message?.replyId && !message.original &&
    (host ? message.role !== 'status' : message.role === 'user' && selfId && message.owner === selfId));
}

export function changeThreadReply(messages, { replyId, previousText, text }, host, selfId) {
  const message = messages.find(item => item.replyId === replyId);
  if (!message) return failure('reply_missing', 'This comment is no longer in the conversation.');
  if (!canManageReply(message, host, selfId)) return failure('reply_forbidden', 'You can only change your own comments.');
  if (message.text !== previousText) return failure('reply_changed', 'This comment changed. Reopen it to try again.');
  if (text === null) return { ok: true, messages: messages.filter(item => item !== message) };
  const limit = message.role === 'assistant' ? maxAnswerLength : maxReplyLength;
  if (typeof text !== 'string' || !text.trim() || text.length > limit) {
    return failure('invalid_reply', 'Enter a comment of up to ' + limit + ' characters.');
  }
  if (text.trim() === message.text) return { ok: true, messages };
  const edited = host && (!selfId || message.owner !== selfId) && !['Host', 'You'].includes(message.author) ? 'host' : 'author';
  return { ok: true, messages: messages.map(item => item === message ? { ...item, text: text.trim(), edited } : item) };
}

export function createLiveSession({ room, host, getProject, setProject, normalize, canAccept, onStatus, onEnd,
  onAvailability = () => {}, onPresence = () => {}, onGuestCounts = () => {}, readNote = () => null,
  noteIds = () => [], onNoteColors = () => {}, onAIRequests = () => {}, onAIThread = () => {}, initialThreads = [],
  onCheckpoint = () => {}, onAIRequest, onAgentMessage, onAgentLeave = () => {} }) {
  // AI agents connect with the mini-flow-agent helper. They talk only to the host and never see guests' traffic.
  const agentPeers = new Set();
  let agentSummary = [];
  let departedHost; // [{ name, listening }] set by the host page, shown to everyone
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
  // The host page hands AI requests to connected agents and sets their status here for guests to see.
  let aiRequests = {};
  const ownerSecret = host ? undefined : id();
  let selfOwner = host ? room.selfId : undefined;
  if (!host) ownerTag(ownerSecret).then(tag => { selfOwner = tag; }).catch(() => {});
  const pendingAsks = new Map();
  const epoch = host ? id() : undefined;
  let hostEpoch;
  function checkpoint() {
    if (!host || closed) return;
    onCheckpoint({ project: getProject(), threads: [...threads] });
  }
  const threads = new Map(host ? initialThreads : []);
  const deletedThreads = new Map();
  if (host) for (const [noteId, messages] of threads) {
    if (readNote(getProject(), noteId)) continue;
    deletedThreads.set(noteId, messages);
    threads.delete(noteId);
  }
  const threadVersions = new Map();
  const incomingThreads = new Map();
  let nextGuestNumber = 0;
  function reserveGuestNumbers(entries) {
    for (const messages of entries.values()) for (const { author } of messages) {
      const number = Number(author.match(/^(?:Guest|AI) (\d+)$/)?.[1]);
      if (Number.isSafeInteger(number)) nextGuestNumber = Math.max(nextGuestNumber, number);
    }
  }
  reserveGuestNumbers(threads);

  async function publishThread(noteId, to) {
    const messages = threads.get(noteId);
    const revision = threadVersions.get(noteId) ?? 0;
    const pages = Math.max(1, Math.ceil((messages?.length ?? 0) / threadPageSize));
    try {
      for (let page = 0; page < pages; page++) {
        if (closed || (threadVersions.get(noteId) ?? 0) !== revision) return;
        await send('ask', { type: 'thread', noteId, revision, page, pages,
          messages: messages?.slice(page * threadPageSize, (page + 1) * threadPageSize) }, to);
        if (page + 1 < pages) await new Promise(resolve => setTimeout(resolve, 30));
      }
    } catch {}
  }

  function receiveThread(data) {
    const { noteId, revision, page, pages } = data;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(pages) || pages < 1 ||
      !Number.isSafeInteger(page) || page < 0 || page >= pages) return;
    let entry = incomingThreads.get(noteId);
    if (!entry || revision > entry.revision) {
      entry = { revision, pages, chunks: new Map() };
      incomingThreads.set(noteId, entry);
    }
    if (entry.revision !== revision || entry.pages !== pages || entry.done) return;
    const messages = data.messages === undefined && pages === 1 ? [] : readThreadMessages(data.messages);
    if (!messages || messages.length > threadPageSize) return;
    entry.chunks.set(page, messages);
    if (entry.chunks.size !== pages) return;
    const all = [...entry.chunks].sort(([a], [b]) => a - b).flatMap(([, chunk]) => chunk);
    entry.done = true;
    entry.chunks.clear();
    if (all.length) threads.set(noteId, all);
    else threads.delete(noteId);
    onAIThread(noteId, all.length ? all : null);
  }

  function updateThread(noteId, messages) {
    threadVersions.set(noteId, (threadVersions.get(noteId) ?? 0) + 1);
    if (messages.length) threads.set(noteId, messages);
    else threads.delete(noteId);
    checkpoint();
    onAIThread(noteId, messages.length ? messages : null);
    publishThread(noteId);
  }

  function appendThread(noteId, message) {
    const entry = { ...message, replyId: id() };
    const capped = messages => messages.length > maxThreadMessages ? messages.slice(-maxThreadMessages) : messages;
    if (deletedThreads.has(noteId)) {
      deletedThreads.set(noteId, capped([...deletedThreads.get(noteId), entry]));
    } else {
      updateThread(noteId, capped([...(threads.get(noteId) ?? []), entry]));
    }
  }

  function commentRejection(noteId, from) {
    if ((threads.get(noteId)?.length ?? 0) >= maxThreadMessages) {
      return failure('thread_full', 'This conversation has reached ' + maxThreadMessages + ' messages. Start a new note to continue.');
    }
    const guest = guests.get(from);
    if (!guest) return null;
    const now = Date.now();
    guest.commentTimes = (guest.commentTimes ?? []).filter(time => now - time < commentRateWindowMs);
    if (guest.commentTimes.length >= commentRateLimit) {
      return failure('too_many_comments', 'You are commenting too quickly. Wait a minute and try again.');
    }
    guest.commentTimes.push(now);
    return null;
  }

  function manageReply(noteId, from, change, owner) {
    const messages = threads.get(noteId) ?? [];
    const result = changeThreadReply(messages, change, from === room.selfId, owner);
    if (!result.ok) return result;
    updateThread(noteId, result.messages);
    return { ok: true };
  }

  async function forwardAIRequest(noteId, from, prompt, owner) {
    const note = readNote(getProject(), noteId);
    if (!note) return failure('note_missing', 'The note is no longer on the board.');
    if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > maxReplyLength)) {
      return failure('invalid_reply', 'Enter a comment of up to 1000 characters.');
    }
    const thread = threads.get(noteId);
    const addsMessage = !thread || prompt !== undefined;
    if (addsMessage) {
      const rejected = commentRejection(noteId, from);
      if (rejected) return rejected;
    }
    const requester = guests.get(from)?.label ?? 'Host';
    const text = prompt?.trim() ?? thread?.findLast(message => message.role === 'user')?.text ?? note.text;
    if (!onAIRequest) return failure('ai_unavailable', 'Connect AI agents in Live session before asking.');
    const result = await onAIRequest({ noteId, note: { ...note, text }, prompt: text, requester, thread: thread ?? [] });
    if (!result?.ok) return result ?? failure('ai_unavailable', 'No AI agent took the request.');
    if (addsMessage) {
      appendThread(noteId, { role: 'user', author: requester, owner, text, ...(!thread && prompt === undefined && { original: true }) });
    }
    return { ok: true };
  }

  function appendComment(noteId, from, text, owner) {
    if (!readNote(getProject(), noteId)) return failure('note_missing', 'The note is no longer on the board.');
    if (typeof text !== 'string' || !text.trim() || text.length > maxReplyLength) {
      return failure('invalid_reply', 'Enter a comment of up to 1000 characters.');
    }
    const rejected = commentRejection(noteId, from);
    if (rejected) return rejected;
    appendThread(noteId, { role: 'user', author: guests.get(from)?.label ?? 'Host', owner, text: text.trim() });
    return { ok: true };
  }

  function handleNoteMessage(type, noteId, from, value, owner) {
    if (type === 'comment') return appendComment(noteId, from, value, owner);
    if (type === 'manage_reply') return manageReply(noteId, from, value ?? {}, owner);
    return forwardAIRequest(noteId, from, value, owner);
  }

  function canSendNoteMessage() {
    return !closed && Boolean(state && (host || hostPeer));
  }

  function submitNoteMessage(type, noteId, prompt) {
    if (!canSendNoteMessage()) {
      return Promise.resolve(failure('live_not_ready', 'The live board is disconnected.'));
    }
    if (host) return Promise.resolve(handleNoteMessage(type, noteId, room.selfId, prompt, room.selfId));
    if (pendingAsks.size >= 8) return Promise.resolve(failure('too_many_requests', 'Wait for a pending request to finish.'));
    return new Promise(resolve => {
      const requestId = id();
      const finish = result => {
        clearTimeout(timer);
        pendingAsks.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish(failure('ask_timeout', 'The host did not confirm the request.')),
        type === 'request' ? 20000 : 5000);
      pendingAsks.set(requestId, finish);
      send('ask', { type, requestId, noteId, prompt, owner: ownerSecret }).catch(() =>
        finish(failure('ask_failed', 'Could not send the request to the host.')));
    });
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
      deletedThreads.set(noteId, threads.get(noteId));
      updateThread(noteId, []);
    }
    for (const [noteId, messages] of deletedThreads) {
      if (!after.has(noteId)) continue;
      deletedThreads.delete(noteId);
      updateThread(noteId, messages);
    }
    for (const note of noteColors.keys()) if (!after.has(note)) noteColors.delete(note);
    for (const note of after) if (!before.has(note) && color) noteColors.set(note, color);
    onNoteColors(Object.fromEntries(noteColors));
    state = { revision: state.revision + 1, project };
    checkpoint();
    return true;
  }

  function publish(extra = {}, to = [...guests.keys()]) {
    if (Array.isArray(to) && !to.length) return;
    send('state', { ...state, epoch, threadIds: [...threads.keys()], noteColors: Object.fromEntries(noteColors), ...extra }, to)
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
      send('edit', { id: request.id, revision: state.revision, epoch: hostEpoch, project, message }).catch(() => {
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
    return { human: guests.size, agents: agentSummary };
  }

  function presenceSnapshot() {
    return [{ id: room.selfId, label: 'Host', ...presence },
      ...Array.from(guests, ([id, guest]) => ({ id, label: guest.label, color: guest.color, ...guest.presence }))];
  }

  function publishPresence() {
    if (!host) return;
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
    if (host && room.peer?.(from)?.profile?.role === 'agent') {
      agentPeers.add(from);
      return;
    }
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
      onStatus('Receiving the board…');
      send('read', null).catch(() => onStatus('Could not request the board.'));
    }
  });
  room.onPeerLeave(from => {
    if (closed) return;
    if (host && agentPeers.delete(from)) {
      onAgentLeave(from);
      return;
    }
    if (host) {
      if (!guests.delete(from)) return;
      checkpoint();
      reportGuestCount();
      if (guests.size) publishPresence();
      else onPresence([]);
      return;
    }
    if (from !== hostPeer) return;
    departedHost = from;
    hostPeer = undefined;
    finish(failure('live_disconnected', 'The other tab disconnected.'));
    state = undefined;
    presenceRevision = 0;
    deferredState = undefined;
    localDirty = false;
    available();
    onPresence([]);
    onGuestCounts(null);
    onNoteColors({});
    onAIRequests({});
    onStatus('Reconnecting… You can also leave to keep editing a copy.');
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
  room.onMessage('edit', async (data, from) => {
    if (!host || !guests.has(from) || closed || typeof data?.id !== 'string') return;
    if (data.epoch !== epoch || data.revision !== state.revision) {
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
      const project = normalize(data.project);
      install(project, message);
      const changed = refresh(guest.color);
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
        if (!state && Array.isArray(data.threadIds)) {
          for (const noteId of threads.keys()) if (!data.threadIds.includes(noteId)) {
            threads.delete(noteId);
            onAIThread(noteId, null);
          }
        }
        hostEpoch = data.epoch;
        onNoteColors(Object.fromEntries(Object.entries(data.noteColors ?? {}).filter(([id, color]) =>
          Object.hasOwn(project.positions, id) && Number.isSafeInteger(color) && color > 0)));
        install(project, data.ok === false ? undefined : data.message);
        state = { revision: data.revision, project };
      } catch {
        onStatus('Could not read the live board.');
        return;
      }
    }
    if (pending && data.id === pending.id) {
      finish(data.ok ? { ok: true } : failure(data.reason, data.message));
    }
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
      if (Number.isInteger(data.counts?.human) && data.counts.human >= 0 && data.counts.human <= maxGuests) {
        onGuestCounts({ human: data.counts.human, agents: readAgentSummary(data.counts.agents) });
      }
      onPresence(data.peers.slice(0, maxGuests + 1).filter(item => typeof item?.id === 'string' &&
        item.id !== room.selfId && typeof item.label === 'string').map(item => ({
        id: item.id, label: item.label.slice(0, 32),
        ...(Number.isSafeInteger(item.color) && item.color > 0 ? { color: item.color } : {}),
        ...readPresence(item)
      })));
      onAIRequests(Object.fromEntries(Object.entries(data.aiRequests ?? {}).slice(0, 64)
        .filter(([id, status]) => id.length <= 128 && (typeof status === 'string' && status.length <= 32 ||
          ['waiting', 'working', 'interrupted', 'result'].includes(status?.phase) &&
          typeof status.label === 'string' && status.label.length <= 200))));
    }
  });
  room.onMessage('ask', async (data, from) => {
    if (closed) return;
    if (host && agentPeers.has(from)) {
      if (data?.type !== 'agent' || typeof data.id !== 'string' || data.id.length > 64 || typeof data.op !== 'string') return;
      let result;
      try {
        result = onAgentMessage ? await onAgentMessage(data, from) : failure('agents_unavailable', 'This board does not accept AI agents.');
      } catch {
        result = failure('agent_error', 'The board could not handle the request.');
      }
      if (!closed && agentPeers.has(from)) send('ask', { type: 'agent_result', id: data.id, result }, from).catch(() => {});
      return;
    }
    if (host) {
      if (!guests.has(from) || !['request', 'comment', 'manage_reply'].includes(data?.type) ||
          typeof data.noteId !== 'string' || data.noteId.length > 128 ||
          typeof data.requestId !== 'string' || data.requestId.length !== 32) return;
      const owner = typeof data.owner === 'string' && /^[a-f0-9]{32}$/.test(data.owner) ? await ownerTag(data.owner) : undefined;
      const result = owner ? await handleNoteMessage(data.type, data.noteId, from, data.prompt, owner)
        : failure('invalid_request', 'Reload the page to rejoin the live session.');
      await send('ask', { type: 'result', requestId: data.requestId, result }, from).catch(() => {});
    } else if (from === hostPeer && data?.type === 'result') {
      pendingAsks.get(data.requestId)?.(data.result);
    } else if (from === hostPeer && data?.type === 'thread' &&
      typeof data.noteId === 'string' && data.noteId.length <= 128) {
      receiveThread(data);
    }
  });
  // The host sends end just before leaving, so it can arrive after the leave.
  room.onMessage('end', (_, from) => {
    if (!host && (from === hostPeer || from === departedHost) && !closed) stop(false);
  });

  function stop(notify = true, ended = true) {
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
    for (const resolve of pendingAsks.values()) resolve(failure('live_disconnected', 'The live connection ended.'));
    available();
    onPresence([]);
    onGuestCounts(null);
    onNoteColors({});
    onAIRequests({});
    if (!host) threads.clear();
    if (ended) onEnd();
  }

  onStatus(host ? 'Waiting for guests…' : 'Waiting for the host…');
  if (host) { onGuestCounts(guestCounts()); publishPresence(); }
  available();
  return {
    host,
    canManageReply: message => canManageReply(message, host, selfOwner),
    canSendNoteMessage,
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
    askAI: (noteId, prompt) => submitNoteMessage('request', noteId, prompt),
    setAgents(next) {
      if (!host || closed) return;
      agentSummary = readAgentSummary(next);
      onGuestCounts(guestCounts());
      publishPresence();
    },
    setAIRequests(next) {
      if (!host || closed) return;
      aiRequests = Object.fromEntries(Object.entries(next).slice(0, 64));
      publishPresence();
    },
    appendAIMessage(noteId, message) {
      if (!host || closed || !readNote(getProject(), noteId)) return false;
      appendThread(noteId, message);
      return true;
    },
    comment: (noteId, text) => submitNoteMessage('comment', noteId, text),
    manageReply: (noteId, change) => submitNoteMessage('manage_reply', noteId, change),
    replaceThreads(next) {
      if (!host || closed) return;
      const changed = new Set([...threads.keys(), ...next.keys()]);
      threads.clear();
      deletedThreads.clear();
      for (const [noteId, messages] of next) threads.set(noteId, messages);
      reserveGuestNumbers(threads);
      checkpoint();
      for (const noteId of changed) {
        threadVersions.set(noteId, (threadVersions.get(noteId) ?? 0) + 1);
        publishThread(noteId);
      }
    },
    suspend: () => { checkpoint(); stop(false, false); },
    checkpoint,
    stop
  };
}

const presenceTools = new Set(['terminal', 'step', 'decision', 'note', 'connect', 'laser', 'bend']);
function readAgentSummary(agents) {
  return Array.isArray(agents) ? agents.slice(0, 32).filter(agent => typeof agent?.name === 'string' && agent.name.length <= 40)
    .map(agent => ({ name: agent.name, listening: agent.listening === true })) : [];
}

function readPresence(data) {
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
  return { point, focus, ...(laser.length ? { laser } : {}), ...(tool ? { tool } : {}),
    ...(validDraft ? { draft: { id: draft.id, type: draft.type, text: draft.text.slice(0, 4000),
      ...(draft.type === 'edge' ? { index: draft.index, to: draft.to } : { position: draft.position }) } } : {}),
  };
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

export async function connectLiveBoard(invite, host, handlers) {
  const { joinRoom, selfId } = await import('./vendor/p2p-core/p2p-core.js');
  const key = await deriveRoomKey(invite);
  const role = host ? 'host' : 'editor';
  const signer = host && invite.hostKey ? await hostSigner(invite.hostKey, invite.room, selfId) : undefined;
  const hostKeys = new Map();
  const room = joinRoom({ app: 'mini-flow-live', room: invite.room, password: invite.password, mode: 'online', protocol: liveProtocol,
    maxPeers: host ? maxGuests + maxAgents : 1,
    server: { url: invite.relay ?? defaultRelayUrl, roomInUrl: true },
    ...(invite.relay && { transports: { relays: false, pair: false } }),
    maxMessageBytes, rateLimit: 60, kinds, profile: { role, ...signer?.profile }, debug: handlers.debug === true,
    acceptPeer: async peer => {
      if (host ? !['editor', 'agent'].includes(peer.profile?.role) : peer.profile?.role !== 'host') return false;
      if (host || !invite.host) return true;
      const verified = await verifyHostProfile(peer.profile, invite.host, invite.room, peer.id);
      if (verified) hostKeys.set(peer.id, verified);
      return Boolean(verified);
    } });
  if (signer && room.selfId !== selfId) throw new Error('Could not prove the live session host.');
  if (handlers.onNetworkStatus) {
    room.onStatus(handlers.onNetworkStatus);
    handlers.onNetworkStatus(room.status());
  }
  const verifyKey = host || !invite.host ? undefined : from => hostKeys.get(from) ?? false;
  const session = createLiveSession({ ...handlers, room: secureRoom(room, key, { signKey: signer?.key, verifyKey }), host });
  return { ...session, hostVerified: !host && Boolean(invite.host), debugReport: room.debugReport };
}

// Connects an AI agent (for example the Node helper mini-flow-agent.mjs) to the host of a live session.
// The agent only reaches the host, which must be the one the invite names.
// transports overrides the default (the WebSocket relay only), for example to connect browser tabs in tests.
export async function connectAsAgent(invite, { WebSocketImpl = globalThis.WebSocket, origin, timeoutMs = 20000, onHostLeave = () => {},
  transports = { relays: false, pair: false, tabs: false } } = {}) {
  const { joinRoom } = await import('./vendor/p2p-core/p2p-core.js');
  const key = await deriveRoomKey(invite);
  const hostKeys = new Map();
  // Outside a browser, send the board's origin so the relay accepts the connection.
  const Socket = origin ? class extends WebSocketImpl {
    constructor(url, protocols) { super(url, { protocols, headers: { Origin: origin } }); }
  } : WebSocketImpl;
  // A fresh peer ID per connection: a reconnect must not be mistaken for the previous connection leaving.
  const raw = joinRoom({ app: 'mini-flow-live', room: invite.room, password: invite.password, mode: 'online', protocol: liveProtocol,
    selfId: 'agent-' + id(), maxPeers: 1, server: { url: invite.relay ?? defaultRelayUrl, roomInUrl: true, WebSocketImpl: Socket },
    transports, maxMessageBytes, rateLimit: 60, kinds, profile: { role: 'agent' },
    acceptPeer: async peer => {
      if (peer.profile?.role !== 'host') return false;
      if (!invite.host) return true;
      const verified = await verifyHostProfile(peer.profile, invite.host, invite.room, peer.id);
      if (verified) hostKeys.set(peer.id, verified);
      return Boolean(verified);
    } });
  const room = secureRoom(raw, key, { verifyKey: invite.host ? from => hostKeys.get(from) ?? false : undefined });
  const pending = new Map();
  let hostPeer;
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Could not reach the board. Ask its owner to keep the board open with its live session running.')), timeoutMs);
    raw.onPeerJoin(peer => {
      hostPeer = peer;
      clearTimeout(timer);
      resolve();
    });
  });
  raw.onPeerLeave(peer => {
    if (peer !== hostPeer) return;
    hostPeer = undefined;
    for (const call of pending.values()) call.reject(new Error('The board’s host disconnected.'));
    pending.clear();
    onHostLeave();
  });
  room.onMessage('ask', (data, from) => {
    if (from !== hostPeer || data?.type !== 'agent_result') return;
    pending.get(data.id)?.resolve(data.result);
  });
  try {
    await ready;
  } catch (error) {
    raw.leave();
    throw error;
  }
  return {
    hostVerified: Boolean(invite.host),
    call(op, body = {}, waitMs = 20000) {
      if (!hostPeer) return Promise.reject(new Error('The board’s host disconnected.'));
      const callId = id();
      return new Promise((resolve, reject) => {
        const finish = (done, value) => { clearTimeout(limit); pending.delete(callId); done(value); };
        const limit = setTimeout(() => finish(reject, new Error('The board did not answer in time.')), waitMs);
        pending.set(callId, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
        room.send('ask', { ...body, type: 'agent', op, id: callId }, hostPeer).catch(error => finish(reject, error));
      });
    },
    close() {
      clearTimeout(timer);
      raw.leave();
    }
  };
}

export function newLiveInvite(relay) {
  return { room: id(), password: id(), ...(relay && { relay: normalizeLiveRelay(relay) }) };
}
