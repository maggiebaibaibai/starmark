# Starmark — Devpost draft (v1, 2026-10-31)

Fields follow the Devpost project form. Bracketed items are filled in after the live rehearsal and recording.

---

## Tagline (≤ 60 chars)

Your chat writes the highlight reel.

## Elevator pitch (≤ 200 chars)

Viewers type `!star` the moment something great happens. A star ignites on stream with their name, Twitch drops a marker and a clip, and next stream opens with last night's three brightest stars.

---

## Inspiration

Every streamer has the same problem the morning after: a four-hour VOD, and somewhere in it the ten seconds everyone was screaming about. Chat knew exactly when it happened. Chat just had no way to write it down.

Twitch already has the pieces: stream markers, clips, VOD timestamps. But a marker is something the streamer remembers to press, and a clip is something one viewer makes alone. We wanted the moment to belong to the people who were there: the first viewer who called it, and everyone who piled on in the next fifteen seconds.

So the idea became a sky. Each great moment is a star. The more of chat that joins, the brighter it gets. By the end of the night the stream has drawn its own constellation, and every star points back to the exact second it was born.

## What it does

**During the stream**
- A viewer types `!star` (optionally `!star that dodge`). A star ignites on the overlay with their name, large for two seconds, then settles onto a thin time band at the top or bottom of the screen.
- Anyone else who types `!star` within 15 seconds joins that star. Their names appear under it and the star grows.
- When the star closes, Starmark creates one official Twitch **Stream Marker** (`★ @owner +12: that dodge`) and, if at least three people joined, one **Clip**. The bot answers in chat: `⭐ @luma lit a star at 1:47:00 · 13 of you`.
- The overlay is transparent, 96 px tall, and can sit at the top, bottom, or tucked under the webcam, so it never covers a HUD or a VTuber model.

**After the stream**
- Starmark builds a **starmap card** (1080 × 1350): every star placed by time and by how many people lit it, the top three in gold with their names and reasons. Tap any star and it opens the VOD at that exact second, or the clip if the VOD isn't saved. One click exports a PNG ready for social media.

**Next stream**
- A 15-second **cold open** plays when the stream goes live: a flight across last night's sky, then the three brightest moments full screen, each credited to the viewer who lit it. "Previously on" written by chat.

**For the streamer**
- Per-user cooldown and a global gap between stars, so it can't be spammed.
- Reasons are sanitized (links, mentions and blocklisted words removed) and can be hidden entirely, so only names show on stream.
- Mods and the broadcaster can `!unstar` the last star or remove any star from a queue.
- Works for any channel. No Affiliate or Partner features, no Extension review.

## How we built it

- **Node.js 20 + TypeScript**, one process, `npm run dev` starts everything. Express for HTTP, `ws` for live updates to the overlay pages.
- **Twitch EventSub over WebSocket** for `channel.chat.message`, `stream.online` and `stream.offline`, with reconnect and resubscribe on drop.
- **Twitch Helix**: Create Stream Marker, Create Clip, Send Chat Message for the echo, Get Videos to find the VOD that matches this stream's ID after it ends.
- **Broadcaster OAuth** on localhost with only four scopes: `user:read:chat`, `user:write:chat`, `channel:manage:broadcast`, `clips:edit`. Tokens are encrypted at rest.
- **The star engine is pure code.** Merge window, cooldowns, unique-viewer counting and top-three ranking are deterministic functions with an injected clock. No model decides what counts as a highlight; chat does.
- **Pages are plain TypeScript and CSS**, used directly as OBS browser sources: `/overlay`, `/coldopen`, `/card/<id>`, `/dashboard`.
- **The card PNG** is the same page rendered by Playwright's Chromium, so the shared image and the interactive card are pixel-identical.
- **Mock mode** runs the whole loop with no Twitch account: a fake chat generator, mock markers and clips, a shared mock clock. Tests and rehearsal both use it.

### How Codex was used

We wrote a one-page spec and drew the design first (overlay, card, cold open as a static mock). Codex then built the project from that spec in small commits: the typed engine, the service layer, the Twitch adapter, the browser pages, and the test suite. It ran the mock lifecycle end to end, opened the exported PNGs to check them against the design, and fixed what didn't match. When we connected a real Twitch account, Codex worked through the EventSub edge cases with us: keepalive grace, reconnect while a token refresh is pending, a stream restarting before the last one finished draining. Every fix landed as its own commit with a test. A second agent reviewed each batch of changes before we merged them.

## Challenges we ran into

- **Markers 404 when VODs aren't saved.** Many streamers have "Store past broadcasts" off. Starmark detects the 404, warns the streamer on the dashboard, and falls back to clips so the card still links somewhere.
- **Finding the right VOD after the stream.** The archive isn't always ready the instant the stream ends. We poll with backoff and match `video.stream_id` exactly instead of guessing "latest video."
- **Readability on a phone.** Our first overlay was a pretty 300 px gradient band. Watched on a phone, names shrank to 4 px and it covered every game HUD. We cut it to a 96 px transparent band and made the ignite moment big instead.
- **Keeping it honest about time.** Chat arrives with Twitch's own timestamp; the engine uses that, not the server clock, so offsets on the card match the VOD.

## Accomplishments that we're proud of

- The whole loop works on a normal, non-Affiliate channel: chat → star → official marker and clip → card → cold open.
- Nothing in it is decided by a model. The highlights are exactly what the audience chose.
- It installs in about five minutes from the README, and mock mode lets a judge see everything without a Twitch account.
- No logos, game art, or copyrighted assets anywhere; fonts are open-source.

## What we learned

- The best interaction is one word. `!star` needs no explanation; the first ignition teaches the rest of chat.
- Credit matters. Putting the viewer's name on the moment changes it from a bookmark into something people want to share.
- Twitch's free building blocks (markers, clips, EventSub) are enough to build something that feels native without asking for special status.

## What's next

- Starmaps across a whole month: which viewers keep finding the best moments.
- Shared skies for co-streams, where two channels light stars on one map.
- A one-click "post to socials" with the card and the top clip.

## Built with

typescript · node.js · express · websocket · twitch-eventsub · twitch-helix-api · playwright · vitest · codex

---

## Links

- Demo video: [YouTube/Vimeo link, ≤ 3:00]
- Repository: [GitHub link — make public only after review]
- Try it: README → "Rehearse in mock mode"
