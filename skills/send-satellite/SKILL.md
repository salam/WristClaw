---
name: send-satellite
description: Take a Google Maps satellite/aerial screenshot at a specific coordinate (or named place) and deliver it to the user on the channel they asked from. Use when the user says "send me a satellite image / aerial view / map / vom oben of my location / of <place>". Distinct from send-image — this is a screenshot of a real-time map view at real coordinates, not a stock photo lookup. Drives Chrome via the `browser` tool, saves a PNG to /tmp, ends with `MEDIA:/tmp/<file>.png` so the wristclaw adapter ships it to the Visuals tab.
---

# send-satellite

Deliver a Google Maps satellite screenshot at a real lat/lon. **Not** a stock photo — a screenshot of the live map at the user's actual coordinates (or a named place).

## When to use this skill instead of send-image

- "satellite image / aerial view / view from above / Luftbild / Satellitenbild"
- "where am I — show it on a map / show me / aerial photo of here"
- "map of <place>" — when the user wants the map view, not a stock photo
- "what does X look like from above"

If the user just wants a stock photo of a thing (a car, a person, a building), use **send-image** instead.

## Steps

### 1. Resolve the location

- If "my location" / "here" / "where I am" → use the lat/lon from the `[ambient context]` section of this turn (`findmyloc` auto-injects user's current phone/watch position there every turn). Read the most recent fix for the user's primary device (`iPhone Matt` / `Apple Watch von Matthias`).
- If a place name → use the name directly; Google Maps will geocode.

### 2. Build the URL

For lat/lon (recommended — exact position):

```
https://www.google.com/maps/@<lat>,<lon>,<zoom>z/data=!3m1!1e3
```

`!3m1!1e3` is the URL fragment that switches Google Maps to satellite view. `<zoom>z` controls altitude; pick:
- `17z` — close-up of a single building (~150 m across)
- `15z` — neighborhood (~600 m)
- `13z` — town overview (~2 km)
Default to `16z` unless the user asks otherwise.

For a place name (when no lat/lon is available):

```
https://www.google.com/maps/place/<encoded_name>/@<approx_lat>,<approx_lon>,16z/data=!3m1!1e3
```

If you only have a name, first navigate to `https://www.google.com/maps/search/<encoded_name>` and let Google geocode it, then read the resulting URL and re-navigate with the `!3m1!1e3` satellite suffix.

### 3. Open the browser tab

```
browser(action="open", label="maps", url="<above-URL>")
```

### 4. Wait for tiles to load (~1500 ms)

Satellite tiles are lazy-loaded. After `open`, snapshot once to ensure the page reached interactive state, then wait a beat for image tiles to fetch. If you act too early, the screenshot will be mostly gray placeholder squares.

```
browser(action="snapshot", targetId="maps")
# pause ~1.5s
```

### 5. Take the screenshot

```
browser(action="screenshot", targetId="maps", path="/tmp/satellite-<unix_ms>.png")
```

Use a unique timestamped filename so concurrent calls don't collide.

### 6. Reply

Two-line reply format. **First** line: a brief human-readable caption. **Last** line: the MEDIA marker (must be the final line of your message, no trailing whitespace).

```
You are at <lat>,<lon> in <placename>. Here's the satellite image.
MEDIA:/tmp/satellite-<unix_ms>.png
```

Notes:
- Keep the caption short (one sentence) — Apple Watch screen.
- If the place name is unknown, just say "Here's the satellite image of your current location."
- If you're on a non-English wrist locale, reply in the user's language (`[ambient context]` includes `detected language`).

### 7. Tab hygiene (optional, post-reply)

`browser(action="close", targetId="maps")` if you don't expect a follow-up.

## Failure modes

- **No location available** (findmyloc fix is stale / device missing): say so honestly. "I don't have a fresh location fix; let me know where you are or what place you want a satellite image of."
- **Tile-load timeout** (screenshot all-gray): retry once after another 1.5 s wait. If still empty, snapshot and inspect; Google sometimes throws a captcha / consent banner on first visit — those need to be dismissed first.
- **Place name geocodes to wrong country**: Google Maps may pick the most popular match. Add region context to the search (e.g. `Stans NW Switzerland`).
- **MEDIA marker invisible at the watch**: ensure the file actually exists at the path you wrote on the last line, the path is `/tmp/...`, and the file is a real PNG/JPG (not a 0-byte stub). The adapter silently drops paths it cannot read.

## Why not just open Google Maps and call it done

The screenshot is the deliverable — the watch can render an image thumbnail in the Visuals tab, not a URL. URL-only replies show up as plain text on the watch and lose the visual payoff of the request.
