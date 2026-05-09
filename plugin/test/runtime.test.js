import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyWristClawAccountConfig,
  buildWristClawPrompt,
  classifyMediaType,
  formatAmbientContext,
  loadExtensionDefinitions,
  resolveWristClawAccount
} from "../wristclaw-runtime.js";
import { MSG } from "../protocol.js";

test("setup config maps OpenClaw generic --url and --token into a wristclaw account", () => {
  const cfg = applyWristClawAccountConfig({
    cfg: {},
    accountId: "default",
    input: {
      url: "wss://relay.wristwatch.app/ws",
      token: "01234567-89ab-cdef-0123-456789abcdef",
      name: "Watch"
    }
  });
  const account = resolveWristClawAccount(cfg, "default");
  assert.equal(account.relayUrl, "wss://relay.wristwatch.app/ws");
  assert.equal(account.sessionId, "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(account.name, "Watch");
  assert.equal(account.terse, true);
});

test("ambient context keeps unavailable signals explicit", () => {
  const lines = formatAmbientContext({
    ts: "2026-05-08T08:00:00Z",
    location: { status: "disabled", reason: "user disabled" },
    nowPlaying: { status: "ok", title: "Song", artist: "Artist" },
    battery: { status: "ok", level: 0.42, charging: false },
    connectivity: { status: "pending", reason: "starting" },
    heartRate: { status: "ok", bpm: 77, measuredAt: "now" }
  });
  assert(lines.includes("- location: disabled (user disabled)"));
  assert(lines.includes("- now playing: Song - Artist"));
  assert(lines.includes("- battery: 42% (on battery)"));
  assert(lines.includes("- connectivity: pending (starting)"));
});

test("prompt encodes watch brevity and supported modes", () => {
  const prompt = buildWristClawPrompt({
    userText: "What now?",
    ambientContext: {},
    terse: true
  });
  assert.match(prompt, /surface: Apple Watch/);
  assert.match(prompt, /supported outbound modes: text, audio, image thumbnails, and extension-scoped responses/);
  assert.match(prompt, /default style: concise/);
  assert.match(prompt, /\[user message\]\nWhat now\?/);
});

test("extension loader strips invalid entries but keeps agent prompts for runtime use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wristclaw-ext-"));
  const file = path.join(dir, "extensions.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "ext-one", title: "One", agentPrompt: "Do one" }, { title: "bad" }]));
  const extensions = loadExtensionDefinitions(file);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].agentPrompt, "Do one");
});

test("media content types map to watch response frames", () => {
  assert.equal(classifyMediaType("audio/mp4"), MSG.AUDIO_RESPONSE);
  assert.equal(classifyMediaType("image/jpeg"), MSG.IMAGE_THUMBNAIL);
  assert.equal(classifyMediaType("application/pdf"), MSG.TEXT_RESPONSE);
});
