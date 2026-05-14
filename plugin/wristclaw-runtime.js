import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);
import { buildChannelOutboundSessionRoute, createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { dispatchReplyWithBufferedBlockDispatcher, finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { MSG, MAX_PAYLOAD_BYTES, WristClawCrypto, buildJoinFrame, decodePacket, encodePacket } from "./protocol.js";

const log = createSubsystemLogger("wristclaw");
const DEFAULT_RELAY_URL = "wss://relay.wristclaw.app/ws";
const CHANNEL = "wristclaw";

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Word-count scoring instead of "any umlaut → German". Swiss place names like
// Zürich / Rämistrasse / Bündner appear constantly in English replies and were
// falsely triggering the Karlsson German voice on otherwise-English text.
const DE_FUNCTION_WORDS = [
  "ich", "du", "er", "sie", "wir", "ihr", "die", "der", "das", "den", "dem",
  "ein", "eine", "einen", "einem", "einer", "nicht", "auch", "oder", "und",
  "für", "mit", "von", "bei", "wie", "was", "wer", "wo", "wann", "warum",
  "ist", "sind", "war", "waren", "hat", "haben", "werden", "wird", "wurde",
  "sein", "bitte", "danke", "ja", "nein", "heute", "morgen", "gestern",
  "schon", "noch", "sehr", "gut", "kann", "können", "muss", "müssen",
  "soll", "sollen", "hallo", "nochmal", "genau", "aber", "weil", "doch",
  "noch", "auf", "in", "an", "zu", "bis", "über", "unter", "nach",
];
const EN_FUNCTION_WORDS = [
  "the", "a", "an", "i", "you", "he", "she", "we", "they", "it",
  "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "may",
  "and", "or", "but", "with", "from", "to", "for", "of", "in", "on", "at",
  "by", "this", "that", "these", "those", "yes", "no", "please", "thanks",
  "not", "if", "when", "where", "what", "why", "how", "about", "into",
];

function detectLanguage(text) {
  const lower = String(text || "").toLowerCase();
  let de = 0;
  let en = 0;
  for (const w of DE_FUNCTION_WORDS) {
    const m = lower.match(new RegExp(`\\b${w}\\b`, "g"));
    if (m) de += m.length;
  }
  for (const w of EN_FUNCTION_WORDS) {
    const m = lower.match(new RegExp(`\\b${w}\\b`, "g"));
    if (m) en += m.length;
  }
  // Umlauts and ß are a weak nudge — only count if neither side has function-word
  // evidence (covers single-word inputs like "Schöpfungstag").
  if (de === 0 && en === 0 && /[äöüÄÖÜß]/.test(text)) return "de";
  return de > en ? "de" : "en";
}

function voiceForLang(lang) {
  return lang === "de" ? "piper/karlsson" : "kokoro/af_bella";
}

// Which language a given TTS voice id belongs to. Used to override the user's
// preferred voice when the agent replies in a different language than that
// voice supports — speaking German with af_bella sounds wrong.
const VOICE_LANG = {
  "piper/karlsson": "de",
  "piper/thorsten": "de",
  "kokoro/af_bella": "en",
  "kokoro/af_alloy": "en",
  "kokoro/af_sky":   "en",
  "kokoro/af_heart": "en",
  "kokoro/am_adam":  "en",
  "kokoro/bf_emma":  "en",
};

/// Pick the voice to actually send to TTS. If the user-selected voice matches
/// the text's detected language, honor it; otherwise fall back to the default
/// voice for that language so the German karlsson doesn't read English etc.
function chooseVoice(preferredVoice, textLang) {
  if (!preferredVoice) return voiceForLang(textLang);
  const voiceLang = VOICE_LANG[preferredVoice];
  if (voiceLang && voiceLang === textLang) return preferredVoice;
  return voiceForLang(textLang);
}

// Parse [action:actionName key=value ...] markers from agent text.
// Returns { clean: string, actions: Array<{action, params}> }.
function parseLocalActions(text) {
  const actions = [];
  const clean = text.replace(/\[action:([^\]]+)\]/g, (_, body) => {
    const parts = body.trim().split(/\s+/);
    const action = parts[0];
    const params = {};
    for (const part of parts.slice(1)) {
      const eq = part.indexOf("=");
      if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
    }
    actions.push({ action, params: Object.keys(params).length ? params : undefined });
    return "";
  }).replace(/\s{2,}/g, " ").trim();
  return { clean, actions };
}
const HEADER_USER_CONTEXT = "[wristclaw]";
const HEADER_AMBIENT_CONTEXT = "[ambient context]";
const HEADER_USER_MESSAGE = "[user message]";

export const activeWristClawClients = new Map();

function packageRoot() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return path.resolve(packageRoot(), "..");
}

function defaultExtensionsPath() {
  return path.join(repoRoot(), "openclaw", "extensions.json");
}

function stateRoot() {
  return path.join(process.env.HOME ?? process.cwd(), ".openclaw", "wristclaw");
}

function defaultMediaDir() {
  return path.join(process.env.HOME ?? process.cwd(), ".openclaw", "media", "wristclaw");
}

export function normalizeSessionId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return value.toLowerCase();
}

export function resolveWristClawAccount(cfg, accountId = "default") {
  const section = cfg.channels?.wristclaw ?? {};
  const accounts = section.accounts && typeof section.accounts === "object" ? section.accounts : {};
  const key = String(accountId || section.defaultAccount || "default");
  const base = {
    ...section,
    ...(accounts[key] && typeof accounts[key] === "object" ? accounts[key] : {})
  };
  const relayUrl = String(base.relayUrl ?? base.url ?? section.relayUrl ?? section.url ?? DEFAULT_RELAY_URL).trim();
  const sessionId = normalizeSessionId(base.sessionId ?? base.token ?? section.sessionId ?? section.token);
  return {
    accountId: key,
    name: base.name,
    enabled: base.enabled !== false && section.enabled !== false,
    relayUrl,
    sessionId,
    sessionSource: sessionId ? "config" : "none",
    defaultTo: base.defaultTo ?? sessionId,
    extensionsPath: String(base.extensionsPath ?? section.extensionsPath ?? defaultExtensionsPath()),
    mediaDir: String(base.mediaDir ?? section.mediaDir ?? defaultMediaDir()),
    terse: base.terse !== false,
    replyMode: base.replyMode === "extension" ? "extension" : "watch"
  };
}

export function listWristClawAccountIds(cfg) {
  const accounts = cfg.channels?.wristclaw?.accounts;
  if (accounts && typeof accounts === "object") return Object.keys(accounts).length ? Object.keys(accounts) : ["default"];
  return ["default"];
}

export function applyWristClawAccountConfig({ cfg, accountId, input }) {
  const next = structuredClone(cfg ?? {});
  next.channels ??= {};
  const previous = next.channels.wristclaw && typeof next.channels.wristclaw === "object" ? next.channels.wristclaw : {};
  const targetAccountId = accountId || "default";
  const nextAccount = {
    ...(previous.accounts?.[targetAccountId] ?? {}),
    enabled: true
  };
  if (input.name) nextAccount.name = input.name;
  if (input.url) nextAccount.relayUrl = input.url;
  if (input.baseUrl) nextAccount.relayUrl = input.baseUrl;
  if (input.token) nextAccount.sessionId = input.token;
  if (input.secret) nextAccount.sessionId = input.secret;
  next.channels.wristclaw = {
    ...previous,
    enabled: true,
    accounts: {
      ...(previous.accounts ?? {}),
      [targetAccountId]: nextAccount
    }
  };
  return next;
}

export function validateWristClawSetupInput({ input }) {
  const relayUrl = input.url ?? input.baseUrl;
  const sessionId = input.token ?? input.secret;
  if (relayUrl && !/^wss?:\/\//i.test(relayUrl)) return "WristClaw relay URL must start with ws:// or wss://";
  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return "WristClaw session id must be a UUID";
  }
  return null;
}

export function loadExtensionDefinitions(extensionsPath) {
  try {
    const raw = fs.readFileSync(extensionsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
  } catch (err) {
    if (err?.code !== "ENOENT") log.warn(`failed loading WristClaw extensions from ${extensionsPath}: ${String(err)}`);
    return [];
  }
}

function extensionPrompt(account, extId) {
  const ext = loadExtensionDefinitions(account.extensionsPath).find((entry) => entry.id === extId);
  return ext?.agentPrompt ?? ext?.prompt ?? `[wristclaw extension invoked: ${extId}]`;
}

function visibleExtensionDefinition(ext) {
  const { agentPrompt: _agentPrompt, ...visible } = ext;
  return visible;
}

function statusLine(sig) {
  if (!sig || typeof sig !== "object") return "unavailable (no signal in snapshot)";
  const status = sig.status;
  if (!status || status === "ok") return null;
  return sig.reason ? `${status} (${sig.reason})` : status;
}

function fixed(value, digits = 5) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "?";
}

export function formatAmbientContext(ctx) {
  const input = ctx && typeof ctx === "object" ? ctx : {};
  const lines = [];
  const loc = input.location;
  const locStatus = statusLine(loc);
  lines.push(`- location: ${locStatus ?? `${fixed(loc?.lat)},${fixed(loc?.lon)} (±${Math.round(loc?.accuracyMeters ?? 0)}m)`}`);
  const nowPlaying = input.nowPlaying;
  const nowPlayingStatus = statusLine(nowPlaying);
  lines.push(`- now playing: ${nowPlayingStatus ?? `${nowPlaying?.title ?? "?"} - ${nowPlaying?.artist ?? "?"}`}`);
  const battery = input.battery;
  const batteryStatus = statusLine(battery);
  lines.push(`- battery: ${batteryStatus ?? `${Math.round((battery?.level ?? 0) * 100)}% (${battery?.charging ? "charging" : "on battery"})`}`);
  const connectivity = input.connectivity;
  const connectivityStatus = statusLine(connectivity);
  lines.push(`- connectivity: ${connectivityStatus ?? (connectivity?.kind ?? "?")}`);
  const heartRate = input.heartRate;
  const heartRateStatus = statusLine(heartRate);
  lines.push(`- heart rate: ${heartRateStatus ?? `${heartRate?.bpm ?? "?"} bpm (at ${heartRate?.measuredAt ?? "?"})`}`);
  lines.push(`- as of: ${input.ts ?? "no snapshot received yet this session"}`);
  return lines;
}

const WRISTCLAW_HEADER_SKILL_ROUTING = "[wristclaw skill routing — read FIRST]";
const WRISTCLAW_HEADER_HARD_RULES = "[wristclaw hard rules]";

/// Per-turn intent hints based on a quick keyword scan of the user text.
/// For audio inputs the userText is the literal "<media:audio>..." placeholder
/// (Claude transcribes internally), so these hints only fire on typed text.
/// The general routing block below still applies to every turn.
///
/// CRITICAL framing: skills are FILES you load via the `read` tool, NOT tools
/// you call. Multiple agent turns today failed by calling `send-image` as if
/// it were a callable tool name and burning ~7 retries on "Tool send-image
/// not found" before giving up. Spell it out every time.
function buildIntentHints(userText) {
  const t = String(userText || "").toLowerCase();
  const hits = [];
  if (/\b(picture|photo|image|foto|bild|zeig|schick|wie sieht|show me|send me)\b/.test(t)) {
    hits.push("- this prompt looks like an image request. To get instructions, call the `read` tool with the FILE PATH `/Users/gado/.openclaw/workspace/skills/send-image/SKILL.md`. Do NOT call `send-image` as a tool — there is no such tool; `send-image` is the name of a skill *file* loaded by reading it. After reading, follow the playbook (Wikimedia / Google Images via the browser tool, save to /tmp), then end your reply with a single line `MEDIA:/tmp/<file>.jpg`.");
  }
  if (/\b(wo bin ich|where am i|where is matt|standort|location|find my)\b/.test(t)) {
    hits.push("- this looks like a location query. Call `read` with path `/Users/gado/.openclaw/workspace/skills/findmyloc/SKILL.md` and follow it. (Not a tool — a SKILL.md file.)");
  }
  if (/\b(weather|wetter|regen|rain|temperatur|forecast)\b/.test(t)) {
    hits.push("- this looks like a weather query. Call `read` with path `/Users/gado/.openclaw/skills/meteoswiss/SKILL.md` for Swiss locations.");
  }
  if (/\b(powerbank|akku(pack)?|chimpy)\b/.test(t)) {
    hits.push("- this looks like a powerbank query. Call `read` with path `/Users/gado/.openclaw/skills/chimpy/SKILL.md`.");
  }
  if (/\b(am i late|bin ich (zu )?spät|next meeting|kalender|calendar)\b/.test(t)) {
    hits.push("- this looks like a calendar query. Run `exec` with `/Users/gado/bin/wrist-next-event`; it wraps `gog calendar --all --today --json`, converts UTC→local, filters past events, prints one line. Then format the reply per the script's output (CURRENT / NEXT / NONE).");
  }
  return hits;
}

export function buildWristClawPrompt({ userText, ambientContext, lang, terse = true }) {
  const lines = [
    HEADER_USER_CONTEXT,
    "- surface: Apple Watch",
    "- output contract: answer for a wrist-sized screen; keep it short unless explicitly asked for detail",
    "- supported outbound modes: text, audio, image thumbnails, and extension-scoped responses",
    "- when sending images, attach or link image media; when sending audio, prefer the channel TTS/audio payload when available",
  ];
  if (terse) lines.push("- default style: concise, direct, no filler");
  if (lang) lines.push(`- detected language: ${lang}`);

  // Skill routing — repeated each turn because the openclaw system prompt's
  // "Skills (mandatory)" rule gets lost in long conversation history; the
  // agent then defaults to raw web_search/web_fetch and gives up. Each entry
  // names the skill, its file location, and the trigger phrasing.
  lines.push(
    "",
    WRISTCLAW_HEADER_SKILL_ROUTING,
    "**Skills are markdown FILES, not tools.** To load a skill's instructions, call the `read` tool with the file's absolute path. Calling the skill name directly (e.g. `send-image(...)`) returns *Tool send-image not found* — never do that. Common intent → skill file:",
    "- \"send/show me a photo/picture/image of X\" → read `/Users/gado/.openclaw/workspace/skills/send-image/SKILL.md`. Drives Chrome on the openclaw desktop to find a real Wikimedia/Google image, saves to /tmp, ends with a `MEDIA:/tmp/...` line that this adapter ships to the Visuals tab.",
    "- \"where am I / where is Matt / device location\" → read `/Users/gado/.openclaw/workspace/skills/findmyloc/SKILL.md`.",
    "- \"weather / Wetter / Regen / forecast\" → read `/Users/gado/.openclaw/skills/meteoswiss/SKILL.md` (Swiss locations).",
    "- \"powerbank / Chimpy / Akkupack\" → read `/Users/gado/.openclaw/skills/chimpy/SKILL.md`.",
    "- \"am I late / next meeting / kalender\" → call `exec` with `/Users/gado/bin/wrist-next-event`; it wraps `gog calendar --all --today --json`, converts UTC→local, filters past events, prints one line.",
    "- generic `gog calendar` usage: default account is **gado@sala.ch** (no --account flag); Matthias's Arbeit/Familie/Privat are shared in. Use `--all` to see them.",
  );

  lines.push(
    "",
    WRISTCLAW_HEADER_HARD_RULES,
    "- The `image_generate` tool is globally denied. Don't try it; it fails.",
    "- Never emit `MEDIA:image-<digits>` or any placeholder string in place of a real path. The adapter only ships real `/tmp/<file>.jpg` paths or `https://...jpg` URLs; placeholders are silently dropped and the watch user sees nothing.",
    "- If a tool refuses or returns no usable data, say so honestly (\"I couldn't find a photo of X\", \"Calendar isn't connected\") rather than fabricating.",
    "- Reply in the user's detected language. The TTS engine picks a voice that matches the *reply text's* language; mixing languages picks the wrong voice for the mixed section.",
  );

  const intentHints = buildIntentHints(userText);
  if (intentHints.length) {
    lines.push("", "[wristclaw intent hints for THIS turn]", ...intentHints);
  }

  lines.push("", HEADER_AMBIENT_CONTEXT, ...formatAmbientContext(ambientContext), "", HEADER_USER_MESSAGE, userText);
  return lines.join("\n");
}

function withModelOverride(cfg, model) {
  const clone = structuredClone(cfg);
  clone.agents ??= {};
  clone.agents.defaults ??= {};
  clone.agents.defaults.model ??= {};
  clone.agents.defaults.model.primary = model;
  return clone;
}

function sessionRoute({ cfg, account, agentId }) {
  return buildChannelOutboundSessionRoute({
    cfg,
    agentId,
    channel: CHANNEL,
    accountId: account.accountId,
    peer: { kind: "direct", id: account.sessionId },
    chatType: "direct",
    from: `wristclaw:${account.sessionId}`,
    to: `wristclaw:${account.sessionId}`
  });
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if ([".m4a", ".aac"].includes(ext)) return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

async function readMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;
  if (/^https?:\/\//i.test(mediaUrl)) {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`media fetch failed ${res.status}: ${mediaUrl}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream"
    };
  }
  const localPath = mediaUrl.startsWith("file://") ? fileURLToPath(mediaUrl) : mediaUrl;
  return {
    bytes: await fsp.readFile(localPath),
    contentType: contentTypeForPath(localPath)
  };
}

export function classifyMediaType(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  if (type.startsWith("audio/")) return MSG.AUDIO_RESPONSE;
  if (type.startsWith("image/")) return MSG.IMAGE_THUMBNAIL;
  return MSG.TEXT_RESPONSE;
}

// Resize an image "to contain" within a byte budget: preserve aspect ratio,
// shrink the longest edge, re-encode as JPEG, halving the dimension cap until
// the bytes fit. The relay rejects any frame over MAX_MESSAGE_BYTES, and the
// watch is a memory-constrained client — an agent can hand us a full-res photo,
// so the channel is responsible for getting it down to something deliverable.
// Uses macOS `sips`, consistent with the plugin's other shell-outs (say,
// afconvert, kokoro/piper). Images already within budget pass through untouched.
export async function resizeImageToFit(bytes, contentType, budget = MAX_PAYLOAD_BYTES) {
  if (bytes.length <= budget) return { bytes, contentType };

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `wristclaw-img-in-${stamp}`);
  await fsp.writeFile(tmpIn, bytes);

  let best = null;
  try {
    let maxDim = 2000;
    for (let attempt = 0; attempt < 6 && maxDim >= 64; attempt++) {
      const tmpOut = path.join(os.tmpdir(), `wristclaw-img-out-${stamp}-${attempt}.jpg`);
      try {
        await execAsync(
          `/usr/bin/sips -Z ${maxDim} -s format jpeg -s formatOptions 80 "${tmpIn}" --out "${tmpOut}"`
        );
        const out = await fsp.readFile(tmpOut);
        if (!best || out.length < best.length) best = out;
        if (out.length <= budget) {
          log.info(`WristClaw image resized ${bytes.length} → ${out.length} bytes (longest edge ≤ ${maxDim}px)`);
          return { bytes: out, contentType: "image/jpeg" };
        }
      } catch (err) {
        log.warn(`WristClaw image resize attempt ${attempt} failed: ${String(err)}`);
      } finally {
        await fsp.rm(tmpOut, { force: true });
      }
      maxDim = Math.round(maxDim / 1.6);
    }
  } finally {
    await fsp.rm(tmpIn, { force: true });
  }

  if (best) {
    log.warn(`WristClaw image still ${best.length} > ${budget} bytes after resize — sending smallest attempt`);
    return { bytes: best, contentType: "image/jpeg" };
  }
  log.warn("WristClaw image resize produced no output — sending original (relay may reject)");
  return { bytes, contentType };
}

const KOKORO_BIN = "/Users/gado/bin/kokoro-tts";
const PIPER_BIN  = "/Users/gado/bin/piper-tts";

const PIPER_VOICES = new Set(["karlsson", "thorsten", "amy", "siwis", "harri", "paola"]);
const KOKORO_VOICES = new Set([
  "af_bella", "af_alloy", "af_sky", "af_heart", "af_nova",
  "am_adam", "am_michael",
  "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
]);

function parseTtsVoice(preferredVoice) {
  if (!preferredVoice) return { engine: "kokoro", voice: "af_bella" };
  const bare = preferredVoice.includes("/") ? preferredVoice.split("/").pop() : preferredVoice;
  if (PIPER_VOICES.has(bare))  return { engine: "piper",  voice: bare };
  if (KOKORO_VOICES.has(bare)) return { engine: "kokoro", voice: bare };
  return { engine: "kokoro", voice: "af_bella" }; // unknown → default
}

async function synthesizeExtensionAudio(text, { cfg, preferredVoice } = {}) {
  const m4aPath = `/tmp/wristclaw-tts-${Date.now()}.m4a`;
  const { engine, voice } = parseTtsVoice(preferredVoice);

  // 1a. Piper (German karlsson / thorsten, French siwis, etc.)
  if (engine === "piper") {
    try {
      await execAsync(`"${PIPER_BIN}" -o "${m4aPath}" -v "${voice}" "${text.replace(/"/g, '\\"')}"`);
      const bytes = await fsp.readFile(m4aPath);
      log.info(`TTS via piper(${voice}) ok: ${bytes.length} bytes`);
      return bytes;
    } catch (err) {
      log.warn(`TTS piper(${voice}) failed: ${String(err)}`);
    } finally {
      fsp.unlink(m4aPath).catch(() => {});
    }
  }

  // 1b. Kokoro local (af_bella, af_alloy, etc.) — English, loudnorm applied
  if (engine === "kokoro") {
    try {
      await execAsync(`"${KOKORO_BIN}" -o "${m4aPath}" -v "${voice}" "${text.replace(/"/g, '\\"')}"`);
      const bytes = await fsp.readFile(m4aPath);
      log.info(`TTS via kokoro(${voice}) ok: ${bytes.length} bytes`);
      return bytes;
    } catch (err) {
      log.warn(`TTS kokoro(${voice}) failed: ${String(err)}`);
    } finally {
      fsp.unlink(m4aPath).catch(() => {});
    }
  }

  // 2. openclaw SDK provider (cloud fallback — openrouter/openai/etc.)
  if (cfg) {
    try {
      const overrides = preferredVoice ? { voice: preferredVoice } : undefined;
      const result = await synthesizeSpeech({ text, cfg, overrides });
      if (result?.audio?.length) {
        log.info(`TTS via SDK provider ok: ${result.audio.length} bytes`);
        return result.audio;
      }
    } catch (err) {
      log.warn(`TTS SDK provider failed: ${String(err)}`);
    }
  }

  // No say fallback — intentionally omitted per voice preferences.
  log.warn("TTS: all synthesis paths failed, returning null");
  return null;
}

export class WristClawRelayClient {
  constructor({ account, cfg, runtime, accountId }) {
    this.account = account;
    this.cfg = cfg;
    this.runtime = runtime;
    this.accountId = accountId;
    this.crypto = new WristClawCrypto();
    this.seq = 0;
    this.ws = null;
    this.abortController = new AbortController();
    this.latestContext = null;
    this.preferredModel = "";
    this.preferredVoice = "";
    this.pushedExtensionIds = new Set();
    this.connected = false;
  }

  start() {
    this.loopPromise = this.connectLoop().catch((err) => {
      this.setStatus({ running: false, connected: false, healthState: "error", lastError: String(err) });
      log.error(`WristClaw relay loop failed: ${String(err)}`);
    });
    return async () => {
      this.abortController.abort();
      try {
        this.ws?.close();
      } catch {
        // ignore close errors
      }
      activeWristClawClients.delete(this.account.sessionId);
      await this.loopPromise?.catch(() => {});
    };
  }

  setStatus(next) {
    this.runtime?.setStatus?.({
      accountId: this.accountId,
      ...next
    });
  }

  nextSeq() {
    this.seq = (this.seq + 1) >>> 0;
    return this.seq;
  }

  /// Persist *both* the X25519 private key and the most recent peer public
  /// key per account, so the shared secret can be re-derived immediately on
  /// process start — no waiting for an in-flight HANDSHAKE.
  ///
  /// Why both? Persisting only the private key still leaves sharedKey=null
  /// until the watch's HANDSHAKE arrives; if the agent finishes a turn in
  /// that gap (e.g. health-monitor cycled the channel mid-think), encrypt()
  /// throws "crypto is not paired" and the response is dropped.
  ///
  /// X25519 is symmetric: priv_host × pub_watch == priv_watch × pub_host,
  /// so as long as both sides cache the counterparty's public key, the
  /// derived sharedKey is stable across restarts.
  async loadOrCreateCrypto() {
    const keyDir = path.join(stateRoot(), "host-keys");
    const keyPath = path.join(keyDir, `${this.accountId}.key`);
    const peerPath = path.join(keyDir, `${this.accountId}.peer.pub`);

    let privateKeyRaw = null;
    try {
      const raw = await fsp.readFile(keyPath);
      if (raw.length === 32) {
        privateKeyRaw = raw;
      } else {
        log.warn(`Persisted host key at ${keyPath} has unexpected length ${raw.length}; regenerating`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`Failed to read persisted host key (${keyPath}): ${String(err)}`);
      }
    }

    const crypto = privateKeyRaw ? new WristClawCrypto(privateKeyRaw) : new WristClawCrypto();
    if (!privateKeyRaw) {
      try {
        await fsp.mkdir(keyDir, { recursive: true, mode: 0o700 });
        await fsp.writeFile(keyPath, crypto.privateKeyRaw, { mode: 0o600 });
        log.info(`Persisted new WristClaw host key for account=${this.accountId} at ${keyPath}`);
      } catch (err) {
        log.warn(`Failed to persist host key (${keyPath}): ${String(err)}`);
      }
    }

    try {
      const peerPub = await fsp.readFile(peerPath);
      if (peerPub.length === 32) {
        crypto.completeHandshake(peerPub);
        log.info(`Resumed WristClaw shared secret for account=${this.accountId} from cached peer key`);
      } else {
        log.warn(`Persisted peer pubkey at ${peerPath} has unexpected length ${peerPub.length}; ignoring`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`Failed to read peer pubkey (${peerPath}): ${String(err)}`);
      }
    }
    return crypto;
  }

  /// Cache the watch's public key on disk after a handshake completes, so the
  /// next loadOrCreateCrypto() can derive the same sharedKey without waiting
  /// for another HANDSHAKE round-trip.
  async persistPeerPubKey(peerPubRaw) {
    const keyDir = path.join(stateRoot(), "host-keys");
    const peerPath = path.join(keyDir, `${this.accountId}.peer.pub`);
    try {
      await fsp.mkdir(keyDir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(peerPath, Buffer.from(peerPubRaw), { mode: 0o600 });
    } catch (err) {
      log.warn(`Failed to persist peer pubkey (${peerPath}): ${String(err)}`);
    }
  }

  async connectLoop() {
    activeWristClawClients.set(this.account.sessionId, this);
    while (!this.abortController.signal.aborted) {
      try {
        await this.connectOnce();
        if (this.abortController.signal.aborted) break;
        this.setStatus({ running: true, connected: false, healthState: "reconnecting", lastEventAt: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (err) {
        if (this.abortController.signal.aborted) break;
        this.setStatus({ running: true, connected: false, healthState: "reconnecting", lastError: String(err) });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async connectOnce() {
    this.crypto = await this.loadOrCreateCrypto();
    const ws = new WebSocket(this.account.relayUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("WristClaw relay WebSocket failed to open"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
    this.sendRaw(buildJoinFrame(this.account.sessionId));
    this.sendPlain(MSG.HANDSHAKE, this.crypto.publicKeyRaw);
    // When loadOrCreateCrypto restored a paired sharedKey from cache, we can
    // encrypt/decrypt immediately — no need to block on a fresh HANDSHAKE.
    // Marking connected=true here also tells the SDK's health-monitor we're
    // healthy, so it doesn't restart us every 10 min for "disconnected".
    this.connected = Boolean(this.crypto.sharedKey);
    this.setStatus({
      running: true,
      connected: this.connected,
      healthState: this.connected ? "connected" : "waiting",
      lastConnectedAt: this.connected ? Date.now() : undefined,
      lastEventAt: Date.now(),
    });
    if (this.connected) {
      // Re-broadcast extensions and config so a fresh watch connection sees them.
      this.pushExtensions().catch((err) => log.warn(`pushExtensions failed: ${String(err)}`));
      this.pushConfig();
    }

    await new Promise((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        this.handleRaw(Buffer.from(event.data)).catch((err) => log.warn(`WristClaw frame failed: ${String(err)}`));
      });
      ws.addEventListener("close", () => {
        this.connected = false;
        this.setStatus({ running: true, connected: false, healthState: "stopped", lastDisconnect: Date.now() });
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => reject(new Error("WristClaw relay WebSocket error")), { once: true });
      this.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  sendRaw(data) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("WristClaw relay is not connected");
    this.ws.send(data);
  }

  sendPlain(type, payload) {
    this.sendRaw(encodePacket({
      sessionId: this.account.sessionId,
      type,
      seq: this.nextSeq(),
      ciphertext: payload
    }));
  }

  sendEncrypted(type, payload) {
    try {
      const { nonce, ciphertext } = this.crypto.encrypt(Buffer.from(payload));
      const seq = this.nextSeq();
      const wsState = this.ws?.readyState;
      log.info(`sendEncrypted: type=0x${type.toString(16).padStart(2,"0")} seq=${seq} payloadLen=${payload.length} ctLen=${ciphertext.length} wsState=${wsState}`);
      this.sendRaw(encodePacket({
        sessionId: this.account.sessionId,
        type,
        seq,
        nonce,
        ciphertext
      }));
    } catch (err) {
      log.warn(`sendEncrypted type=0x${type.toString(16).padStart(2,"0")} failed: ${String(err)}`);
      throw err;
    }
  }

  async handleRaw(raw) {
    const pkt = decodePacket(raw);
    if (!pkt) {
      log.warn(`handleRaw: undecodable packet (len=${raw.length})`);
      return;
    }
    if (pkt.sessionId !== this.account.sessionId) {
      log.warn(`handleRaw: sessionId mismatch ours=${this.account.sessionId} pkt=${pkt.sessionId}`);
      return;
    }
    log.info(`handleRaw: type=0x${pkt.type.toString(16).padStart(2,"0")} seq=${pkt.seq} ciphertextLen=${pkt.ciphertext.length} paired=${Boolean(this.crypto.sharedKey)}`);
    if (pkt.type === MSG.HANDSHAKE) {
      this.crypto.completeHandshake(pkt.ciphertext);
      this.sendPlain(MSG.HANDSHAKE, this.crypto.publicKeyRaw);
      this.connected = true;
      this.setStatus({ running: true, connected: true, healthState: "connected", lastConnectedAt: Date.now(), lastEventAt: Date.now() });
      // Cache the watch's pubkey so a subsequent gateway restart can re-derive
      // the shared secret immediately instead of waiting for another handshake
      // — fixes "crypto is not paired" errors when the agent finishes a turn
      // during the post-restart gap.
      this.persistPeerPubKey(pkt.ciphertext).catch(() => {});
      await this.pushExtensions();
      this.pushConfig();
      return;
    }
    if (pkt.type === MSG.HEARTBEAT) {
      this.sendPlain(MSG.HEARTBEAT, Buffer.alloc(0));
      // Update lastEventAt so health-monitor doesn't think a quiet but
      // connected channel is dead — without this, a watch that's polling
      // happily but not sending app-level traffic gets the provider torn
      // down every 10 min.
      this.setStatus({
        running: true,
        connected: true,
        lastEventAt: Date.now(),
      });
      return;
    }
    const plaintext = this.crypto.decrypt(pkt.nonce, pkt.ciphertext);
    await this.handlePlain(pkt.type, plaintext);
  }

  async handlePlain(type, plaintext) {
    this.setStatus({ running: true, connected: this.connected, lastInboundAt: Date.now(), lastEventAt: Date.now() });
    if (type === MSG.CONTEXT) {
      this.latestContext = JSON.parse(plaintext.toString("utf8"));
      const model = this.latestContext?.preferredModel;
      if (typeof model === "string") this.preferredModel = model;
      const voice = this.latestContext?.preferredVoice;
      if (typeof voice === "string") this.preferredVoice = voice;
      return;
    }
    if (type === MSG.TEXT_INPUT) {
      await this.dispatchText(plaintext.toString("utf8"));
      return;
    }
    if (type === MSG.EXT_INVOKE) {
      const invoke = JSON.parse(plaintext.toString("utf8"));
      await this.dispatchText(extensionPrompt(this.account, invoke.id), { extensionId: invoke.id });
      return;
    }
    if (type === MSG.AUDIO_INPUT) {
      await this.dispatchAudio(plaintext);
    }
  }

  async pushExtensions() {
    const definitions = loadExtensionDefinitions(this.account.extensionsPath);
    const currentIds = new Set(definitions.map((entry) => entry.id));
    for (const id of this.pushedExtensionIds) {
      if (!currentIds.has(id)) this.sendEncrypted(MSG.EXT_REMOVE, Buffer.from(JSON.stringify({ id }), "utf8"));
    }
    for (const definition of definitions) {
      this.sendEncrypted(MSG.EXT_DEFINE, Buffer.from(JSON.stringify(visibleExtensionDefinition(definition)), "utf8"));
    }
    this.pushedExtensionIds = currentIds;
  }

  pushConfig() {
    const models = Object.keys(this.cfg.agents?.defaults?.models ?? {});
    // Static voice list: piper + kokoro voices available on this host.
    // Prefixed by engine so the iPhone picker can label them correctly.
    const voices = [
      "piper/karlsson", "piper/thorsten",
      "kokoro/af_bella", "kokoro/af_alloy", "kokoro/af_sky",
      "kokoro/af_heart", "kokoro/am_adam", "kokoro/bf_emma",
    ];
    if (!models.length) return;
    const payload = Buffer.from(JSON.stringify({ models, voices }), "utf8");
    try {
      this.sendEncrypted(MSG.CONFIG, payload);
    } catch (err) {
      log.warn(`pushConfig failed: ${String(err)}`);
    }
  }

  async dispatchAudio(audio) {
    await fsp.mkdir(this.account.mediaDir, { recursive: true });
    const filePath = path.join(this.account.mediaDir, `audio-${Date.now()}.m4a`);
    await fsp.writeFile(filePath, audio);
    await this.dispatchText("<media:audio> Voice message from WristClaw.", {
      mediaPath: filePath,
      mediaType: "audio/mp4",
      inboundAudio: true
    });
  }

  async dispatchText(text, options = {}) {
    const agentId = "main";
    const cfg = this.preferredModel ? withModelOverride(this.cfg, this.preferredModel) : this.cfg;
    const route = sessionRoute({ cfg, account: this.account, agentId });
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const lang = options.extensionId ? undefined : detectLanguage(text);
    const body = buildWristClawPrompt({
      userText: text,
      ambientContext: this.latestContext,
      lang,
      terse: this.account.terse
    });
    const ctxPayload = finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: text,
      CommandBody: text,
      From: `wristclaw:${this.account.sessionId}`,
      To: `wristclaw:${this.account.sessionId}`,
      SessionKey: route.sessionKey,
      AccountId: this.account.accountId,
      MessageSid: `${this.account.sessionId}:${Date.now()}`,
      ChatType: "direct",
      Timestamp: Date.now(),
      ConversationLabel: "WristClaw",
      SenderName: "WristClaw",
      SenderId: this.account.sessionId,
      Provider: CHANNEL,
      Surface: CHANNEL,
      OriginatingChannel: CHANNEL,
      OriginatingTo: this.account.sessionId,
      ...options.mediaPath ? { MediaPath: options.mediaPath } : {},
      ...options.mediaType ? { MediaType: options.mediaType } : {},
      ...options.inboundAudio ? { InboundAudio: true } : {}
    });
    const replyPipeline = createChannelReplyPipeline({
      cfg,
      agentId,
      channel: CHANNEL,
      accountId: this.account.accountId
    });
    await runInboundReplyTurn({
      channel: CHANNEL,
      accountId: this.account.accountId,
      raw: { text, ...options },
      adapter: {
        ingest: () => ({
          id: ctxPayload.MessageSid,
          timestamp: ctxPayload.Timestamp,
          rawText: text,
          textForAgent: body,
          textForCommands: text,
          raw: { text, ...options }
        }),
        resolveTurn: () => ({
          cfg,
          channel: CHANNEL,
          accountId: this.account.accountId,
          agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            deliver: async (payload, info) => {
              await this.deliverReplyPayload(payload, { ...options, kind: info.kind });
            },
            onError: (err) => log.warn(`WristClaw delivery failed: ${String(err)}`)
          },
          replyOptions: {
            ...replyPipeline,
            transformReplyPayload: (payload) => replyPipeline.transformReplyPayload?.(payload) ?? payload
          },
          record: {
            onRecordError: (err) => log.warn(`WristClaw session record failed: ${String(err)}`)
          }
        })
      }
    });
  }

  async deliverReplyPayload(payload, options = {}) {
    if (payload?.isReasoning) return;
    const extensionId = options.extensionId;
    const rawText = typeof payload?.text === "string" ? payload.text : "";
    const { clean: textNoActions, actions: localActions } = parseLocalActions(rawText);
    for (const { action, params } of localActions) {
      try { this.sendLocalAction(action, params); } catch (err) {
        log.warn(`localAction send failed (${action}): ${String(err)}`);
      }
    }
    // Fallback markdown-image extractor: the upstream channel-reply-pipeline
    // sometimes does not populate payload.mediaUrls for extension flows,
    // leaving an image URL inline in the text that the watch then shows as
    // raw markdown instead of in the Visuals tab. Always scan the text here
    // so a `![](https://…png)` link reliably arrives as an image.
    const inlineUrls = [];
    let text = textNoActions;
    text = text.replace(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g, (_, url) => {
      inlineUrls.push(url);
      return "";
    });
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    const mediaUrls = [
      ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : []),
      ...(payload?.mediaUrl ? [payload.mediaUrl] : []),
      ...inlineUrls,
    ];
    // Dedupe while preserving order.
    const seen = new Set();
    for (let i = mediaUrls.length - 1; i >= 0; i--) {
      if (seen.has(mediaUrls[i])) mediaUrls.splice(i, 1); else seen.add(mediaUrls[i]);
    }
    if (text) {
      if (extensionId) this.sendExtensionResponse(extensionId, "text", text);
      else this.sendEncrypted(MSG.TEXT_RESPONSE, Buffer.from(text, "utf8"));
    }
    let audioDelivered = false;
    for (const mediaUrl of mediaUrls) {
      let media;
      try {
        media = await readMediaUrl(mediaUrl);
      } catch (err) {
        log.warn(`WristClaw media read failed for ${mediaUrl}: ${String(err)}`);
        continue;
      }
      if (!media) continue;
      const msgType = classifyMediaType(media.contentType);
      // Images can arrive at any resolution; the relay caps every frame at
      // MAX_MESSAGE_BYTES and the watch is memory-constrained. Resize-to-
      // contain so what we send is always deliverable. Audio/text untouched.
      let outBytes = media.bytes;
      if (msgType === MSG.IMAGE_THUMBNAIL) {
        // The extension-response path base64-encodes the payload inside JSON
        // (~4/3 larger), so it gets a tighter raw-bytes budget than a direct
        // IMAGE_THUMBNAIL frame.
        const budget = extensionId
          ? Math.floor((MAX_PAYLOAD_BYTES - 256) * 3 / 4)
          : MAX_PAYLOAD_BYTES;
        outBytes = (await resizeImageToFit(media.bytes, media.contentType, budget)).bytes;
      }
      if (extensionId) {
        const kind = msgType === MSG.AUDIO_RESPONSE ? "audio" : msgType === MSG.IMAGE_THUMBNAIL ? "image" : "text";
        if (kind === "audio") audioDelivered = true;
        this.sendExtensionResponse(extensionId, kind, text || "Media", outBytes.toString("base64"));
      } else {
        this.sendEncrypted(msgType, outBytes);
      }
    }
    // When the channel pipeline doesn't synthesize TTS, fall back to macOS
    // `say` so the watch always gets an audio reply for both regular and
    // extension turns.
    if (text && !audioDelivered) {
      const ttsText = stripMarkdown(text);
      const ttsVoice = chooseVoice(this.preferredVoice, detectLanguage(ttsText));
      const audioBytes = await synthesizeExtensionAudio(ttsText, {
        cfg: this.cfg,
        preferredVoice: ttsVoice,
      });
      if (audioBytes) {
        if (extensionId) {
          this.sendExtensionResponse(extensionId, "audio", text, audioBytes.toString("base64"));
        } else {
          this.sendEncrypted(MSG.AUDIO_RESPONSE, audioBytes);
        }
      }
    }
  }

  sendLocalAction(action, params) {
    const body = params ? { action, params } : { action };
    this.sendEncrypted(MSG.LOCAL_ACTION, Buffer.from(JSON.stringify(body), "utf8"));
  }

  sendExtensionResponse(id, kind, text = "", payload = "") {
    const body = { id, kind, text };
    if (payload) body.payload = payload;
    this.sendEncrypted(MSG.EXT_RESPONSE, Buffer.from(JSON.stringify(body), "utf8"));
  }
}

export async function sendWristClawOutbound({ cfg, to, text, mediaUrl, accountId }) {
  const account = resolveWristClawAccount(cfg, accountId);
  const client = activeWristClawClients.get(account.sessionId);
  if (!client) throw new Error(`No connected WristClaw watch for account ${account.accountId}`);
  await client.deliverReplyPayload({
    text,
    ...(mediaUrl ? { mediaUrl } : {})
  });
  return { messageId: `${account.sessionId}:${Date.now()}`, to };
}

export const _private = {
  sessionRoute,
  defaultExtensionsPath,
  defaultMediaDir
};
