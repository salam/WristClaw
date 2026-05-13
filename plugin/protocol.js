import { createCipheriv, createDecipheriv, diffieHellman, hkdfSync, randomBytes, generateKeyPairSync } from "node:crypto";

export const MSG = Object.freeze({
  HANDSHAKE: 0x01,
  AUDIO_INPUT: 0x02,
  TEXT_INPUT: 0x03,
  AUDIO_RESPONSE: 0x04,
  TEXT_RESPONSE: 0x05,
  IMAGE_THUMBNAIL: 0x06,
  ACK: 0x07,
  HEARTBEAT: 0x08,
  DISCONNECT: 0x09,
  EXT_DEFINE: 0x0a,
  EXT_REMOVE: 0x0b,
  EXT_RESPONSE: 0x0c,
  EXT_INVOKE: 0x0d,
  CONTEXT: 0x0e,
  CONFIG: 0x0f,
  LOCAL_ACTION: 0x10
});

export const HEADER_SIZE = 37;
export const JOIN_ROLE_HOST = 0;
export const HKDF_INFO = Buffer.from("WristClaw-v1", "utf8");
export const HKDF_SALT = Buffer.alloc(32);

export function uuidToBytes(uuid) {
  const normalized = String(uuid).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`Invalid WristClaw session UUID: ${uuid}`);
  }
  return Buffer.from(normalized.replaceAll("-", ""), "hex");
}

export function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  if (hex.length !== 32) throw new Error("Invalid UUID byte length");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildJoinFrame(sessionId) {
  return Buffer.concat([uuidToBytes(sessionId), Buffer.from([JOIN_ROLE_HOST])]);
}

export function encodePacket({ sessionId, type, seq, nonce = Buffer.alloc(12), ciphertext = Buffer.alloc(0) }) {
  const body = Buffer.from(ciphertext);
  const header = Buffer.alloc(HEADER_SIZE);
  uuidToBytes(sessionId).copy(header, 0);
  header[16] = type;
  header.writeUInt32LE(seq >>> 0, 17);
  header.writeUInt32LE(body.length, 21);
  Buffer.from(nonce).copy(header, 25);
  return Buffer.concat([header, body]);
}

export function decodePacket(data) {
  const buf = Buffer.from(data);
  if (buf.length < HEADER_SIZE) return null;
  const payloadLen = buf.readUInt32LE(21);
  if (buf.length !== HEADER_SIZE + payloadLen) return null;
  return {
    sessionId: bytesToUuid(buf.subarray(0, 16)),
    type: buf[16],
    seq: buf.readUInt32LE(17),
    nonce: buf.subarray(25, 37),
    ciphertext: buf.subarray(HEADER_SIZE)
  };
}

function rawX25519PublicKey(keyObject) {
  return keyObject.export({ format: "der", type: "spki" }).subarray(-32);
}

function rawX25519PrivateKey(keyObject) {
  return keyObject.export({ format: "der", type: "pkcs8" }).subarray(-32);
}

function keyObjectFromRawPrivate(raw) {
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  return createPrivateKeyCompat(Buffer.concat([prefix, Buffer.from(raw)]));
}

function keyObjectFromRawPublic(raw) {
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return createPublicKeyCompat(Buffer.concat([prefix, Buffer.from(raw)]));
}

function createPrivateKeyCompat(der) {
  return globalThis.__wristclawCreatePrivateKey(der);
}

function createPublicKeyCompat(der) {
  return globalThis.__wristclawCreatePublicKey(der);
}

export class WristClawCrypto {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.sharedKey = null;
  }

  get publicKeyRaw() {
    return rawX25519PublicKey(this.publicKey);
  }

  completeHandshake(peerPublicKeyRaw) {
    const secret = diffieHellman({
      privateKey: this.privateKey,
      publicKey: keyObjectFromRawPublic(peerPublicKeyRaw)
    });
    this.sharedKey = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
  }

  encrypt(plaintext) {
    if (!this.sharedKey) throw new Error("WristClaw crypto is not paired");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", this.sharedKey, nonce, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
    return { nonce, ciphertext };
  }

  decrypt(nonce, ciphertext) {
    if (!this.sharedKey) throw new Error("WristClaw crypto is not paired");
    const buf = Buffer.from(ciphertext);
    if (buf.length < 16) throw new Error("Malformed WristClaw ciphertext");
    const decipher = createDecipheriv("chacha20-poly1305", this.sharedKey, Buffer.from(nonce), { authTagLength: 16 });
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
  }
}

// Node exposes createPrivateKey/createPublicKey as functions, but keeping these
// indirections makes unit tests able to monkey-patch DER import if needed.
import { createPrivateKey, createPublicKey } from "node:crypto";
globalThis.__wristclawCreatePrivateKey ??= (der) => createPrivateKey({ key: der, format: "der", type: "pkcs8" });
globalThis.__wristclawCreatePublicKey ??= (der) => createPublicKey({ key: der, format: "der", type: "spki" });

export const _private = {
  rawX25519PrivateKey,
  keyObjectFromRawPrivate,
  keyObjectFromRawPublic
};
