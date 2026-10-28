# Starmark

Your chat writes the highlight reel.
Viewers type `!star [why]`, join a glowing moment, and leave a constellation of highlights.
After the stream, share a starmap; open the next stream with its three brightest moments.

**Demo GIF:** _placeholder — record the overlay → card → cold-open loop before submission._

Starmark supports both a complete local **mock-mode** rehearsal and a real broadcaster Twitch connection. Mock mode needs no Twitch account; automated tests mock all Twitch HTTP and WebSocket traffic. No game footage, logos or third-party artwork are bundled. The approved visual reference is [design/mock-v2.html](design/mock-v2.html); behavior comes from [SPEC.md](SPEC.md).

## Five-minute setup

Use **Node 20.19+** (Node 20 LTS is selected by `.nvmrc`) and npm. From this folder:

```sh
# If you use nvm: nvm use
npm ci
test -f .env || cp .env.example .env
npm run setup
npm run dev
```

Open **http://localhost:3000/dashboard**. `npm run setup` downloads Chromium and caches the four Google Fonts families locally; allow a few minutes for the first download. Mock runtime and PNG export then work without internet. Browser binaries, font downloads, npm cache and renderer temporary files stay inside `.cache/` in this project. On a minimal Linux install, Chromium may additionally need system browser libraries.

The server defaults to mock mode and binds only to loopback. Real mode requires both `STARMARK_MOCK=0` and all three Twitch settings below; missing settings safely select mock mode. Change `PORT` and `PUBLIC_URL` together in `.env` if needed. Use Node 20.19 or later so `.env` can load through Node's built-in loader. No dotenv dependency.

All HTTP requests and WebSocket upgrades validate the literal Host and Origin. Allowed authorities are `localhost`, `127.0.0.1`, `[::1]` (with valid ports), or the exact host/port of `PUBLIC_URL`; arbitrary names resolving to loopback remain rejected. Browser Origins must match the validated request host/port or the configured public origin. Mock routes are not registered for live adapters; live initialization resets any stored mock-clock offset to zero. This is still a loopback app, not a public authenticated deployment.

WebSockets are receive-only: inbound text/binary messages close with 1003. The 1024-byte limit rejects oversized frames before message delivery with the standard 1009 close code. Known validation failures return safe 4xx responses; unexpected failures return only `Internal server error` (500).

```sh
npm test           # Vitest: pure logic, lifecycle and a real browser/PNG mock run
npm run build      # TypeScript checking + server and browser output in dist/
npm start          # Run the production build (after build and setup)
npm run demo       # While dev/start runs: eight stars, 82 lighters, JSON + PNG
```

For a different demo port: `STARMARK_URL=http://localhost:4318 npm run demo`. Demo refuses to replace an existing active stream. `.npmrc` avoids npm 10's optional Vitest devtools peer-resolution bug; the lockfile pins the tested dependency tree.

## Rehearse in mock mode

1. Click **Start mock stream**. Open `/overlay` and `/coldopen` in separate windows or OBS sources first if you want to watch events.
2. Send `!star he finally beat the boss` as `luma`. Send `!star` as two other names within 15 seconds to join the same star. Names are case-insensitive identities; the owner remains the first viewer.
3. The 15-second close creates one mock marker, one mock clip for at least three lighters, and one chat echo. The default per-user cooldown is 90 seconds; the global gap is 20 seconds measured from star opening. Exact 15-second boundary closes the star; exact cooldown/gap boundary is accepted.
4. Use **Generate mock chat** or **Advance 20s** to speed up the rehearsal. The generator advances the shared mock clock by three seconds every 1.1 real seconds. Both controls use the same engine and persistence path as manual chat. They affect the whole mock stream, including its duration.
5. Select Moderator/Broadcaster and send `!unstar`, or remove any current-stream star in the moderation queue. Removal retains anti-spam clocks; remote markers/clips would remain unchanged.
6. Click **End & make card**. This flushes the open star, resolves the mock archive and renders the PNG before returning. Use the saved stream's Card, JSON or PNG links. If rendering fails, the stream JSON remains safe; retry its PNG link after fixing setup.
7. Start another stream or click **Play last stream’s cold open** to trigger connected `/coldopen` pages. `/coldopen?play=1` plays immediately. Escape or Skip cancels; the source becomes transparent after 15 seconds.

Uncheck **Mock VOD saving** before closing a star to exercise marker 404 warnings and clip fallback. With no archive and fewer than three lighters, the star has a saved timestamp but no playable link. All `mock-vod-*` and `mock-clip-*` IDs are deliberately fictional; cold open uses the designed full-screen text/gradient treatment rather than requesting nonexistent clips. No Twitch account is needed.

**Counts:** a lighter is a unique viewer _within a star_. The card headline, dashboard and JSON use the sum of those per-star counts; a viewer who lights two different stars contributes twice. Ties in top-three ranking go to the earlier moment, then stable ID. Card links use the original ignition offset, not the later marker-close position. Bot echoes say `N of you`, including the owner. Markers say `★ @owner +N-1`, counting the other viewers: three lighters produce `3 of you` and `★ @owner +2`.

## OBS: three browser sources

Keep sources loaded (disable **Shutdown source when not visible**) so they receive WebSocket events. No custom CSS is needed. Overlay/cold-open pages are transparent; the dashboard preview supplies its own background.

| Source           | URL                                      | Size / placement                                                  |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Live sky         | `http://localhost:3000/overlay`          | 1920 × 1080; above your feed                                      |
| Cold open        | `http://localhost:3000/coldopen`         | 1920 × 1080; above the live sky; hidden by transparency when idle |
| Last stream card | `http://localhost:3000/card/<stream_id>` | 1080 × 1350; use in the intermission scene                        |

Overlay options (coordinates are in the 1920 × 1080 design canvas):

```text
/overlay?pos=bottom
/overlay?pos=top&aurora=0
/overlay?pos=compact&x=1480&y=330&width=380
/overlay?accent=ff9fb8&reasons=0&aurora=0
```

`pos` is bottom/top/compact. Compact `x`, `y`, `width` are clamped to the canvas. `accent` accepts a 3- or 6-digit hex color (URL-encode `#` if included). `reasons=0|1` overrides the names-only display setting. Aurora defaults on for bottom and off for top/compact. The time axis grows with the elapsed stream; bursts last approximately 2.5 seconds, with at most two active/queued bursts. Excess events go straight into the band. The command example appears for five seconds after each burst.

Card routes:

- `/card/<id>` — interactive, keyboard-accessible stars open VOD offsets or clip links.
- `/card/<id>.json` and `/api/streams/<id>` — stream plus `totalLighters`, `topThree`, `durationSeconds`, `cardUrl`.
- `/card/<id>.png` — exact 1080 × 1350 render of the same page, saved to `data/cards/`.

The card is intentionally opaque. Ended-card exports are cached; live-card exports reuse a PNG for up to 10 seconds, then regenerate. Offline waits for pending delivery and forces a fresh final export, even when a live render is in flight. Only the local app can be requested by the PNG browser, and fonts are served locally after setup.

## Architecture

```text
Dashboard / mock chat generator / Twitch EventSub WebSocket
                         |
                         v
                serialized stream service
                 |         |          |
          pure star     TwitchAdapter  WebSocket state + ignition events
            engine         |          |         |            |
                 |     MockTwitch or LiveTwitch
                 |                    /overlay  /coldopen  /dashboard
                 v
        atomic JSON files under data/
                 |
            /card/:id  ------> Chromium ------> /card/:id.png
```

- `server/engine.ts`: pure, immutable rules with an injected clock; no network/timers/storage.
- `server/service.ts`: lifecycle, serialized changes, close side effects, warnings and message-ID deduplication.
- `server/twitch.ts`: mock and live adapters, broadcaster OAuth, token refresh, EventSub sessions and Helix requests. `connection.state` reports connection changes; `stream.update` carries title/viewer-count updates. `server/twitch-tokens.ts` encrypts the private token file.
- `server/store.ts`: one `data/streams/<id>.json` per stream, atomic temp-file/rename writes; `data/state.json` keeps active ID, settings and mock clock offset.
- `server/app.ts`: Express HTTP, WebSocket server, mock controls, static pages, card endpoints.
- `server/render.ts`: on-demand Chromium export, one render per card at a time, local-only requests. Browser profile, artifacts and downloads use explicit project-local paths; temporary-directory environment overrides apply only to the browser child process, never to the server’s global `TMPDIR`.
- `web/`: TypeScript pages sharing the exact four-point star path and approved CSS foundation; no frontend framework.
- `tests/`: engine, service and end-to-end tests. Temporary test streams and visual evidence are written below `.cache/`; test data is cleaned afterward.

The single server serializes state/file mutations. Ordinary chat publishes only `{type:"chat", line}` and updates the bounded chat log, without scanning, saving or broadcasting the stream. Commands save and notify only when accepted or when they produce an engine event. Stream-history reads are cached and invalidated after `saveStream`.

Chat events carry `at` in epoch milliseconds: mock sources capture the arrival time before queuing, and the live adapter uses EventSub `metadata.message_timestamp`. The engine uses that timestamp for windows, cooldowns and offsets. Marker/clip/chat requests run in a background job after notifying clients; `delivery:"processing"` is a durable per-star lock. Results are merged back into the current stream by ID, so a slow request cannot overwrite new joiners or resurrect a moderated star. Offline drains delivery before resolving the archive and exporting the final card. Commands already queued ahead of offline are processed first.

The single server owns all stream mutations. Closed stars retain delivery status, marker position, original offset, clip ID and errors. Restart resumes active streams and pending closes in the same mode. Switching modes does not deliver a previous mock stream to Twitch. A delivery interrupted during an external call is flagged instead of blindly replayed; exactly-once remote writes across a crash cannot be guaranteed by a local JSON store. A storage failure pauses at the exact delivery checkpoint, shows a dashboard warning, and resumes after the next successful write (for example Save settings); completed remote calls are not replayed. Failed markers do not discard stars or block clip/chat processing. Clip attempts are capped at 20 per stream.

Reasons are NFKC-normalized; URLs, mentions and control characters are stripped; whitespace is collapsed; whole-word/phrase blocklist matches hide the reason (Unicode letters, combining marks, numbers and connector punctuation are word characters; `ass` does not match `class`); the remaining string is limited to 40 Unicode code points. Names and reasons are escaped/text-rendered on every page. Subscriber eligibility and names-only are configurable in the dashboard; mock chat has role/eligibility toggles. Automatic names-only is disabled in mock and uses the configurable viewer threshold in live mode.

## Task 2: real Twitch connection

After the install above, connecting takes about five minutes:

1. Register an application at [Twitch Developer Console](https://dev.twitch.tv/console). Set its OAuth redirect to **`http://localhost:3000/auth/callback`**. If you change `PORT`, register the corresponding localhost callback too.
2. In your existing ignored `.env`, set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_CHANNEL` (the broadcaster's login, without `@` or a URL). Keep these private; do not paste them into chat, screenshots, tests or source files. Preserve your existing `.env` when updating the project.
3. In Twitch **Creator Dashboard → Settings → Stream**, turn on **Store past broadcasts** for VOD links and stream markers. Enable clips too if you want the clip fallback. No Affiliate-only scope is requested.
4. Run `STARMARK_MOCK=0 npm run dev` and open **http://localhost:3000/dashboard**. Click **Connect Twitch**, sign in as the configured broadcaster, and authorize `user:read:chat`, `user:write:chat`, `channel:manage:broadcast`, and `clips:edit`. The localhost callback returns you to the dashboard. Starting the app without saved authorization does not open OAuth or call Twitch.
5. Wait for **Twitch connected**, then go live. Chat viewers type `!star`; three unique lighters within 15 seconds qualify for a clip. The echo is sent as the broadcaster. Stream start/end, title and viewer count come from Twitch; OBS source URLs remain the same. Going offline finishes the card automatically.

To rehearse again, stop the server and run `STARMARK_MOCK=1 npm run dev`. To remove authorization, click **Disconnect Twitch**; it closes EventSub, revokes the access token and deletes local tokens. If Twitch cannot be reached for revocation, the dashboard explains how to remove the connection in Twitch Settings → Connections. An authorization error enables Connect Twitch again.

Tokens live in ignored `data/twitch-tokens.json`, encrypted with AES-256-GCM using a key derived from the app secret, with owner-only file permissions. Keep both `.env` and `data/` private. Changing the app secret requires reconnecting. Authorization state is single-use, expires after ten minutes, and must match the initiating browser's HttpOnly cookie. Tokens are validated at startup and hourly, refreshed before expiry and after 401, and saved atomically. Request errors never include upstream response bodies or credentials.

A fresh EventSub session subscribes to chat/online/offline. Dropped connections reconnect with bounded backoff and resubscribe; Twitch's `reconnect_url` migration keeps the existing subscriptions, as specified in the [EventSub WebSocket protocol](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#reconnect-message). Missing keepalives trigger reconnection. Revocation stops the session and requires reconnecting. Helix reads retry transient failures; explicit 401/429 rejections may retry within a three-attempt limit. Ambiguous marker, clip and chat writes are never automatically replayed.

Archives are polled four times after offline (up to 14 seconds of backoff), matching `video.stream_id` exactly. If no matching archive is available, saved clips remain the fallback; timestamps are retained. Marker 404 shows the Store past broadcasts warning. Clips may take time to become playable, and Twitch/browser autoplay rules can require user interaction. Text fallback remains available in the cold open.

Automated checks cover OAuth, HTTP and EventSub with synthetic credentials and fake transports, plus real local browser/PNG rendering. They do not verify your credentials, Twitch permissions, non-Affiliate behavior, live clip playback or actual VOD availability. Complete a short live rehearsal yourself after connecting. `PUBLIC_URL` controls card addresses and the host allowlist; this remains a local app, not a public authenticated deployment.

## How Codex was used

Codex read the complete spec and rendered the approved second draft, implemented the typed engine/server/browser pages, added incremental commits, ran mock lifecycle and browser tests, inspected exported screenshots, and corrected rendering/interaction issues. The design source remains unchanged. No remote repository was created and nothing was pushed.

Before submission: complete a live Twitch rehearsal, replace the GIF placeholder, record the demo, and fill in the hackathon attribution/video links.
