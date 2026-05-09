import test from "node:test";
import assert from "node:assert/strict";
import { MSG, WristClawCrypto, buildJoinFrame, decodePacket, encodePacket } from "../protocol.js";

const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

test("join frame uses session UUID bytes and host role", () => {
  const frame = buildJoinFrame(SESSION_ID);
  assert.equal(frame.length, 17);
  assert.equal(frame.subarray(0, 16).toString("hex"), "0123456789abcdef0123456789abcdef");
  assert.equal(frame[16], 0);
});

test("packet encode/decode round-trips little-endian fields", () => {
  const packet = encodePacket({
    sessionId: SESSION_ID,
    type: MSG.TEXT_INPUT,
    seq: 42,
    nonce: Buffer.from("000102030405060708090a0b", "hex"),
    ciphertext: Buffer.from("hello")
  });
  const decoded = decodePacket(packet);
  assert.equal(decoded.sessionId, SESSION_ID);
  assert.equal(decoded.type, MSG.TEXT_INPUT);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.nonce.toString("hex"), "000102030405060708090a0b");
  assert.equal(decoded.ciphertext.toString(), "hello");
});

test("x25519/chacha20-poly1305 peers can exchange encrypted payloads", () => {
  const host = new WristClawCrypto();
  const watch = new WristClawCrypto();
  host.completeHandshake(watch.publicKeyRaw);
  watch.completeHandshake(host.publicKeyRaw);

  const sealed = host.encrypt(Buffer.from("short watch reply"));
  assert.equal(watch.decrypt(sealed.nonce, sealed.ciphertext).toString(), "short watch reply");
});
