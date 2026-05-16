# @wristclaw/openclaw-channel

OpenClaw channel plugin for [WristClaw](https://wristclaw.app) — a native
Apple Watch / iPhone client that talks to an OpenClaw agent over an
end-to-end-encrypted WebSocket relay.

This package adds a `wristclaw` channel to OpenClaw. After installing, the
agent can:

- accept paired watches as authenticated peers
- receive voice transcripts and ambient context from the wrist
- ship text, audio (Kokoro/Piper TTS), image thumbnails, and custom
  extension shortcuts back to the watch

The watch and iPhone clients are distributed via TestFlight from
[wristclaw.app](https://wristclaw.app); the relay is open source at
[salam/WristClaw](https://github.com/salam/WristClaw/tree/main/relay).

## Install

```sh
npm install -g @wristclaw/openclaw-channel
openclaw plugins install $(npm root -g)/@wristclaw/openclaw-channel
openclaw plugins registry --refresh
openclaw gateway restart
```

Or, to keep it scoped to a single OpenClaw instance:

```sh
cd ~/.openclaw
npm install @wristclaw/openclaw-channel
openclaw plugins install ./node_modules/@wristclaw/openclaw-channel
```

## Pair a watch

The pair screen in the WristClaw iOS/watchOS app shows three options
(Telegram bot, terminal, raw payload) — each produces the same
`wristclaw://pair?…` payload. The full pairing protocol, allowlist
behavior, and `--bind-public-key` flag are documented in the
[skill file](https://github.com/salam/WristClaw/blob/main/skill.md).

## Customize prompts and intent routing

Per-turn prompt fragments (skill routing, hard rules, intent hints) are
loaded from a JSON config at startup. Resolution order:

1. `$WRISTCLAW_INTENTS_FILE`
2. `~/.openclaw/wristclaw-intents.json` — per-user overrides
3. `wristclaw-intents.default.json` — generic defaults bundled with the package

See `wristclaw-intents.default.json` in this package for the schema. To
customize: copy it to `~/.openclaw/wristclaw-intents.json`, add your skill
files / binaries / regexes, and restart the gateway.

## TTS binaries

The channel can synthesize voice replies via Kokoro or Piper. Set
`WRISTCLAW_KOKORO_BIN` and `WRISTCLAW_PIPER_BIN` if the binaries aren't on
`$PATH`. With no TTS binary available the channel falls back to text-only
replies on the wrist.

## License

MIT. Copyright (c) 2026 Matthias Sala.
