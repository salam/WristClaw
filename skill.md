---
name: wristclaw
description: Bridges the WristClaw watch ↔ OpenClaw agent. Recognizes pairing payloads sent via Telegram (or any channel), registers the native WristClaw OpenClaw channel, and keeps replies concise for the watch.
metadata:
  emoji: "🦞"
  requires:
    bins: [openclaw]
  install:
    - id: plugin
      kind: shell
      cmd: "curl -fsSL https://wristclaw.app/install.sh | bash"
      label: "Install the native WristClaw OpenClaw channel"
---

# WristClaw channel skill

Bridge between the iPhone-paired Apple Watch app and the OpenClaw agent. The watch talks to a stateless WSS relay (`wss://relay.wristclaw.app/ws`); the native `wristclaw` OpenClaw channel joins the same session as the *host* and the relay forwards encrypted frames between the two peers.

## What this channel can deliver to the watch

**The wristclaw channel is a full multimedia conduit** — it carries text, audio, and small images end-to-end, encrypted, directly to the watch. There is no need to fall back to WhatsApp, email, Telegram, or any other channel to deliver images or audio when the user asked through wristclaw. Doing so means the user has to fish out their phone to see what they asked from their wrist — defeats the whole point of the device.

What the channel passes through, per agent reply payload:

- **Text snippets** → rendered on the Talk tab and the Dialog tab. Use for the headline answer / caption.
- **Audio (m4a / AAC)** → played by the watch's `AVAudioPlayer`. OpenClaw can deliver generated or attached audio payloads through the WristClaw channel.
- **Small images (JPEG ≤ 40 KB)** → shown on the Visuals tab as thumbnails. Sources can be base64 fields, URLs, or local file paths; the channel downscales as needed.

All three travel together, in order, off a *single* payload object. Emit them as one reply — the watch shows them as one coherent answer.

**Therefore: when the user asks via wristclaw and the response includes an image, send it through wristclaw.** Do NOT route the image to WhatsApp / Telegram / email "because images are easier there." The Visuals tab exists precisely for this.

(The only legitimate exception: the user explicitly says "send the cartoon to my WhatsApp" or similar — third-party delivery requested by name. Even then, the *confirmation* reply to the user goes back through wristclaw stdout.)

## Recognize a pairing payload

When Matt sends a message to any channel (Telegram is the typical path) that matches one of these formats, treat it as a wristclaw pairing payload:

**JSON form** (what the iPhone "Send via Telegram" button copies):

```json
{
  "sessionID": "<UUID>",
  "relayURL":  "wss://relay.wristclaw.app/ws",
  "publicKey": "<base64-encoded X25519 public key>"
}
```

**URL form** (compact alternative, also valid):

```
wristclaw://pair?sid=<UUID>&relay=<urlencoded>&pk=<base64>
```

Detection heuristic: the message either parses as JSON with all three keys (`sessionID`, `relayURL`, `publicKey`), OR starts with `wristclaw://pair?`.

## What to do with it

1. **Acknowledge fast.** Reply on the same channel: "🦞 pairing — session `<first 8 chars of UUID>` — registering WristClaw…"
2. **Ensure the native plugin is installed** (safe to re-run):
   ```bash
   curl -fsSL https://wristclaw.app/install.sh | bash
   ```
3. **Register the pairing session** using the payload values:
   ```bash
   openclaw channels add --channel wristclaw --url "<relayURL from payload>" --token "<sessionID from payload>"
   ```
   The iPhone payload's `publicKey` is kept for protocol context, but the native channel performs its own relay-side X25519 handshake when the watch connects.
4. **Load/check the channel account:**
   ```bash
   openclaw channels login --channel wristclaw
   ```
   If the gateway was already running, restart it so it picks up the new channel session.
5. **Confirm back to Matt:** "✅ paired. Watch can now talk to me." Or the failure mode: "❌ pairing failed — <last OpenClaw error line>".

## How to write replies for the watch

### CRITICAL: reply *only* via stdout — never through other channels

When you receive a message framed with the `[wristclaw]` block, you are running inside the WristClaw channel. The channel runtime is collecting your reply, encrypting it, and delivering it to the watch over the relay.

**Do NOT call `wacli send text`, `mcp__openclaw__message`, telegram tools, or any other channel tool to reply.** Those create duplicate deliveries — the user gets the same answer once on the wrist *and* once buzzing on their phone in WhatsApp. The standing AGENTS.md rule about wacli applies to *direct* WhatsApp inbound, not to wristclaw turns.

If the only way to fulfil the request is to send a message to a third party (e.g. "text Anna to confirm dinner"), that's the explicit exception — call wacli for the third party, but keep the *reply to the user* (status / confirmation) on the WristClaw turn.

### Use your full skillset — wristclaw is a normal channel, not a stripped-down one

A wristclaw turn is **not** a "give a quick text answer and stop" path. You have your complete skill catalog, MCPs, web search, file system — all of it. Treat the wrist exactly as you would any other inbound: pick the skill or tool that actually answers the question, run it, and put the answer in stdout (text + optional image URLs / audio_b64 / etc., per the multimedia-conduit section at the top).

Concretely, before answering anything but trivial chit-chat:

- **"Where am I?" / "Wo bin ich?" / "Where's my watch?"** → call the `findmyloc` skill. It pulls Matt's live FindMy device locations. Reply with the place name + a one-line context (battery, last seen). Don't guess from memory.
- **"What's the weather?" / "Wie ist das Wetter?"** → use the `meteoswiss` skill for Swiss locations.
- **"Show me / send me a picture of X"** → invoke the `send-image` skill. It now knows to embed the image URL in your stdout reply when the inbound was wristclaw — see that skill for the pattern.
- **Avalanche / ski conditions** → `whiterisk` and `arosa` skills.
- **Calendar / today's plan** → whichever calendar tool you'd normally use; same brevity rules apply on the wrist.
- **Powerbank rentals, gym hours, parliament records, Klapp messages** → `chimpy`, `activfitness`, `chli`, `klappcli` — all available, all valid for wristclaw turns.

Skill output goes into your stdout reply (image URLs as Markdown, structured data as a one-sentence summary the user actually wants). The brevity rules below still apply — just because a skill returned three pages of JSON doesn't mean you read it all out loud on the wrist.

If you genuinely don't have a skill for the question, answer from your own knowledge as you would on any channel — don't pretend the wrist is more limited than it is.

### Read the `[ambient context]` block before answering

Every wristclaw prompt is pre-framed with an `[ambient context]` block, **before** the `[user message]`. The block **always lists all five context signals** so you know what's possible on this channel — fields the user has toggled off (or that haven't loaded yet) appear with the marker `not currently received (off, loading, or sensor unavailable)` rather than being silently omitted. That way you can tell the difference between "this signal doesn't exist" and "this signal exists but isn't in this turn."

Example with mixed availability:

```
[wristclaw]
- detected language: de
- TTS available for this language: yes

[ambient context]
- location: 47.37145,8.54227 (±12m)
- now playing: Reise, Reise — Rammstein
- battery: 73% (on battery)
- connectivity: wifi
- heart rate: not currently received (off, loading, or sensor unavailable)
- as of: 2026-05-04T11:18:35Z

[user message]
Wo bin ich gerade?
```

Per-field guidance:

- **`location`** (lat/lon, accuracy in m) → for "where am I?", "what's the weather?", "any cafés nearby?", "how far to home?". Reverse-geocode for place names; cross-reference `findmyloc` for the named device if needed.
- **`now playing`** → for "who's this song by?", "skip / louder / mute" intents (only if the user asks).
- **`battery`** → for "how's my watch battery?" or to *proactively warn* if asked something demanding while battery < 15 %.
- **`connectivity`** (`wifi` / `cellular` / `offline` / `unknown`) → if offline, prefer cached/local answers; warn if a request needs the network.
- **`heart rate`** → only if the user asked, or if it's wildly out of range and the request implies a health check.
- **`as of`** → freshness of the snapshot. If older than ~5 minutes, treat with suspicion; the user may have moved.

**When a field shows the "not currently received" marker:**

- Don't fabricate a value or guess from prior context.
- Don't pepper the user with "is location on?" on every turn — they know.
- If the question genuinely needs that field, *briefly* mention it once ("Need location for that — looks like it's off or still loading."). Otherwise just answer using what you have, or fall back to a skill that doesn't depend on it (e.g. weather for a hardcoded city).
- A field that was present in a prior turn but is "not currently received" now has typically just timed out — try again in a few seconds if the user asked again.

**Caveat — context arrives just before audio, but not strictly atomically.** The watch fires the context send before the audio packet but does not await its completion. In ~99 % of turns the context is cached when audio transcription finishes, but the first turn after pairing or after the watch app cold-starts may see "as of: no snapshot received yet this session" — answer the user's question with what skills/general knowledge can do, and the snapshot will catch up by the next turn.

### Brevity

The wrist is a *small* surface and the user is usually on the move. Keep replies **short, informative, and concrete** — typically 1–3 sentences. No filler ("Sure! I'd be happy to help with that.") and no preamble. Get to the answer. If the user asked for something that requires a longer explanation, give the headline answer first, then the next step or the most useful detail. The wearer can always ask for more.

### Language

The user's spoken language can be forwarded to you in the framed prompt as `[wristclaw] - detected language: <code>` (ISO 639-1, e.g. `de`, `fr`, `it`) when transcription metadata is available. The same line may tell you whether a usable TTS voice exists for that language.

- **TTS available for that language** → reply in that language. One reply, one language, both text and audio in sync.
- **TTS *not* available** → reply bilingually:
  ```
  <full answer in the user's language — this becomes the on-screen text>
  [tts:en] <a short English equivalent — this becomes the spoken audio>
  ```
  The channel can split on the `[tts:xx]` marker. The display still shows the original-language reply; the audio can use an English voice. Use a different language code in the marker if a better TTS voice fits (e.g. `[tts:fr]` if the user is speaking Occitan but understands French).

Never produce English audio for a German prompt without the marker — the adapter will dutifully pipe whatever you wrote into `say -v Samantha` and the result will sound wrong. The marker is the explicit consent to switch languages between text and audio.

### Brevity examples

> "Wie ist das Wetter in Zürich?"
> ✅ "13 °C, leicht bewölkt. Heute Nachmittag Regenrisiko."
> ❌ "Aktuell sind in Zürich 13 Grad Celsius bei leichter Bewölkung, und im Verlauf des Nachmittags besteht eine erhöhte Niederschlagswahrscheinlichkeit, daher würde ich empfehlen, einen Regenschirm mitzunehmen, falls Sie planen, das Haus zu verlassen."

> "Was steht heute an?"
> ✅ "Standup 10:30, dann Lunch mit Anna 12:00, Demo 15:00. Sonst frei."
> ❌ Calendar dump in prose.

When *both* time pressure and detail matter (e.g. "Am I late for the train?"), lead with the answer ("Yes — leave now, 4 min walk"), then a single clarifier if it adds real value.

### How to attach images to a wristclaw reply

The adapter scans your reply for image URLs and forwards them to the watch's Visuals tab as thumbnails (auto-downscaled to ≤ 40 KB JPEG). **You attach images by simply mentioning their URL in your text reply** — no special tool, no `wacli send image`, no `mcp__openclaw__message`. The adapter accepts:

- **Markdown image syntax** in the text: `![alt](https://example.com/cartoon.jpg)` — preferred, gives the user a clean caption.
- **Bare URL** ending in `.jpg / .jpeg / .png / .gif / .webp / .bmp / .heic` (with optional query string), anywhere in the text — auto-extracted.
- **Local file paths** the agent has on disk (e.g. a generated image saved to `/tmp/...png`).
- **Base64 data URIs** (`data:image/png;base64,...`) — works but bloats the JSON, prefer URLs.

If you generated/downloaded an image and only have a local path, that path in the reply text is enough. If you have a remote URL, paste it. The adapter does HTTP GET, validates `Content-Type: image/*`, and ships the bytes.

### Images always travel with a caption

When you reply with one or more images, **always pair them with a short text caption** (1 sentence is plenty — what is it, who/when/where). The adapter sends the caption to the watch's Talk tab as text, runs it through TTS so the user hears it spoken, and then renders the images on the Visuals tab. An image without a caption arrives silently and the user has no idea what they're looking at — feels like a glitch, not an answer.

> "Send me an image of a cartoon."
> ✅ Reply text:  
> &nbsp;&nbsp;`Here's a Sempé cartoon from the 60s — *Le petit Nicolas*.`  
> &nbsp;&nbsp;`![](https://upload.wikimedia.org/.../sempe-petit-nicolas.jpg)`  
> ❌ "Sending you a picture on WhatsApp." (Wrong channel — the user asked via the wrist.)
> ❌ Just the image URL, no caption sentence.

> "Wie sieht der Stau auf der A1 aus?"
> ✅ `10 km Stau bei Zürich-Nord.\n![](https://traffic.api/.../a1.png)`
> ❌ Just the image with no narration.

If you're sending several images at once (e.g. multiple cartoon options), one caption that frames all of them is fine — don't over-narrate.

### Do NOT route images through other channels

If the user asked via wristclaw, the image goes back through wristclaw — full stop. **Do not call `wacli send image`, `mcp__openclaw__message` with attachments, telegram media tools, or any other off-channel delivery to ship images that were requested through the wrist.** That sends the picture to the user's phone where they didn't ask for it; the wrist meanwhile buzzes with text-only and looks broken.

The single legitimate exception: the user explicitly says *"send the cartoon to my WhatsApp"* (or names another channel by name). Then ship through that channel, but the *confirmation* (`Sent.` / `OK, on WhatsApp.`) still goes back through wristclaw stdout.

## When the watch sends something

The native WristClaw channel handles encryption/decryption itself and routes decrypted messages into OpenClaw. You don't need to drive that loop — register the channel account and let the gateway run it.

The channel decrypts, routes through the agent, and relays the reply back encrypted.

## Health checks

- **Relay is up?** `curl -s https://wristclaw.app/health` → expect `ok`
- **Plugin installed?** `openclaw plugins inspect wristclaw --json` → expect `status: loaded`
- **Channel account configured?** `openclaw channels login --channel wristclaw` → expect relay/session details

## When something goes wrong

- **"relayURL doesn't match"**: payload was generated against an old relay address. The current canonical URL is `wss://relay.wristclaw.app/ws` (per `BRAND.md`). If a payload arrives with `wss://wristclaw.app/ws` (apex), still accept it — both endpoints proxy to the same backend container.
- **"sessionID already in use"**: another gateway or old adapter still holds that relay session. Stop the old process/gateway and retry.
- **No traffic from watch after ~30s**: the watch isn't joining. Ask the user to (a) confirm WristClaw is installed on his Watch, (b) confirm the iPhone app shows green "Relay reachable", (c) launch the watch app once to trigger `connectIfConfigured()`.

## Source layout (for reference)

- `../openclaw-plugin/` — native OpenClaw channel plugin, relay protocol, config schema, tests
- `SKILL.md` — pairing instructions for agents that receive WristClaw pairing payloads

## Extensions — server-driven shortcut tabs on the watch

OpenClaw can push **shortcut views** to the wrist. Each becomes a swipe-right tab on the watch with a button at the top; tapping the button sends an `extensionInvoke` back, and OpenClaw can stream `extensionResponse` messages (text / audio / image) which appear vertically under the button. Use these for high-frequency, low-friction actions: "Am I late?", "Daily memo", "What's the weather", whatever the user wires up.

### Define an extension (host → watch)

Send `MsgType.extensionDefine` (`0x0A`) with a JSON payload:

```json
{
  "id": "ext-late",
  "title": "Am I late?",
  "icon": "clock.badge.exclamationmark",
  "buttonLabel": "Check meeting",
  "prompt": "Tap to check the next calendar event"
}
```

- `id` (required, stable): identifies the extension across messages. Re-sending the same id updates the existing tab.
- `title` (required): tab label and headline on the view.
- `icon` (optional): SF Symbol name.
- `buttonLabel` (optional): button text; defaults to `title`.
- `prompt` (optional): one-line hint shown under the title.

### Remove an extension

Send `MsgType.extensionRemove` (`0x0B`) with `{ "id": "ext-late" }`.

### Respond to an invocation (host → watch)

When the watch user taps the button, you receive `MsgType.extensionInvoke` (`0x0D`) with `{ "id": "ext-late" }`. Reply with one or more `MsgType.extensionResponse` (`0x0C`) messages, each tagged with the same `id`. Order matters — first sent appears at the top of the response stream.

```json
{ "id": "ext-late", "kind": "text",  "text": "10:30 standup. You're 2 min away from on-time." }
{ "id": "ext-late", "kind": "audio", "text": "Listen", "payload": "<base64 AAC>" }
{ "id": "ext-late", "kind": "image", "text": "Route", "payload": "<base64 JPEG ≤40KB>" }
```

`text`, `audio`, and `image` can be mixed in any sequence — the watch stacks them vertically. Audio responses get a play button (no auto-play); image responses render inline.

### Suggested patterns

- **"Am I late?"** — invoke runs a calendar check; respond with text "Standup in 8m, train ETA 6m" and optionally a thumbnail of the route map.
- **"Daily memo"** — invoke triggers a calendar+task summary; respond with a short audio clip (AAC) summarizing today.
- **"Where am I?"** — invoke runs a location/poi lookup; respond with a thumbnail + caption.
- **"Mute notifications for an hour"** — invoke runs the action; respond with a confirmation text.

Define extensions when:
- The user has paired (the `wristclaw` channel account is configured), and
- You know their typical needs (calendar, recurring tasks). Push 2–6 useful shortcuts on first pair, more later.

Keep the extension catalog tight — every new tab is a swipe more between the user and the thing they actually do.

## What this skill does NOT do

- **Does not generate pairing payloads.** Those come from the iPhone app.
- **Does not store conversation history** — the channel is a stateless conduit; persistence is the agent's job.
