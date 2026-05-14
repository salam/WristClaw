import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePacket, encodePacket } from "../protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(__dirname, "..", "..", "docs", "protocol", "test-vectors.json");
const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));

test("vector file is version 1", () => {
  assert.equal(vectors.version, 1);
});

for (const v of vectors.packets) {
  test(`packet vector "${v.name}" encodes to the canonical bytes`, () => {
    const encoded = encodePacket({
      sessionId: v.session_id,
      type: v.type,
      seq: v.seq,
      nonce: Buffer.from(v.nonce_hex, "hex"),
      ciphertext: Buffer.from(v.ciphertext_hex, "hex")
    });
    assert.equal(encoded.toString("hex"), v.bytes_hex);
  });

  test(`packet vector "${v.name}" decodes back to its fields`, () => {
    const decoded = decodePacket(Buffer.from(v.bytes_hex, "hex"));
    assert.ok(decoded, "decode must succeed");
    assert.equal(decoded.sessionId, v.session_id);
    assert.equal(decoded.type, v.type);
    assert.equal(decoded.seq, v.seq);
    assert.equal(decoded.nonce.toString("hex"), v.nonce_hex);
    assert.equal(decoded.ciphertext.toString("hex"), v.ciphertext_hex);
  });
}

for (const v of vectors.invalid_packets) {
  test(`invalid packet "${v.name}" decodes to null (${v.reason})`, () => {
    const decoded = decodePacket(Buffer.from(v.bytes_hex, "hex"));
    assert.equal(decoded, null);
  });
}
