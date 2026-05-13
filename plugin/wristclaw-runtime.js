import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { MSG, WristClawCrypto, buildJoinFrame, decodePacket, encodePacket } from "./protocol.js";

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

function detectLanguage(text) {
  if (/[äöüÄÖÜß]/.test(text)) return "de";
  const deWords = /\b(ich|du|er|sie|wir|ihr|die|der|das|ein|eine|nicht|auch|oder|und|für|mit|von|bei|wie|was|ist|war|hat|werden|sein|bitte|danke|ja|nein|heute|schon|noch|sehr|gut|kann|muss|soll|hallo|nochmal|genau)\b/i;
  if (deWords.test(text)) return "de";
  return "en";
}

function voiceForLang(lang) {
  return lang === "de" ? "piper/karlsson" : "kokoro/af_bella";
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

export function buildWristClawPrompt({ userText, ambientContext, lang, terse = true }) {
  const lines = [
    HEADER_USER_CONTEXT,
    "- surface: Apple Watch",
    "- output contract: answer for a wrist-sized screen; keep it short unless explicitly asked for detail",
    "- supported outbound modes: text, audio, image thumbnails, and extension-scoped responses",
    "- when sending images, attach or link image media; when sending audio, prefer the channel TTS/audio payload when available"
  ];
  if (terse) lines.push("- default style: concise, direct, no filler");
  if (lang) lines.push(`- detected language: ${lang}`);
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
    this.crypto = new WristClawCrypto();
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
    this.connected = false;
    this.setStatus({ running: true, connected: false, healthState: "waiting", lastEventAt: Date.now() });

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
    const { nonce, ciphertext } = this.crypto.encrypt(Buffer.from(payload));
    this.sendRaw(encodePacket({
      sessionId: this.account.sessionId,
      type,
      seq: this.nextSeq(),
      nonce,
      ciphertext
    }));
  }

  async handleRaw(raw) {
    const pkt = decodePacket(raw);
    if (!pkt || pkt.sessionId !== this.account.sessionId) return;
    if (pkt.type === MSG.HANDSHAKE) {
      this.crypto.completeHandshake(pkt.ciphertext);
      this.sendPlain(MSG.HANDSHAKE, this.crypto.publicKeyRaw);
      this.connected = true;
      this.setStatus({ running: true, connected: true, healthState: "connected", lastConnectedAt: Date.now(), lastEventAt: Date.now() });
      await this.pushExtensions();
      this.pushConfig();
      return;
    }
    if (pkt.type === MSG.HEARTBEAT) {
      this.sendPlain(MSG.HEARTBEAT, Buffer.alloc(0));
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
    const { clean: text, actions: localActions } = parseLocalActions(rawText);
    for (const { action, params } of localActions) {
      try { this.sendLocalAction(action, params); } catch (err) {
        log.warn(`localAction send failed (${action}): ${String(err)}`);
      }
    }
    const mediaUrls = [
      ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : []),
      ...(payload?.mediaUrl ? [payload.mediaUrl] : [])
    ];
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
      if (extensionId) {
        const kind = msgType === MSG.AUDIO_RESPONSE ? "audio" : msgType === MSG.IMAGE_THUMBNAIL ? "image" : "text";
        if (kind === "audio") audioDelivered = true;
        this.sendExtensionResponse(extensionId, kind, text || "Media", media.bytes.toString("base64"));
      } else {
        this.sendEncrypted(msgType, media.bytes);
      }
    }
    // When the channel pipeline doesn't synthesize TTS, fall back to macOS
    // `say` so the watch always gets an audio reply for both regular and
    // extension turns.
    if (text && !audioDelivered) {
      const ttsText = stripMarkdown(text);
      const ttsVoice = this.preferredVoice || voiceForLang(detectLanguage(ttsText));
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
