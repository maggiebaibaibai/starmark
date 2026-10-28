# Starmark — spec (v1, 2026-10-28)

依据：design/mock-v2.html（第二稿，设计已定）；本文件。

## One line

Your chat writes the highlight reel. Viewers type `!star <why>` during a live stream; a star ignites on the stream overlay with their name; after the stream a shareable starmap card links every star to its VOD second; the next stream opens with a short cold open of last stream's brightest stars.

## Hackathon constraints (Codex x TwitchCon, Devpost, due 2026-11-02 14:00 PT)

- Interactive experience that connects to Twitch (chat, overlay, Twitch API, EventSub). No Twitch Extension. Must work for non-Affiliate channels.
- Built with Codex; keep commits small with clear messages.
- No third-party trademarks or copyrighted assets anywhere (no Twitch logo, no Twitch purple #9146FF as accent, no game assets). Fonts: Google Fonts only (Instrument Serif, Space Grotesk, JetBrains Mono, Noto Serif JP fallback).
- Must install in five minutes from README; `.env.example`, no secrets committed.

## Architecture

- Node.js 20+, TypeScript, single process. `npm run dev` starts everything.
- `server/`: Express (or Fastify) HTTP + WebSocket (`ws`) to overlay pages.
- Twitch: OAuth Authorization Code for the broadcaster (local redirect `http://localhost:PORT/auth/callback`). Scopes: `user:read:chat`, `user:write:chat`, `channel:manage:broadcast`, `clips:edit`. Token refresh.
- EventSub over WebSocket: `channel.chat.message`, `stream.online`, `stream.offline`.
- Helix: Create Stream Marker (description ≤140 chars), Create Clip, Get Videos (`type=archive`, user_id) to resolve the VOD id, matching `video.stream_id === stream.id`, Send Chat Message for the bot echo.
- Storage: one JSON file per stream under `data/streams/<stream_id>.json` (plus `data/state.json`). No database.
- Pages (served by the server, used as OBS Browser Sources at 1920×1080, transparent background):
  - `/overlay` — the live band + ignite burst.
  - `/coldopen` — cold open; plays when `stream.online` fires or when the page receives `?play=1`; also playable from a dashboard button.
  - `/card/<stream_id>` — 1080×1350 starmap card (interactive web version: tap a star → VOD link); `/card/<stream_id>.png` export.
  - `/dashboard` — connect Twitch, settings, mod queue, list of streams, "play cold open", "export card".
- Mock mode (`STARMARK_MOCK=1`): no Twitch; a fake chat generator + a dashboard box to type `!star` as any name. Everything else identical. This is how tests and the demo rehearsal run.

## Star logic

- Command: `!star` optionally followed by a reason (≤40 chars after trim). URLs and @mentions stripped from reasons; streamer blocklist whole words/phrases (Unicode-aware boundaries) → reason hidden. Reason optional.
- Merge window 15 s: any `!star` within 15 s of an open star joins it (adds the user to `lighters`); first user is the owner.
- Count unique users only. Per-user cooldown 90 s (configurable). Global minimum gap between stars 20 s (configurable; joins still allowed).
- Options: subs-only off by default (followers-only omitted to avoid an extra scope); "names only" (hide reasons on stream) on by default for channels over a configurable size, off in mock.
- Mods/broadcaster: `!unstar` removes the last star (and its marker description is not editable, so just drop it from our data).
- On star close (15 s after open): create one Stream Marker (description `★ @owner +N-1: reason`, where N is all lighters including the owner), and if lighters ≥ 3 create one Clip (cap 20 per stream). Store `marker.position_seconds`, `clip_id`. Always store our own offset `now - stream.started_at` so it works if marker fails.
- Bot echo in chat after close: `⭐ @owner lit a star at 1:47:00 · 21 of you` (only one echo per star; the count includes the owner, while marker `+N-1` counts additional lighters).
- If VOD saving is off, markers return 404: show a dashboard warning with what to turn on; card falls back to clip links.

## Overlay (/overlay) — follow design/mock-v2.html exactly

- Transparent page. Positions: `bottom` (default), `top`, `compact` (under the cam; x/y/width configurable). Query params override: `?pos=&accent=&aurora=0&reasons=0`.
- Thin axis line, star per moment along stream time (axis scales with stream length so far, not a fixed 3 h), gold for the current top 3.
- Ignite burst: big star 160 px, name 60 px, reason 44 px serif italic, lighters line updating live (`@a @b @c +N`), ~2.5 s, then settles into the band. Queue max 2 bursts; extra stars go straight to the band.
- Aurora (chat speed) optional, soft blurred curtain, off by default for `top`/`compact`.
- After each star, a rotating example `try: !star that dodge` for 5 s. No permanent title other than `TONIGHT'S SKY · N ★` small mono.

## Card (/card)

- As in the mock: headline `Last night you lit N stars`, stream title, date, length, total lighters (same number everywhere), y = number of lighters (`more of you ↑`), x = time, top 3 gold with numbered badges and reason + lighters, footer with `twitch.tv/<channel>` and the card URL.
- Tap a star → `https://www.twitch.tv/videos/<vod_id>?t=1h47m0s` (or the clip URL if no VOD).
- PNG export 1080×1350 (server-side render; e.g. Playwright screenshot of the page, or satori/resvg). Pick the simplest reliable one.

## Cold open (/coldopen)

- 15 s default, skippable, as in the mock: title → fly across last stream's sky → 3,2,1 → each of the top 3 full-bleed (clip embed `clips.twitch.tv/embed?clip=…&parent=localhost&autoplay=true&muted=false`, with text fallback if embed fails) with big italic reason + credits → end on `Tonight's sky is empty. Type !star to light the first one.`
- Triggered by `stream.online` (overlay page connected) or dashboard button.

## Quality bar

- Unit tests (vitest) for: merge window, cooldowns, unique users, reason sanitizing, offset → `?t=` formatting, top-3 ranking, `!unstar`.
- An end-to-end mock test: fake stream start → 8 stars with joiners → stream end → card JSON matches → PNG exists.
- README: what it is (3 lines + GIF placeholder), 5-minute setup (create Twitch app at dev.twitch.tv/console, redirect URL, `.env`), OBS setup (three browser sources), mock mode, architecture diagram (text), how Codex was used.
- No console errors on overlay pages. Fonts load from Google Fonts with fallbacks.
