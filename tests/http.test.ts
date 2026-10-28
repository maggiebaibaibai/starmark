import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { createApp, type AppOptions } from "../server/app.js";
import { MockTwitch, type TwitchAdapter } from "../server/twitch.js";
import { Store } from "../server/store.js";
import { defaults } from "../server/engine.js";
import { requestAllowed } from "../server/security.js";
const servers: Awaited<ReturnType<typeof createApp>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(options: AppOptions = {}) {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/http-"));
  roots.push(root);
  const store = new Store(root);
  await store.init();
  await store.saveState({ version: 1, settings: defaults, mockOffset: 123000 });
  const server = await createApp({ ...options, dataDir: root, tick: false });
  servers.push(server);
  return { server, base: await server.listen(0), root };
}
function http(
  base: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
) {
  return new Promise<{ status: number; body: string }>((yes, no) => {
    const req = request(base + path, { method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => yes({ status: res.statusCode!, body }));
    });
    req.on("error", no);
    req.end(body);
  });
}
async function socketClose(base: string, data: string | Buffer) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/ws");
  const closed = new Promise<number>((yes, no) => {
    socket.on("close", (code) => yes(code));
    socket.on("error", no);
  });
  socket.on("open", () => socket.send(data));
  return closed;
}
describe("HTTP and WebSocket boundaries", () => {
  it("rejects evil Host and Origin on GET, writes and upgrades before routing", async () => {
    const { base } = await setup();
    for (const method of ["GET", "POST"])
      for (const headers of [
        { Host: "evil.example", Origin: "http://evil.example" },
        { Host: "evil.example" },
        { Origin: "http://evil.example" },
      ])
        expect((await http(base, "/api/state", method, headers)).status).toBe(
          403,
        );
    const code = await new Promise<number>((yes, no) => {
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
        headers: { Host: "evil.example", Origin: "http://evil.example" },
      });
      ws.on("unexpected-response", (_req, res) => {
        yes(res.statusCode!);
        res.resume();
      });
      ws.on("open", () => {
        ws.close();
        no(new Error("Untrusted upgrade was accepted"));
      });
      ws.on("error", no);
    });
    expect(code).toBe(403);
  });
  it("allows literal loopback authorities and the exact PUBLIC_URL host, rejecting rebinding aliases", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])
      expect(requestAllowed({ host, origin: `http://${host}` })).toBe(true);
    for (const host of [
      "localhost.evil.example",
      "127.1",
      "2130706433",
      "127.0.0.1.evil",
      "user@localhost",
      "localhost:99999",
    ])
      expect(requestAllowed({ host })).toBe(false);
    expect(requestAllowed({ host: "localhost:3000", origin: "null" })).toBe(
      false,
    );
    const { base } = await setup({ publicUrl: "https://starmark.example:444" });
    expect(
      (
        await http(base, "/api/state", "GET", {
          Host: "starmark.example:444",
          Origin: "https://starmark.example:444",
        })
      ).status,
    ).toBe(200);
    expect(
      (await http(base, "/api/state", "GET", { Host: "starmark.example:445" }))
        .status,
    ).toBe(403);
    expect(
      (
        await http(base, "/api/state", "GET", {
          Host: "starmark.example:444",
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
  });
  it("closes text and binary messages with 1003 and bounds oversized input to 1024 bytes", async () => {
    const { base } = await setup();
    expect(await socketClose(base, "hello")).toBe(1003);
    expect(await socketClose(base, Buffer.from([1, 2, 3]))).toBe(1003);
    // ws enforces the size limit before delivering a message; its RFC close code is 1009.
    expect(await socketClose(base, "x".repeat(1025))).toBe(1009);
  });
  it("defaults empty request bodies, classifies validation errors and hides internal failures", async () => {
    const { server, base } = await setup();
    expect((await http(base, "/api/settings", "POST")).status).toBe(200);
    expect((await http(base, "/api/mock/start", "POST")).status).toBe(200);
    expect((await http(base, "/api/mock/start", "POST")).status).toBe(409);
    const missing = await http(base, "/api/mock/chat", "POST");
    expect(missing.status).toBe(400);
    expect(missing.body).not.toContain("undefined");
    const bad = await http(
      base,
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      '{"secret":',
    );
    expect(bad).toEqual({ status: 400, body: '{"error":"Invalid JSON body"}' });
    const huge = await http(
      base,
      "/api/settings",
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ text: "a".repeat(17000) }),
    );
    expect(huge.status).toBe(413);
    vi.spyOn(server.service, "snapshot").mockRejectedValue(
      new Error("/private/token.json: secret refresh token"),
    );
    expect(await http(base, "/api/state")).toEqual({
      status: 500,
      body: '{"error":"Internal server error"}',
    });
  });
  it("does not register mock routes in live mode and clears a persisted mock offset", async () => {
    // A mode-only test double, NOT a real Twitch implementation.
    const adapter: TwitchAdapter = new MockTwitch();
    Object.defineProperty(adapter, "mode", { value: "live" });
    const { server, base } = await setup({ adapter });
    for (const path of ["start", "end", "chat", "advance", "vod", "generator"])
      expect((await http(base, `/api/mock/${path}`, "POST")).status).toBe(404);
    expect(server.service.state.mockOffset).toBe(0);
    expect((await server.store.state()).mockOffset).toBe(0);
    expect(server.service.active).toBeUndefined();
  });
  it("passes event timestamps and stream updates through the adapter and broadcasts connection state", async () => {
    const adapter = new MockTwitch();
    const { server, base } = await setup({ adapter, clock: () => 1_000_000 });
    await adapter.emit({
      type: "stream.online",
      id: "event-stream",
      startedAt: 1_000,
      title: "original",
    });
    await adapter.emit({
      type: "channel.chat.message",
      messageId: "one",
      user: { id: "a", name: "a" },
      text: "!star",
      at: 2_000,
    });
    expect(server.service.active!.stars[0]!.openedAt).toBe(2_000);
    expect(server.service.active!.stars[0]!.offsetSeconds).toBe(1);
    await adapter.emit({
      type: "stream.update",
      title: "updated title",
      viewerCount: 123,
    });
    expect(server.service.active).toMatchObject({
      title: "updated title",
      viewerCount: 123,
    });
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
    await new Promise<void>((yes) => ws.on("open", yes));
    const event = new Promise<unknown>((yes) =>
      ws.on("message", (data) => {
        const e = JSON.parse(data.toString());
        if (e.type === "connection.state") yes(e);
      }),
    );
    expect(await adapter.authUrl()).toBeUndefined();
    await adapter.disconnect();
    expect(await event).toEqual({
      type: "connection.state",
      status: { mode: "mock", state: "disconnected" },
    });
    await adapter.handleCallback("ignored-code", "ignored-state");
    expect(adapter.status()).toEqual({ mode: "mock", state: "connected" });
    ws.close();
  });
});

it("binds OAuth callbacks to the initiating browser, redirects safely and keeps mock auth unavailable", async () => {
  const adapter = new MockTwitch();
  Object.defineProperty(adapter, "mode", { value: "live" });
  const csrf = "a".repeat(64);
  const auth = vi
    .spyOn(adapter, "authUrl")
    .mockResolvedValue(`https://id.twitch.tv/oauth2/authorize?state=${csrf}`);
  const callback = vi.spyOn(adapter, "handleCallback");
  const { base } = await setup({ adapter });
  const canonical = await fetch(base + "/auth/connect", { redirect: "manual" });
  expect(new URL(canonical.headers.get("location")!).hostname).toBe(
    "localhost",
  );
  expect(auth).not.toHaveBeenCalled();
  const start = await fetch(
    base.replace("127.0.0.1", "localhost") + "/auth/connect",
    { redirect: "manual" },
  );
  expect(start.status).toBe(302);
  expect(start.headers.get("set-cookie")).toContain("HttpOnly");
  expect(start.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(start.headers.get("cache-control")).toBe("no-store");
  const path = `/auth/callback?code=synthetic-code&state=${csrf}`;
  expect((await http(base, path)).status).toBe(400);
  expect(
    (await http(base, path, "GET", { Cookie: "starmark_oauth=wrong" })).status,
  ).toBe(400);
  expect(callback).not.toHaveBeenCalled();
  expect(
    (await http(base, path, "GET", { Cookie: `starmark_oauth=${csrf}` }))
      .status,
  ).toBe(302);
  expect(callback).toHaveBeenCalledExactlyOnceWith("synthetic-code", csrf);
  expect((await http(base, "/auth/disconnect", "POST")).status).toBe(200);
  const mock = await setup();
  expect((await http(mock.base, "/auth/connect")).status).toBe(404);
});
it("reconciles repeated online events without erasing the current stream", async () => {
  const adapter = new MockTwitch();
  const { server } = await setup({ adapter });
  await adapter.emit({ type: "stream.online", id: "same-stream" });
  await server.service.message({ id: "a", name: "a" }, "!star");
  await adapter.emit({
    type: "stream.online",
    id: "same-stream",
    title: "Current title",
    viewerCount: 50,
  });
  expect(server.service.active!.stars).toHaveLength(1);
  expect(server.service.active!.title).toBe("Current title");
});
