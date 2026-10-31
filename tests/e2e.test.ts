import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { LiveTwitch, MockTwitch } from "../server/twitch.js";
import type { Stream } from "../server/engine.js";
import type { Browser } from "playwright";
let server: Awaited<ReturnType<typeof createApp>>,
  base: string,
  root: string,
  browser: Browser;
const errors: string[] = [];
async function post(path: string, data: object = {}) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}
beforeAll(async () => {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  await mkdir(resolve(".cache/tmp"), { recursive: true });
  process.env.TMPDIR = resolve(".cache/tmp/e2e-browser");
  await mkdir(process.env.TMPDIR, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/ms-playwright");
  await build({
    entryPoints: ["web/app.ts"],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: "dist/public/app.js",
  });
  root = await mkdtemp(resolve(".cache/tests/e2e-"));
  server = await createApp({
    dataDir: root,
    clock: () => Date.UTC(2026, 9, 28, 20),
    tick: false,
  });
  base = await server.listen(0);
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    channel: "chromium",
    args: ["--disable-gpu"],
  });
}, 30000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
describe("end-to-end mock run", () => {
  it("starts → eight stars with unique joiners → ends → saves matching JSON and real 1080×1350 PNG; pages work", async () => {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws"),
      events: Record<string, unknown>[] = [];
    ws.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((yes) => ws.once("open", () => yes()));
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(base + "/dashboard");
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
    );
    await page.getByRole("button", { name: "Start mock stream" }).click();
    await page.waitForFunction(
      () => document.getElementById("liveState")?.textContent === "● LIVE",
    );
    await page.locator("#message").fill("ordinary chat stays lightweight");
    await page.getByRole("button", { name: "Send to chat" }).click();
    await page.waitForFunction(() =>
      document
        .getElementById("chat")
        ?.textContent?.includes("ordinary chat stays lightweight"),
    );
    const active = (await (await fetch(base + "/api/state")).json())
      .active as Stream;
    const counts = [3, 7, 11, 16, 8, 21, 4, 12],
      offsets = [640, 1720, 2980, 4105, 5300, 6420, 7790, 9100];
    const owners = [
      "miso_",
      "kettle.exe",
      "ana_lune",
      "pixelbreak",
      "hoshi",
      "luma",
      "ttiny",
      "marigold",
    ];
    const reasons = [
      "first raid of the night",
      "that dodge??",
      "cat walked on the keyboard",
      "clutch 1v3",
      "やっと勝った",
      "he finally beat the boss",
      "new personal best",
      "raid out",
    ];
    let elapsed = 0;
    const overlay = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    overlay.on("pageerror", (e) => errors.push(e.message));
    overlay.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await overlay.goto(base + "/overlay");
    await overlay.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
    );
    for (let i = 0; i < 8; i++) {
      await post("/api/mock/advance", { ms: (offsets[i]! - elapsed) * 1000 });
      elapsed = offsets[i]!;
      await post("/api/mock/chat", {
        name: owners[i],
        text: "!star " + reasons[i],
      });
      for (let j = 1; j < counts[i]!; j++)
        await post("/api/mock/chat", { name: `join${i}_${j}`, text: "!star" });
      if (i === 0) {
        await overlay.waitForFunction(() =>
          document
            .querySelector(".burst .j")
            ?.textContent?.includes("@join0_2"),
        );
        expect(await overlay.locator(".burst svg").getAttribute("width")).toBe(
          "160",
        );
        await overlay.screenshot({
          path: ".cache/overlay-burst.png",
          omitBackground: true,
        });
      }
      await post("/api/mock/advance", { ms: 15000 });
      elapsed += 15;
    }
    await overlay.waitForFunction(
      () => document.getElementById("cnt")?.textContent === "8",
    );
    for (const pos of ["bottom", "top", "compact"]) {
      await overlay.goto(
        base +
          `/overlay?pos=${pos}&x=1400&y=340&width=400&accent=ff9fb8&aurora=0&reasons=0`,
      );
      await overlay.waitForFunction(
        () => document.documentElement.dataset.ready === "true",
      );
      expect(
        await overlay.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
      ).toBe("rgba(0, 0, 0, 0)");
      expect(await overlay.locator("#cnt").textContent()).toBe("8");
      expect(
        await overlay.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--gold"),
        ),
      ).toBe("#ff9fb8");
      await overlay.screenshot({
        path: `.cache/overlay-${pos}.png`,
        omitBackground: true,
      });
    }
    await post("/api/mock/advance", { ms: (9600 - elapsed) * 1000 });
    const ended = await post("/api/mock/end");
    expect(ended.id).toBe(active.id);
    const card = await (await fetch(base + `/card/${active.id}.json`)).json();
    expect(card.stars).toHaveLength(8);
    expect(card.totalLighters).toBe(82);
    expect(card.durationSeconds).toBe(9600);
    expect(
      card.stars.map((s: Stream["stars"][number]) => s.lighters.length),
    ).toEqual(counts);
    expect(
      card.stars.map((s: Stream["stars"][number]) => s.offsetSeconds),
    ).toEqual(offsets);
    expect(
      card.topThree.map(
        (id: string) =>
          card.stars.find((s: Stream["stars"][number]) => s.id === id).owner
            .name,
      ),
    ).toEqual(["luma", "pixelbreak", "marigold"]);
    const stored = JSON.parse(
      await readFile(server.store.streamPath(active.id), "utf8"),
    );
    expect(stored.stars).toEqual(card.stars);
    const png = await readFile(server.store.pngPath(active.id));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1350);
    expect(png.length).toBeGreaterThan(10000);
    await writeFile(".cache/export-card.png", png);
    const pngResponse = await fetch(base + `/card/${active.id}.png`);
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await pngResponse.arrayBuffer())).toEqual(png);
    const adapter = server.adapter as MockTwitch;
    for (const method of ["createMarker", "createClip", "sendChat"])
      expect(adapter.calls.filter((c) => c.method === method)).toHaveLength(8);
    await page.goto(base + `/card/${active.id}`);
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
    );
    expect(await page.locator(".ch .m").textContent()).toContain("82 of you");
    expect(await page.locator("a.cs").count()).toBe(8);
    expect(await page.locator("a.cs").first().getAttribute("href")).toContain(
      "?t=1h47m0s",
    );
    await page.screenshot({ path: ".cache/card.png" });
    const co = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    co.on("pageerror", (e) => errors.push(e.message));
    await co.goto(base + "/coldopen?play=1&skip");
    await co.waitForFunction(
      () => document.documentElement.dataset.playing === "true",
    );
    await co.waitForTimeout(500);
    await co.screenshot({ path: ".cache/coldopen-title.png" });
    await co.getByRole("button", { name: "SKIP · 15S" }).click();
    expect(await co.locator("#co").isVisible()).toBe(false);
    await post("/api/coldopen");
    await co.waitForFunction(
      () => document.documentElement.dataset.playing === "true",
    );
    await co.waitForTimeout(5600);
    expect(await co.locator("#cO").textContent()).toContain("NO. 3");
    await co.screenshot({ path: ".cache/coldopen-clip.png" });
    await co.waitForTimeout(7400);
    await co.waitForFunction(
      () =>
        Number(getComputedStyle(document.getElementById("endb")!).opacity) >
        0.99,
    );
    await co.waitForFunction(
      () => document.documentElement.dataset.playing === "false",
      {},
      { timeout: 4000 },
    );
    await post("/api/mock/start", { title: "next stream" });
    await co.waitForFunction(
      () => document.documentElement.dataset.playing === "true",
    );
    await co.getByRole("button", { name: "SKIP · 15S" }).click();
    expect(events.some((e) => e.type === "coldopen")).toBe(true);
    // Exercise manual dashboard chat and mod controls through the actual UI.
    await page.goto(base + "/dashboard");
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
    );
    await page.locator("#name").fill("browser_user");
    await page.locator("#message").fill("!star <img src=x onerror=alert(1)>");
    await page.getByRole("button", { name: "Send to chat" }).click();
    await page.waitForFunction(
      () => document.getElementById("starCount")?.textContent === "1",
    );
    expect(await page.locator("#modQueue img").count()).toBe(0);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById("starCount")?.textContent === "0",
    );
    await page.screenshot({
      path: ".cache/dashboard-final.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
    ws.close();
    await Promise.all([page.close(), overlay.close(), co.close()]);
  }, 60000);
  it("reuses live PNGs for 10s, refreshes expired images and forces offline export without changing TMPDIR", async () => {
    const tmpBefore = process.env.TMPDIR;
    const dataDir = await mkdtemp(resolve(".cache/tests/png-cache-"));
    const local = await createApp({
      dataDir,
      tick: false,
      clock: () => Date.UTC(2026, 9, 28, 20),
    });
    try {
      const origin = await local.listen(0),
        stream = await local.service.start({ type: "stream.online" });
      const url = origin + `/card/${stream.id}.png`,
        file = local.store.pngPath(stream.id);
      const first = Buffer.from(await (await fetch(url)).arrayBuffer()),
        firstTime = (await stat(file)).mtimeMs;
      await local.service.advance(60_000);
      await local.service.message(
        { id: "new", name: "new" },
        "!star newly added",
      );
      expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(
        first,
      );
      expect((await stat(file)).mtimeMs).toBe(firstTime);
      const old = new Date(Date.now() - 11_000);
      await utimes(file, old, old);
      const changed = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(changed).not.toEqual(first);
      const refreshed = (await stat(file)).mtimeMs;
      await local.service.advance(60_000);
      const ended = await fetch(origin + "/api/mock/end", { method: "POST" });
      expect(ended.status).toBe(200);
      expect((await stat(file)).mtimeMs).toBeGreaterThan(refreshed);
      expect(Buffer.from(await (await fetch(url)).arrayBuffer())).not.toEqual(
        changed,
      );
      expect(process.env.TMPDIR).toBe(tmpBefore);
    } finally {
      await local.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30000);
  it("rejects malformed requests and path traversal without creating files", async () => {
    const bad = await fetch(base + "/api/mock/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../bad", text: "!star" }),
    });
    expect(bad.status).toBe(400);
    const invalid = await fetch(base + "/api/streams/..%2Fsecret");
    expect(invalid.status).toBe(400);
    const settings = await fetch(base + "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gapMs: -1 }),
    });
    expect(settings.status).toBe(400);
  });
});

it("shows an enabled Connect Twitch button in real mode without starting OAuth or Twitch traffic", async () => {
  const liveRoot = await mkdtemp(resolve(".cache/tests/live-ui-"));
  let calls = 0;
  const adapter = new LiveTwitch({
    clientId: "test-app",
    clientSecret: "test-secret",
    channel: "test-channel",
    redirectUri: "http://localhost:3000/auth/callback",
    dataDir: liveRoot,
    fetch: async () => {
      calls++;
      throw new Error("Unexpected Twitch request");
    },
    socket: () => {
      calls++;
      throw new Error("Unexpected Twitch socket");
    },
  });
  const live = await createApp({ adapter, dataDir: liveRoot, tick: false });
  const liveBase = await live.listen(0);
  const page = await browser.newPage();
  try {
    await page.goto(liveBase + "/dashboard");
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "true",
    );
    const button = page.getByRole("button", {
      name: "Connect Twitch",
      exact: true,
    });
    expect(await button.isEnabled()).toBe(true);
    expect(await page.locator("#start").isVisible()).toBe(false);
    expect(await page.locator("#chatForm").isVisible()).toBe(false);
    expect(await page.locator(".generator-row").isVisible()).toBe(false);
    expect(await page.locator(".mode").textContent()).toBe("TWITCH LIVE");
    expect(calls).toBe(0);
  } finally {
    await page.close();
    await live.close();
    await rm(liveRoot, { recursive: true, force: true });
  }
});

it.each(["offline event", "existing service drain"])(
  "fast restart during %s opens the next stream and exports the old card",
  async (source) => {
    const dataDir = await mkdtemp(resolve(".cache/tests/restart-"));
    const adapter = new MockTwitch();
    let now = Date.UTC(2026, 9, 28, 20);
    const local = await createApp({
      dataDir,
      adapter,
      clock: () => now,
      tick: false,
    });
    await local.listen(0);
    let release!: (vod: { id: string }) => void;
    const gate = new Promise<{ id: string }>((yes) => {
      release = yes;
    });
    const archive = vi.spyOn(adapter, "getArchiveVod").mockReturnValue(gate);
    const render = vi.spyOn(local.renderer, "render");
    let offline: Promise<unknown> | undefined,
      online: Promise<void> | undefined;
    try {
      await adapter.emit({ type: "stream.online", id: "old-stream" });
      await local.service.message(
        { id: "old-viewer", name: "OldViewer" },
        "!star old memory",
      );
      offline =
        source === "offline event"
          ? adapter.emit({ type: "stream.offline" })
          : local.service.end();
      await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
      now += 20_000;
      online = adapter.emit({
        type: "stream.online",
        id: "new-stream",
        startedAt: now,
      });
      // Observe rejection immediately so the regression fails without an unhandled promise.
      const opened = online.then(
        () => true,
        () => false,
      );
      await new Promise<void>((yes) => setImmediate(yes));
      expect(local.service.active?.id).toBe("old-stream");
      release({ id: "mock-old-vod" });
      await offline;
      expect(await opened).toBe(true);
      expect(local.service.active?.id).toBe("new-stream");
      await adapter.emit({
        type: "channel.chat.message",
        user: { id: "new-viewer", name: "NewViewer" },
        text: "!star new memory",
        messageId: "new-chat",
        at: now,
      });
      expect(local.service.active!.stars).toHaveLength(1);
      expect(local.service.active!.stars[0]!.owner.id).toBe("new-viewer");
      const old = await local.store.stream("old-stream");
      expect(old!.endedAt).toBeDefined();
      expect(old!.stars).toHaveLength(1);
      expect(old!.stars[0]!.owner.id).toBe("old-viewer");
      expect(old!.vodId).toBe("mock-old-vod");
      expect(archive).toHaveBeenCalledOnce();
      expect(render).toHaveBeenCalledExactlyOnceWith(
        "old-stream",
        expect.any(String),
        { force: true },
      );
      const png = await readFile(local.store.pngPath("old-stream"));
      expect(png.readUInt32BE(16)).toBe(1080);
      expect(png.readUInt32BE(20)).toBe(1350);
    } finally {
      release({ id: "mock-old-vod" });
      await Promise.allSettled([offline, online]);
      await local.close();
      archive.mockRestore();
      render.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  30_000,
);

function rehearsalCard(withReasons = true): Stream {
  const startedAt = Date.UTC(2026, 9, 31, 20);
  return {
    id: "rehearsal-layout", channel: "fixture", title: "", startedAt,
    endedAt: startedAt + 638_000, viewerCount: 3, cooldowns: {},
    sequence: 5, clipAttempts: 0, warnings: [], mock: true,
    stars: [61, 117, 390, 530, 560].map((offsetSeconds, i) => {
      const owner = { id: `viewer-${i}`, name: "fixture_viewer" };
      return {
        id: `fixture-${i}`, owner, offsetSeconds,
        openedAt: startedAt + offsetSeconds * 1000,
        reason: withReasons ? ["", "", "", "that sky", "first night live"][i]! : "",
        lighters: i === 2 ? [owner, { id: "a", name: "join_a" }, { id: "b", name: "join_b" }] : [owner],
      };
    }),
  };
}

it.each([true, false])("renders non-overlapping rehearsal labels and badges (reasons: %s)", async (withReasons) => {
  await server.store.saveStream(rehearsalCard(withReasons));
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  const bounds = () => page.evaluate(() => {
    const boxes = (selector: string) => Array.from(document.querySelectorAll(selector), (node) => {
      const b = node.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });
    return { labels: boxes(".card-label"), glyphs: boxes(".card-glyph") };
  });
  try {
    let original: Awaited<ReturnType<typeof bounds>> | undefined;
    for (const width of [1080, 540]) {
      await page.setViewportSize({ width, height: 1350 });
      for (const suffix of ["", "?export=1"]) {
        await page.goto(base + "/card/rehearsal-layout" + suffix);
        await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
        const boxes = await bounds();
        expect(boxes.labels).toHaveLength(5);
        expect(boxes.glyphs).toHaveLength(5);
        expect(await page.locator(".card-label .rk").count()).toBe(3);
        const factor = width / 1080;
        const normalized = Object.fromEntries(Object.entries(boxes).map(([key, items]) =>
          [key, items.map((box) => Object.fromEntries(Object.entries(box).map(([k, value]) =>
            [k, Math.round(value / factor * 100) / 100]))) ]));
        if (original) expect(normalized).toEqual(original);
        else original = normalized as typeof boxes;
        boxes.labels.forEach((box, i) => {
          expect(box.left).toBeGreaterThanOrEqual(84 * factor - 0.01);
          expect(box.right).toBeLessThanOrEqual(996 * factor + 0.01);
          expect(box.top).toBeGreaterThanOrEqual(420 * factor - 0.01);
          expect(box.bottom).toBeLessThanOrEqual(1080 * factor + 0.01);
          for (const other of [...boxes.labels.slice(i + 1), ...boxes.glyphs]) {
            const intersects = box.left < other.right && box.right > other.left &&
              box.top < other.bottom && box.bottom > other.top;
            expect(intersects, `label ${i} must not cover another label or any glyph`).toBe(false);
          }
        });
      }
    }
  } finally { await page.close(); }
});

it("omits empty title rows and local footer URLs while retaining public links and titles", async () => {
  const fixture = rehearsalCard();
  const page = await browser.newPage();
  try {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "starmark.example"]) {
      const isLocal = hostname !== "starmark.example";
      await page.route("**/api/streams/rehearsal-layout", (route) => route.fulfill({ json: {
        ...fixture, title: isLocal ? "  " : "A night together", durationSeconds: 638,
        cardUrl: `http://${hostname}:3000/card/rehearsal-layout`,
      } }));
      await page.goto(base + "/card/rehearsal-layout");
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
      expect(await page.locator(".ch .m br").count()).toBe(isLocal ? 0 : 1);
      expect((await page.locator(".ch .m").textContent())!.includes("“")).toBe(!isLocal);
      expect(await page.locator(".card-address").count()).toBe(isLocal ? 0 : 1);
      expect(await page.locator(".cf .a").textContent()).toContain("twitch.tv/fixture");
      if (!isLocal) {
        expect(await page.locator(".ch .m").textContent()).toContain("“A night together”");
        expect(await page.locator(".card-address").textContent()).toContain(hostname);
      }
      await page.unroute("**/api/streams/rehearsal-layout");
    }
  } finally { await page.close(); }
});
