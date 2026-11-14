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

const toBase64Url = bytes => bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64Url = value => base64ToBytes(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
const signing = { name: 'ECDSA', namedCurve: 'P-256' };
const signature = { name: 'ECDSA', hash: 'SHA-256' };
const hostProofText = (room, peerId) => encoder.encode('mini-flow-host\n' + room + '\n' + peerId);

// The invite carries a fingerprint of the host's public key. Only the tab that created
// the invite holds the private key, so other invite holders cannot act as the host.
export async function createHostKey() {
  const pair = await crypto.subtle.generateKey(signing, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { hostKey: jwk, host: await hostFingerprint(await publicKeyFromJwk(jwk)) };
}

async function publicKeyFromJwk({ kty, crv, x, y }) {
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, signing, true, ['verify']);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

async function hostFingerprint(raw) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
}

export async function hostSigner(jwk, room, peerId) {
  const key = await crypto.subtle.importKey('jwk', jwk, signing, false, ['sign']);
  const raw = await publicKeyFromJwk(jwk);
  const proof = new Uint8Array(await crypto.subtle.sign(signature, key, hostProofText(room, peerId)));
  return { key, profile: { hostKey: toBase64Url(raw), hostProof: toBase64Url(proof) } };
}

// Returns the host's verification key when the profile matches the invite fingerprint
// and proves ownership of this peer ID, otherwise null.
export async function verifyHostProfile(profile, fingerprint, room, peerId) {
  try {
    if (typeof profile?.hostKey !== 'string' || typeof profile.hostProof !== 'string' ||
      profile.hostKey.length > 128 || profile.hostProof.length > 128) return null;
    const raw = fromBase64Url(profile.hostKey);
    if (await hostFingerprint(raw) !== fingerprint) return null;
    const key = await crypto.subtle.importKey('raw', raw, signing, false, ['verify']);
    return await crypto.subtle.verify(signature, key, fromBase64Url(profile.hostProof), hostProofText(room, peerId)) ? key : null;
  } catch { return null; }
}

export async function deriveRoomKey({ room, password }) {
  const secret = await crypto.subtle.importKey('raw', encoder.encode(password), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room),
    info: encoder.encode('Mini Flow live messages v1')
  }, secret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// signKey signs every outgoing packet. verifyKey(from) returns the key a sender's packets
// must be signed with, false to drop the sender's packets, or undefined to skip the check.
export function secureRoom(room, key, { signKey, verifyKey } = {}) {
  const incoming = new Map();
  let outgoing = Promise.resolve();
  let sequence = 0;

  function signedBytes(kind, from, [counter, recipients, nonce, ciphertext]) {
    return encoder.encode(JSON.stringify([kind, from, recipients, counter, nonce, ciphertext]));
  }

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
        const packet = [counter, recipients, bytesToBase64(iv), bytesToBase64(new Uint8Array(sealed))];
        if (signKey) {
          packet.push(bytesToBase64(new Uint8Array(await crypto.subtle.sign(signature, signKey,
            signedBytes(kind, room.selfId, packet)))));
        }
        await room.send(kind, packet, recipients);
      });
      outgoing = send.catch(() => {});
      return send;
    },
    onMessage(kind, listener) {
      return room.onMessage(kind, (packet, from) => {
        if (!Array.isArray(packet) || packet.length < 4 || packet.length > 5) return;
        const [counter, recipients, nonce, ciphertext, signed] = packet;
        if (signed !== undefined && (typeof signed !== 'string' || signed.length > 128)) return;
        if (!Number.isSafeInteger(counter) || counter < 1 || !Array.isArray(recipients) || recipients.length > 8 ||
          !recipients.every(id => typeof id === 'string' && id.length <= 128) || !recipients.includes(room.selfId) ||
          typeof nonce !== 'string' || nonce.length !== 16 || typeof ciphertext !== 'string') return;
        let peer = incoming.get(from);
        if (!peer) {
          peer = { last: 0, seen: new Set(), pending: Promise.resolve() };
          incoming.set(from, peer);
        }
        // Judge the sender when the message arrives: a message sent just before leaving still counts.
        const present = Boolean(room.peer(from));
        peer.pending = peer.pending.then(async () => {
          if (counter <= peer.last - replayWindow || peer.seen.has(counter)) return;
          const expected = verifyKey?.(from);
          if (expected === false) return;
          if (expected && (signed === undefined || !await crypto.subtle.verify(signature, expected,
            base64ToBytes(signed), signedBytes(kind, from, packet)))) return;
          const plaintext = await crypto.subtle.decrypt(
            parameters(base64ToBytes(nonce), kind, from, recipients, counter), key, base64ToBytes(ciphertext));
          if (!present) return;
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
