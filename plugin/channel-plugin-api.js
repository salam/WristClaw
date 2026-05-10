import {
  buildJsonChannelConfigSchema,
  createChannelPluginBase,
  createChatChannelPlugin,
  DEFAULT_ACCOUNT_ID
} from "openclaw/plugin-sdk/core";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import {
  WristClawRelayClient,
  applyWristClawAccountConfig,
  listWristClawAccountIds,
  resolveWristClawAccount,
  sendWristClawOutbound,
  validateWristClawSetupInput
} from "./wristclaw-runtime.js";

const CHANNEL = "wristclaw";

const configSchema = buildJsonChannelConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    relayUrl: { type: "string" },
    sessionId: { type: "string" },
    defaultTo: { type: "string" },
    extensionsPath: { type: "string" },
    mediaDir: { type: "string" },
    terse: { type: "boolean" },
    accounts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          name: { type: "string" },
          relayUrl: { type: "string" },
          sessionId: { type: "string" },
          defaultTo: { type: "string" },
          extensionsPath: { type: "string" },
          mediaDir: { type: "string" },
          terse: { type: "boolean" }
        }
      }
    }
  }
});

export const wristclawPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: CHANNEL,
      meta: {
        label: "WristClaw",
        showConfigured: true,
        preferSessionLookupForAnnounceTarget: true
      },
      capabilities: {
        chatTypes: ["direct"],
        media: true,
        tts: {
          voice: {
            synthesisTarget: "voice-note",
            transcodesAudio: true
          }
        }
      },
      reload: {
        configPrefixes: ["channels.wristclaw"]
      },
      configSchema,
      config: {
        listAccountIds: listWristClawAccountIds,
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        resolveAccount: resolveWristClawAccount,
        isEnabled: (account) => account.enabled,
        disabledReason: () => "disabled",
        isConfigured: (account) => Boolean(account.relayUrl && account.sessionId),
        unconfiguredReason: () => "not paired",
        resolveDefaultTo: ({ cfg, accountId }) => resolveWristClawAccount(cfg, accountId).defaultTo,
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: Boolean(account.relayUrl && account.sessionId),
          sessionSource: account.sessionId ? "config" : "none",
          extra: {
            relayUrl: account.relayUrl,
            sessionId: account.sessionId,
            terse: account.terse
          }
        })
      },
      setup: {
        applyAccountConfig: applyWristClawAccountConfig,
        validateInput: validateWristClawSetupInput
      }
    }),
    agentPrompt: {
      inboundFormattingHints: () => ({
        text_markup: "plain markdown",
        rules: [
          "WristClaw replies are read on an Apple Watch; default to brief answers.",
          "Use text for the visible answer, attach image media for visual output, and keep audio/TTS short.",
          "Extension invocations are scoped to a watch extension; answer as the extension result, not as a long chat transcript."
        ]
      })
    },
    auth: {
      login: async ({ cfg, accountId, runtime }) => {
        const account = resolveWristClawAccount(cfg, accountId);
        if (!account.sessionId) {
          runtime.log("WristClaw is not paired yet.");
          runtime.log("Run:");
          runtime.log("  openclaw channels add --channel wristclaw --url wss://relay.wristclaw.app/ws --token <session-uuid>");
          runtime.log("The session UUID comes from the iPhone app Pair screen.");
          return;
        }
        runtime.log(`WristClaw account ${account.accountId} is configured.`);
        runtime.log(`Relay: ${account.relayUrl}`);
        runtime.log(`Session: ${account.sessionId}`);
        runtime.log("Restart the gateway if it is already running so the channel connects to the relay.");
      }
    },
    messaging: {
      targetPrefixes: [CHANNEL],
      normalizeTarget: (raw) => String(raw ?? "").replace(/^wristclaw:/i, "").trim(),
      inferTargetChatType: () => "direct",
      parseExplicitTarget: ({ raw }) => {
        const to = String(raw ?? "").replace(/^wristclaw:/i, "").trim();
        return to ? { to, chatType: "direct" } : null;
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const account = resolveWristClawAccount(cfg, accountId);
        const to = String(target || account.sessionId).replace(/^wristclaw:/i, "").trim();
        if (!to) return null;
        return {
          sessionKey: `wristclaw:${account.accountId}:${to}`,
          baseSessionKey: `wristclaw:${account.accountId}:${to}`,
          peer: { kind: "direct", id: to },
          chatType: "direct",
          from: `wristclaw:${account.sessionId}`,
          to
        };
      },
      targetResolver: {
        looksLikeId: (raw) => /^[0-9a-f-]{36}$/i.test(String(raw ?? "")),
        hint: "<session UUID>"
      }
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        ctx.log?.info(`[${account.accountId}] starting WristClaw relay provider (${account.sessionId})`);
        const client = new WristClawRelayClient({
          account,
          cfg: ctx.cfg,
          runtime: ctx,
          accountId: ctx.accountId
        });
        const stop = client.start();
        ctx.abortSignal?.addEventListener("abort", () => stop(), { once: true });
        await client.loopPromise;
      }
    }
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    extractMarkdownImages: true,
    textChunkLimit: 1200,
    sendText: async ({ cfg, to, text, accountId }) => ({
      channel: CHANNEL,
      ...(await sendWristClawOutbound({ cfg, to, text, accountId }))
    }),
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => ({
      channel: CHANNEL,
      ...(await sendWristClawOutbound({ cfg, to, text, mediaUrl, accountId }))
    })
  }
});
