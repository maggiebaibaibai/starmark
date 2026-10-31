# Starmark — demo video script (v1, 2026-10-31)

Target length 2:40 (hard limit 3:00). 1920 × 1080, 30 fps.

Rules this script follows (from the rules page and the organizers' update):
- Show it running on real Twitch, and show Codex.
- First 30 seconds say what problem it solves.
- No copyrighted music, no third-party logos or game footage. Use silence, room tone, or an original/royalty-free track.
- No waiting on screen and no long terminal shots. Cut every load.

What to stream behind the overlay: something with no trademarks. A drawing canvas, a cooking table, a walk, or a plain "just chatting" camera. Avoid games (their logos and art count as third-party material).

Accounts: the broadcaster plus at least three viewer accounts (or friends) typing in chat, so a star gets three lighters and a clip.

VO = voice-over. Captions carry the same words, so it works muted.

---

## 0:00 – 0:06 · Cold hook

**Screen:** Live stream, full frame. Chat column on the right. A viewer types `!star she actually did it`. A big gold star bursts onto the screen with `@luma` under it. Two more names pop in under it within a second: `@kai @momo`. The star swells.

**VO:** (none, let the moment play)

**Caption:** `Your chat writes the highlight reel.`

## 0:06 – 0:25 · The problem

**Screen:** Quick cut to a long VOD timeline scrubbing fast, nothing found. Then back to chat scrolling: "WAIT", "CLIP THAT", "no way".

**VO:** "Every stream has a moment chat goes crazy for. The next day it's buried in a four-hour VOD. Chat knew exactly when it happened. Chat just had no way to write it down."

**Caption:** `Chat knows when the moment happens. Starmark lets them mark it.`

## 0:25 – 1:05 · Live: lighting a star

**Screen:** Back on the live stream. Show the thin transparent band along the bottom with a few stars already on it.
1. Viewer types `!star that save`. Big ignition, name, reason in italic. (2 s)
2. Two more viewers type `!star` within 15 seconds. Their names stack under it, the star grows. (show the count `+2`)
3. The star settles onto the band at its point in time.
4. Bot replies in chat: `⭐ @kai lit a star at 0:41:12 · 3 of you`.
5. Split screen for 3 seconds: the Starmark dashboard queue shows the star with its `MARKER + CLIP` badge, and Twitch's own Stream Manager shows the new marker `★ @kai +2: that save`.

**VO:** "Anyone in chat types star. Their name lights up on stream. Everyone who joins in the next fifteen seconds makes it brighter. Starmark drops an official Twitch marker and, when three or more people agree, a clip. Chat gets a receipt."

**Caption on the split:** `Real Twitch: Stream Marker + Clip, created from chat.`

## 1:05 – 1:20 · It stays out of the way

**Screen:** Three quick frames of the overlay settings: band at the bottom, band at the top, compact under the webcam. Then the moderation queue: a mod types `!unstar`, the last star disappears.

**VO:** "Ninety-six pixels, transparent, top, bottom, or under the cam. Cooldowns stop spam. Mods can unstar anything."

## 1:20 – 1:50 · After the stream: the starmap

**Screen:** Streamer stops the broadcast in OBS (Twitch sends stream offline; Starmark builds the card by itself). Cut (no waiting) to the card: `Last night you lit 8 stars`. Stars placed by time and by how many lit them, top three in gold with names and reasons.
1. Click a gold star. It opens the VOD at that exact second. Show the playhead land on the moment. (3 s)
2. Click `PNG ↓` on the dashboard. The image appears in a phone frame, as if posted.

**VO:** "When the stream ends, chat's stars become a map. Every star opens the VOD at the second it was born. One click, and it's an image you can post."

## 1:50 – 2:10 · Next stream: cold open

**Screen:** Streamer goes live again. The cold open plays full screen: a flight across last night's sky, `3 · 2 · 1`, then the top moment with `lit by @luma + 20`.

**VO:** "Next stream opens with last night's three brightest stars, credited to the viewers who called them. Previously on, written by chat."

## 2:10 – 2:30 · Built with Codex

**Screen:** Codex in the terminal for about 8 seconds, real footage: the spec file on the left, Codex running the mock lifecycle test, then opening the exported card PNG to check it. Cut to `git log --oneline` scrolling through small commits.

**VO:** "We designed it first, wrote a one-page spec, and built it with Codex in small, tested commits, from the star engine to the Twitch connection. No model decides what's a highlight. The audience does."

## 2:30 – 2:40 · Close

**Screen:** The starmap card fills the frame, the gold stars twinkle once.

**Caption:** `Starmark · Your chat writes the highlight reel. · Works on any Twitch channel.`

---

## Shot list to capture during the rehearsal stream

1. The very first `!star` with three viewers joining (record several, pick the best).
2. Chat echo line from the bot.
3. Dashboard queue with the `MARKER + CLIP` badge, and Twitch Stream Manager showing the marker.
4. Overlay in all three positions.
5. `!unstar` from a mod.
6. End stream → card → click star → VOD lands on the second.
7. PNG export.
8. Go live again → cold open plays.
9. Codex terminal footage (can be recorded separately).

## Before recording, check

- Store past broadcasts is on (VOD links and markers need it).
- Clips are enabled on the channel.
- OBS has the three browser sources loaded, "shutdown when not visible" off.
- No game, no music with lyrics or label, no logos in frame.
