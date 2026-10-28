import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { MockTwitch } from "../server/twitch.js";
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
  process.env.TMPDIR = resolve(".cache/tmp");
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
    await co.goto(base + "/coldopen?play=1");
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
