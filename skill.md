---
name: wristclaw
description: Bridges WristClaw watch ↔ OpenClaw. Detects pairing payloads, registers the native `wristclaw` channel, shapes wrist-sized replies.
metadata:
  emoji: "🦞"
  requires: { bins: [openclaw] }
  install:
    - id: plugin
      kind: shell
      cmd: "curl -fsSL https://wristclaw.app/install.sh | bash"
      label: "Install the native WristClaw OpenClaw channel"
---

# WristClaw

Apple Watch + iPhone client for OpenClaw. Voice/text up, **text + audio + image** down — E2E encrypted (X25519 + ChaCha20-Poly1305) via a zero-trust WSS relay that only sees ciphertext. Native channel: `wristclaw`.

## Reply rules

- **Stdout only.** Runtime encrypts stdout, ships text + media. Don't call wacli / telegram / `mcp__openclaw__message` for *your* reply (those are for third-party deliveries the user explicitly asked for).
- **Don't cross channels.** Asked on wristclaw → answer there (images too). Exception: user names another channel; the confirmation still goes via wristclaw.
- **Full skillset works** — findmyloc, meteoswiss, chli, send-image, calendar, … Output flows through stdout.
- **Brevity.** 1–2 sentences. Lead with the answer.
- **Images** — URL, `![](url)`, local path, or `data:` URI in your text. Each needs a 1-sentence caption (shown + spoken).
- **Language.** Prompt may include `- detected language: <ISO>` and `- TTS available for this language: yes/no`. If TTS unavailable, reply bilingually — screen shows the original, TTS speaks `[tts:xx]`:
  ```
  <answer in user's language>
  [tts:en] <short English equivalent>
  ```

## Ambient context block

Every prompt is framed. **All five signals always listed**; off / not-loaded ones show `not currently received (off, loading, or sensor unavailable)`.

```
[ambient context]
- location: 47.37145,8.54227 (±12m)
- now playing: Song title, Artist (or "nothing" if silent)
- battery: 73% (on battery)
- connectivity: wifi
- heart rate: not currently received (off, loading, or sensor unavailable)
- as of: 2026-05-04T11:18:35Z
```

`as of` stale after ~5 min. Use `heart rate` if asked or health-relevant. Missing field → mention once, fall back. First turn after cold-start may have no snapshot — answer anyway.

## Pairing

User forwards the iPhone's pairing payload over any channel; match either:

```json
{ "sessionID":"<UUID>", "relayURL":"wss://relay.wristclaw.app/ws", "publicKey":"<b64 X25519>" }
```
```
wristclaw://pair?sid=<UUID>&relay=<urlenc>&pk=<b64>
```

Ack (`🦞 pairing — session <first-8>…`), then:

```bash
curl -fsSL https://wristclaw.app/install.sh | bash
openclaw channels add --channel wristclaw --url "<relayURL>" --token "<sessionID>"
openclaw channels login --channel wristclaw
```

Confirm `✅ paired.` or `❌ pairing failed — <error>`. `publicKey` is informational; the plugin runs its own X25519 handshake.

## Extensions (swipe-right tabs)

`EXT_DEFINE` (0x0A) JSON `{id, title, icon?, buttonLabel?, prompt?}` pushes/updates a tab (re-send same `id`); `EXT_REMOVE` (0x0B) `{id}` drops. Tap → `EXT_INVOKE` (0x0D) `{id}`. Reply with one or more `EXT_RESPONSE` (0x0C) `{id, kind:"text"|"audio"|"image", text, payload?}` (payload = base64 AAC or JPEG ≤40 KB), stacked in send order. Push 2–6 tabs on first pair.

## Local actions (iPhone)

Emit `[action:name key=value]` markers anywhere in your text; runtime strips them and dispatches `LOCAL_ACTION` (0x10). User-gated in *iPhone Settings → Extensions*; music is on by default. Always pair with a one-line confirmation: `▶️ Playing. [action:musicPlay]`.

| Capability | Markers |
|---|---|
| Music *(on)* | `musicPlay`·`musicPause`·`musicNext`·`musicPrevious` |
| Workout/sleep | `workoutStart type=running|cycling|walking|swimming|other`·`workoutEnd`·`sleepStart`·`sleepEnd` |
| HomeKit | `homeToggle accessory=<partial> value=true|false`·`homeScene scene=<partial>` |
| Brightness | `brightness level=0.0..1.0` |
| Siri Shortcut | `runShortcut name=<exact>` |
| Open app | `openApp bundle=<urlscheme>` |

## Wire protocol & transports

WSS `wss://relay.wristclaw.app/ws`. Health: `curl -s https://wristclaw.app/health` → `ok`.

- **JOIN** (17 B): `[0:16] sid | [16] role (0=host, 1=watch)`.
- **Frame** (≥37 B): `[0:16] sid | [16] type | [17:21] seq LE u32 | [21:25] len LE u32 | [25:37] nonce | [37:] ciphertext (ChaCha20-Poly1305)`.
- Types: `0x01 HANDSHAKE · 0x02 AUDIO_INPUT · 0x03 TEXT_INPUT · 0x04 AUDIO_RESPONSE · 0x05 TEXT_RESPONSE · 0x06 IMAGE_THUMBNAIL · 0x07 ACK · 0x08 HEARTBEAT · 0x09 DISCONNECT · 0x0A EXT_DEFINE · 0x0B EXT_REMOVE · 0x0C EXT_RESPONSE · 0x0D EXT_INVOKE · 0x0E CONTEXT · 0x0F CONFIG · 0x10 LOCAL_ACTION`.
- Handshake: plaintext HANDSHAKE with 32-byte X25519 pubkey; KDF = HKDF-SHA256, info `"WristClaw-v1"`, 32-byte zero salt; fresh 12-byte random nonce per frame.

**HTTP fallback** — for agents not running the OpenClaw plugin (CI, MCP, curl). Same packet shape, same encryption; relay only routes.

```
POST /host/join          role=0 join frame; pre-creates host buffer.
POST /host/send          one data frame; forwarded to the watch.
GET  /host/poll?sid=...  long-poll (≤25 s); next watch→host frame or 204.

POST /watch/join         role=1 join frame.
POST /watch/send         watch→host data frame.
GET  /watch/poll?sid=... long-poll for host→watch frame.
```

You own the host X25519 keypair, run the HANDSHAKE, encrypt/decrypt yourself. Channel is stateless; agent owns history. Pairing payloads originate on the iPhone.
