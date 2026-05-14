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
- **"Show me / send me a picture of X"** → `read` the **send-image** skill at `~/.openclaw/workspace/skills/send-image/SKILL.md` and follow its playbook (Wikimedia → Google Images via the browser, download to `/tmp`, emit `MEDIA:/tmp/...`). The `image_generate` tool is globally denied — don't reach for it. *Never* output a `MEDIA:image-<digits>` placeholder; the adapter only ships real `/tmp/...` paths or real `https://...` image URLs.
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
- **`activity`** → physical activity from CoreMotion (stationary / walking / running / cycling / automotive). Use when the user asks what they're doing, or to adapt response length (e.g., shorter when running). Confidence: low / medium / high — don't over-state uncertain reads.
- **`altitude`** → barometric altitude and relative change from CMAltimeter. Use for "how high am I?", elevation-aware advice, or hike/ski context. `relativeAltitudeMeters` = change since monitoring started (useful for ascent tracking); `altitudeMeters` = GPS-merged absolute when available.
- **`workout`** → active `HKWorkoutSession` on the Watch. `isActive: true` = workout running. Fields: `activityType` (running/cycling/walking/swimming/other), `startedAt` (ISO8601), `elapsedSeconds`. Use to give workout-aware advice ("you've been running 23 minutes, ~4km"). `isActive: false` = no active workout.
- **`focus`** → `isFocused: true` means a Focus mode is currently active on the user's device (Apple does not share which mode for privacy). Keep replies short and notification-light when focused; do not emit `[action:notify…]` markers unless the user explicitly asked.
- **`nowPlaying.isPlaying`** → `true` = audio currently playing, `false` = paused. `playbackPositionSeconds` / `durationSeconds` for current track progress.
- **`as of`** → freshness of the snapshot. If older than ~5 minutes, treat with suspicion; the user may have moved.

**When a field shows the "not currently received" marker:**

- Don't fabricate a value or guess from prior context.
- Don't pepper the user with "is location on?" on every turn — they know.
- If the question genuinely needs that field, *briefly* mention it once ("Need location for that — looks like it's off or still loading."). Otherwise just answer using what you have, or fall back to a skill that doesn't depend on it (e.g. weather for a hardcoded city).
- A field that was present in a prior turn but is "not currently received" now has typically just timed out — try again in a few seconds if the user asked again.

**Caveat — context arrives just before audio, but not strictly atomically.** The watch fires the context send before the audio packet but does not await its completion. In ~99 % of turns the context is cached when audio transcription finishes, but the first turn after pairing or after the watch app cold-starts may see "as of: no snapshot received yet this session" — answer the user's question with what skills/general knowledge can do, and the snapshot will catch up by the next turn.

### Plain text only — no markdown

**Your reply is spoken aloud by a TTS engine.** Anything that reads as plain prose is fine; anything that needs a renderer to make sense is not. Specifically, do not use:

- `**bold**`, `*italic*`, `_underscore_`, `~~strike~~`
- Headings: no `#`, `##`, `###`, …
- Bulleted or numbered lists: no `- item`, `* item`, `1. item` line markers — write them as natural sentences ("first … then … finally …")
- Code fences (```…```), inline backticks (`code`), block quotes (`> …`)
- Tables, horizontal rules (`---`), or any other markdown syntax

Image links are the one exception (see *How to attach images* below) — the adapter parses `![alt](url)` and bare image URLs, then strips them from the spoken audio. Everything *else* you write should read naturally if a friend said it out loud.

If you're tempted to format a list, ask: would this still be useful if someone read it to me over the phone? If no, restructure into sentences. The watch screen is small and the audio path is unforgiving — clean prose serves both.

### Brevity

The wrist is a *small* surface and the user is usually on the move. Keep replies short, informative, and concrete — typically 1–3 sentences. No filler ("Sure! I'd be happy to help with that.") and no preamble. Get to the answer. If the user asked for something that requires a longer explanation, give the headline answer first, then the next step or the most useful detail. The wearer can always ask for more.

### Language

The user's spoken language is forwarded to you in the framed prompt as `[wristclaw] - detected language: <code>` (ISO 639-1, e.g. `de`, `fr`, `it`) when transcription metadata is available.

**Rule: always reply in the user's detected language.** The TTS engine picks a voice that matches the language of *your reply text* — German karlsson for German, English kokoro/af_bella for English. Mixing languages within a single reply will produce a wrong-accent voice for part of the text. If the user wrote in German, you write in German; the TTS picks German automatically.

If the detected language has no matching TTS voice (currently only `de` and `en` are wired up locally; everything else routes through the SDK provider), reply in that language anyway — the SDK fallback handles many more languages than the local engines do. The `[tts:xx]` marker exists as a last-resort escape hatch for cases where you must split text language from audio language:

```
<full answer in the user's language — this becomes the on-screen text>
[tts:en] <a short English equivalent — this becomes the spoken audio>
```

Use the marker only when you have a concrete reason to split (e.g. obscure dialect on-screen, common-language audio). Default to one-reply-one-language.

### Brevity examples

> "Wie ist das Wetter in Zürich?"
> ✅ "13 °C, leicht bewölkt. Heute Nachmittag Regenrisiko."
> ❌ "Aktuell sind in Zürich 13 Grad Celsius bei leichter Bewölkung, und im Verlauf des Nachmittags besteht eine erhöhte Niederschlagswahrscheinlichkeit, daher würde ich empfehlen, einen Regenschirm mitzunehmen, falls Sie planen, das Haus zu verlassen."

> "Was steht heute an?"
> ✅ "Standup 10:30, dann Lunch mit Anna 12:00, Demo 15:00. Sonst frei."
> ❌ Calendar dump in prose.

When *both* time pressure and detail matter (e.g. "Am I late for the train?"), lead with the answer ("Yes — leave now, 4 min walk"), then a single clarifier if it adds real value.

### Calendar — `gog` is already authed as `gado@sala.ch`

The `gog` Google CLI is authed as **`gado@sala.ch`** (default account, no `--account` flag needed; do *not* pass `--account=primary` — that's a wrong name and fails with "No auth for calendar primary"). Matthias Sala's three personal calendars (`Arbeit`, `Familie`, `Privat`) are already shared in as reader, so a single command sees everything:

```
gog calendar list --all --today        # today, every subscribed calendar
gog calendar list --all --tomorrow     # tomorrow
gog calendar list --all --days=7       # next week
```

`--all` is the magic flag — without it, `gog calendar list` only sees the primary calendar and you'll miss Matthias's work events. Event times are returned as RFC3339 with a Z suffix (UTC); convert to the user's local timezone (Europe/Zurich = UTC+2 in summer, UTC+1 in winter) before reasoning or rendering.

For "what's next" / "am I late" intents: filter events whose end is in the future relative to current local time. An event whose end is in the past is *not* "next" no matter where it sits in the list — discard it.

### Honesty over fabrication — when a tool fails, say so

**Never invent an answer because a tool refused.** Common failure modes you must not paper over:

- A calendar tool returns "no auth" → say "Calendar isn't connected; I can't check that right now." Do *not* recite events from earlier in the conversation as if they were current. Stale memory is not a substitute for live data.
- A browser snapshot is wrapped in `SECURITY NOTICE: ... EXTERNAL, UNTRUSTED source` → that's the anti-prompt-injection guardrail. You can read the *content* to inform your answer, but if you couldn't parse what you needed, admit it. Don't compose a plausible-looking answer.
- A skill returned an error or "not found" → admit the skill isn't available. Don't echo its expected output format with placeholder values.
- An image search returned nothing useful → say "I couldn't find a good image of X." Do *not* emit `MEDIA:image-<digits>` strings or `![](...)` with made-up paths. Those produce silent failures on the watch and make the user think it's broken.

The user's trust in this channel depends on the reply being grounded. "I can't check that" is a perfectly fine answer; a confident hallucination is not.

### Composing with other skills — read, don't invoke

The wristclaw skill is the *channel* skill: it explains how to format replies for the watch. It does NOT cover every domain. When the user asks for a picture, calendar info, location, weather, etc., a *content* skill takes over. Skills are loaded by **reading their SKILL.md with the `read` tool** — there is no `Skill()` invocation tool.

For "send me a picture / show me a photo of X" the relevant skill is **`send-image`** at `~/.openclaw/workspace/skills/send-image/SKILL.md`. After reading this wristclaw skill, also `read` send-image and follow its playbook. It drives Chrome on the openclaw desktop to find a real image on Wikimedia Commons / Google Images, downloads it to `/tmp`, and tells you to emit a `MEDIA:/tmp/...` line (which the wristclaw adapter then ships to the Visuals tab).

Do NOT call `send-image` as a tool — it isn't one, you'd get `Tool send-image not found`. Do NOT make up a `MEDIA:image-<digits>` placeholder; the adapter looks for a real `/tmp/...` path or an `https://...` URL ending in an image extension, and silently drops anything else.

Other useful skills you may need to read mid-turn: `findmyloc`, `meteoswiss`, `chimpy`, `whiterisk`, `arosa`. Their `<location>` paths are in the `<available_skills>` block at the top of the system prompt.

### Where images come from — never call `image_generate`

Two different intents, two different sources. Pick the right one *before* you reach for any tool.

**1. "Send / show me a picture of <a real thing>"** — ETH, Niesen, a Chimpy power bank, an Alfa Romeo Stelvio, last week's protest, a Sempé cartoon. The user wants an *existing* image of an *existing* subject. **Use web search to find an image URL**, paste it into the reply, done.

- Preferred: the browser-skill (`browse` / Chrome) for image searches, then copy the resulting image URL into the reply as Markdown.
- Acceptable: any web-search MCP that returns image links (Brave search, Google Images, Wikipedia, etc.).
- The adapter then HTTP-GETs the URL and ships the bytes through WristClaw to the Visuals tab.

An image-generation model *cannot* faithfully reproduce real-world subjects — even gpt-image-1.5 will hallucinate ETH's main building. Web search is the only correct path for "picture of <real>".

**2. "Generate / draw / create / imagine an image of <something synthetic>"** — a cartoon, a stylized illustration, a meme remix, an "imagine X in the style of Y." The user wants *new* art, not a real photograph.

- Use the **Claude CLI** or **Codex CLI** to drive image generation — they have working provider auth.
- Do NOT call the in-process `image_generate` tool. It routes through the `openai-codex` provider whose API key isn't configured for this agent (`/Users/gado/.openclaw/agents/main/agent/auth-profiles.json`) — every call fails with `No API key found`, the lane retries through the fallback cascade, and ~5 minutes later the user gets an apology instead of an image.

**Rule of thumb when the request is ambiguous:** if Google Images would return a useful result for the user's phrase, web-search. Otherwise generate. "ETH with mountain" → Google. "ETH but every window is a fish-eye lens" → generate.

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

## Local Actions — watch-native capabilities

WristClaw can execute system actions **directly on the Apple Watch** using watchOS-native APIs — no iPhone needed. Emit `[action:actionName key=value]` markers anywhere in your reply text — the relay strips them before display and TTS, dispatches each as a `LOCAL_ACTION` packet (0x10), and the Watch executes them immediately via `WatchLocalActionHandler`.

---

### 📳 Haptic feedback — always available

Fires the Watch's Taptic Engine.

| Action | Marker | Params |
|---|---|---|
| Haptic | `[action:haptic type=success]` | `type`: `success` `failure` `notification` `start` `stop` `click` `retry` `directionUp` `directionDown` |

Default type when omitted: `notification`.

**When to use:** confirm an action silently ("Done. [action:haptic type=success]"), signal an error ("Couldn't do that. [action:haptic type=failure]"), or acknowledge a command without speaking.

---

### ❤️ Health & fitness — always available

Native `HKWorkoutSession` on watchOS — keeps the watch display on, enables continuous heart-rate and calorie tracking. Sleep writes an `HKCategorySample` directly from the watch.

| Action | Marker | Params |
|---|---|---|
| Start workout | `[action:workoutStart type=running]` | `type`: `running` `cycling` `walking` `swimming` `other` |
| End workout | `[action:workoutEnd]` | — |
| Start sleep tracking | `[action:sleepStart]` | — |
| End sleep tracking | `[action:sleepEnd]` | — |

**When to use:** "start a run", "begin workout", "I'm going to sleep", "stop workout". `sleepEnd` writes the session to Health — both markers must appear (in separate turns) for a valid sleep record.

---

### 🔔 Notify — always available

Posts a local notification directly on the Watch via `UNUserNotificationCenter`.

| Action | Marker | Params |
|---|---|---|
| Notify | `[action:notify title=Reminder body=Take your medicine]` | `title`: notification title; `body`: notification body |

**When to use:** schedule a reminder the user explicitly asked for, or deliver a time-delayed message. Don't use for confirming things you're already saying in text — use haptic instead.

---

### 📊 Health read — always available

Reads the latest value from `HKHealthStore` and surfaces it as a Watch notification.

| Action | Marker | Params |
|---|---|---|
| Read health | `[action:healthRead metric=heartRate]` | `metric`: `heartRate` \| `steps` |

`heartRate` returns the most recent sample. `steps` returns cumulative steps since midnight. Result appears as a local notification on the Watch.

**When to use:** "what's my heart rate?", "how many steps today?". The result appears as a notification — tell the user to check their watch.

---

### 🎵 Media play/pause — user opt-in (`localCap.media`, ON by default)

Controls WristClaw's own TTS audio output on the Watch (replay / pause the agent's spoken reply).

| Action | Marker | Params |
|---|---|---|
| Resume / replay TTS | `[action:mediaPlay]` | — |
| Pause TTS | `[action:mediaPause]` | — |

**Why this is the only media control:** watchOS exposes no public API for a third-party app to drive Apple Music, Spotify, Podcasts, or any other media app. Standalone-watch operation is the design constraint, so the agent cannot remotely set a playlist or pause a streaming app.

**What happens automatically (no marker needed):** WristClaw's `AVAudioSession` uses `.playback` with `.notifyOthersOnDeactivation`. When the TTS reply starts playing, watchOS auto-pauses whatever the user was listening to (Apple Music, Spotify, etc.); when the TTS ends, those apps auto-resume. The agent should not narrate this behavior.

**When to use a marker:** "Replay your last answer." → `[action:mediaPlay]`. "Stop talking." / "Pause for a sec." → `[action:mediaPause]`. If the user asks to pause Spotify or skip a track, say plainly that WristClaw can't control other apps' players on the Watch — don't emit a marker that won't do anything.

---

### ⏱ Alert timer — user opt-in (`localCap.timer`)

Schedules a local Watch notification to fire after a delay.

| Action | Marker | Params |
|---|---|---|
| Set timer | `[action:timerSet seconds=300 label=Pasta ready]` | `seconds`: duration (required); `label`: notification title (optional, default "Timer") |

**When to use:** "remind me in 5 minutes", "set a timer for 30 seconds", "alert me in an hour". Convert times to seconds. A haptic `.start` fires immediately to confirm.

---


### Action syntax reference

```
[action:actionName]                         — no params
[action:actionName key=value]               — one param
[action:actionName key=value key2=value2]   — multiple params (space-separated key=value pairs)
```

Markers are stripped before the text reaches the watch screen and TTS engine. Always pair them with a short confirmation sentence so the user knows something happened:

> "Got it. [action:haptic type=success]"  
> "Workout started — have a great run! [action:workoutStart type=running]"  
> "Check your watch for your heart rate. [action:healthRead metric=heartRate]"  
> "Replaying. [action:mediaPlay]"  
> "Paused — say *replay* when you're ready. [action:mediaPause]"  
> "Timer set — I'll buzz you in 5 minutes. [action:timerSet seconds=300 label=Reminder]"

## What this skill does NOT do

- **Does not generate pairing payloads.** Those come from the iPhone app.
- **Does not store conversation history** — the channel is a stateless conduit; persistence is the agent's job.
