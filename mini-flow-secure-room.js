// Encrypt application messages before p2p-core chooses a transport.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const replayWindow = 256;
function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(binary);
}
const base64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export async function deriveRoomKey({ room, password }) {
  const secret = await crypto.subtle.importKey('raw', encoder.encode(password), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room),
    info: encoder.encode('Mini Flow live messages v1')
  }, secret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function secureRoom(room, key) {
  const incoming = new Map();
  let outgoing = Promise.resolve();
  let sequence = 0;

  function parameters(iv, kind, from, recipients, counter) {
    return { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([kind, from, recipients, counter])) };
  }

  return {
    ...room,
    send(kind, data, to) {
      const recipients = Array.isArray(to) ? [...to] : to ? [to] : room.peers().map(peer => peer.id);
      if (!recipients.length) return Promise.resolve();
      const send = outgoing.then(async () => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const counter = ++sequence;
        const sealed = await crypto.subtle.encrypt(parameters(iv, kind, room.selfId, recipients, counter),
          key, encoder.encode(JSON.stringify(data)));
        await room.send(kind, [counter, recipients, bytesToBase64(iv), bytesToBase64(new Uint8Array(sealed))], recipients);
      });
      outgoing = send.catch(() => {});
      return send;
    },
    onMessage(kind, listener) {
      return room.onMessage(kind, (packet, from) => {
        if (!Array.isArray(packet) || packet.length !== 4) return;
        const [counter, recipients, nonce, ciphertext] = packet;
        if (!Number.isSafeInteger(counter) || counter < 1 || !Array.isArray(recipients) || recipients.length > 8 ||
          !recipients.every(id => typeof id === 'string' && id.length <= 128) || !recipients.includes(room.selfId) ||
          typeof nonce !== 'string' || nonce.length !== 16 || typeof ciphertext !== 'string') return;
        let peer = incoming.get(from);
        if (!peer) {
          peer = { last: 0, seen: new Set(), pending: Promise.resolve() };
          incoming.set(from, peer);
        }
        peer.pending = peer.pending.then(async () => {
          if (counter <= peer.last - replayWindow || peer.seen.has(counter)) return;
          const plaintext = await crypto.subtle.decrypt(
            parameters(base64ToBytes(nonce), kind, from, recipients, counter), key, base64ToBytes(ciphertext));
          if (!room.peer(from)) return;
          peer.last = Math.max(peer.last, counter);
          peer.seen.add(counter);
          for (const previous of peer.seen) if (previous <= peer.last - replayWindow) peer.seen.delete(previous);
          // The callback may send another message. Avoid blocking subsequent receives on it.
          Promise.resolve(listener(JSON.parse(decoder.decode(plaintext)), from)).catch(() => {});
        }).catch(() => {}); // Invalid ciphertext is never delivered to the app.
      });
    }
  };
}
