import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { WebSocket } from "ws";
import {
  LiveTwitch,
  configuredTwitch,
  twitchScopes,
  type TwitchEvent,
} from "../server/twitch.js";
import type { Star, Stream } from "../server/engine.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";

// These are synthetic credentials; this test never loads .env or opens a network socket.
const config = {
  clientId: "test-app",
  clientSecret: "test-secret",
  channel: "test-channel",
  redirectUri: "http://localhost:3000/auth/callback",
};
const roots: string[] = [];
const adapters: LiveTwitch[] = [];
const services: Service[] = [];
const servers: Awaited<ReturnType<typeof createApp>>[] = [];
class FakeSocket extends EventEmitter {
  closed = false;
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
  terminate() {
    this.close();
  }
  message(
    type: string,
    payload: object,
    id = crypto.randomUUID(),
    at = "2026-10-28T12:00:14.000Z",
  ) {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          metadata: {
            message_type: type,
            message_id: id,
            message_timestamp: at,
          },
          payload,
        }),
      ),
    );
  }
  welcome(id = "session-1") {
    this.message("session_welcome", {
      session: { id, keepalive_timeout_seconds: 10 },
    });
  }
}
const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const service of services.splice(0)) await service.dispose();
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/twitch-"));
  roots.push(root);
  let now = Date.parse("2026-10-28T12:00:00Z");
  const sockets: FakeSocket[] = [],
    urls: string[] = [];
  const events: TwitchEvent[] = [];
  let handler:
    | ((
        url: URL,
        init: RequestInit,
      ) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const custom = await handler?.(url, init);
      if (custom) return custom;
      if (url.pathname === "/oauth2/token")
        return response({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
        });
      if (url.pathname === "/oauth2/validate")
        return response({
          client_id: config.clientId,
          user_id: "123",
          login: config.channel,
          scopes: twitchScopes,
          expires_in: 3600,
        });
      if (url.pathname === "/oauth2/revoke") return response({});
      if (url.pathname === "/helix/eventsub/subscriptions")
        return response({ data: [] }, 202);
      if (url.pathname === "/helix/streams") return response({ data: [] });
      if (url.pathname === "/helix/streams/markers")
        return response({ data: [{ id: "marker", position_seconds: 16 }] });
      if (url.pathname === "/helix/clips")
        return response({ data: [{ id: "clip" }] }, 202);
      if (url.pathname === "/helix/chat/messages")
        return response({ data: [{ is_sent: true }] });
      if (url.pathname === "/helix/videos")
        return response({
          data: [
            { id: "wrong", stream_id: "previous-stream" },
            { id: "archive", stream_id: "live-stream" },
          ],
        });
      throw new Error("Unexpected mock request");
    },
  );
  const sleep = vi.fn(async (_ms: number) => {});
  const options = {
    ...config,
    dataDir: root,
    fetch: fetcher as typeof fetch,
    sleep,
    clock: () => now,
    socket: (url: string) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  };
  const adapter = new LiveTwitch(options);
  adapters.push(adapter);
  adapter.subscribe(async (event) => {
    events.push(event);
  });
  const connect = async () => {
    const url = new URL(await adapter.authUrl());
    await adapter.handleCallback("test-code", url.searchParams.get("state")!);
  };
  const calls = (path: string) =>
    fetcher.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === path,
    );
  return {
    adapter,
    root,
    options,
    fetcher,
    sleep,
    sockets,
    urls,
    events,
    connect,
    calls,
    setHandler: (fn: NonNullable<typeof handler>) => {
      handler = fn;
    },
    setNow: (time: number) => {
      now = time;
    },
  };
}
const stream = { id: "live-stream", clipAttempts: 1 } as Stream;
const star = { id: "star" } as Star;

describe("OAuth and token lifecycle (all requests mocked)", () => {
  it("starts without network traffic and rejects missing, wrong, expired and replayed state", async () => {
    const t = await setup();
    await t.adapter.initialize();
    expect(t.fetcher).not.toHaveBeenCalled();
    await expect(t.adapter.handleCallback("code", "wrong")).rejects.toThrow(
      "state",
    );
    const url = new URL(await t.adapter.authUrl());
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(twitchScopes);
    await expect(
      t.adapter.handleCallback("code", "x".repeat(64)),
    ).rejects.toThrow("state");
    await expect(
      t.adapter.handleCallback("code", url.searchParams.get("state")!),
    ).rejects.toThrow("state");
    const expired = new URL(await t.adapter.authUrl()).searchParams.get(
      "state",
    )!;
    t.setNow(Date.parse("2026-10-28T12:11:00Z"));
    await expect(t.adapter.handleCallback("code", expired)).rejects.toThrow(
      "expired",
    );
    expect(t.fetcher).not.toHaveBeenCalled();
  });
  it("encrypts private tokens, restores/validates them and revokes/deletes on disconnect", async () => {
    const t = await setup();
    await t.connect();
    const path = join(t.root, "twitch-tokens.json");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("test-access");
    expect(raw).not.toContain("test-refresh");
    expect(raw).not.toContain("test-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await t.adapter.dispose();
    const restored = new LiveTwitch(t.options);
    adapters.push(restored);
    await restored.initialize();
    expect(t.calls("/oauth2/validate")).toHaveLength(2);
    expect(t.sockets).toHaveLength(2);
    await restored.disconnect();
    expect(restored.status().state).toBe("disconnected");
    expect(t.calls("/oauth2/revoke")).toHaveLength(1);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a different broadcaster or missing scopes without saving tokens", async () => {
    const t = await setup();
    t.setHandler((url) =>
      url.pathname === "/oauth2/validate"
        ? response({
            client_id: config.clientId,
            login: "other",
            user_id: "999",
            scopes: [],
          })
        : undefined,
    );
    await expect(t.connect()).rejects.toThrow("broadcaster account");
    expect(t.sockets).toHaveLength(0);
    await expect(
      stat(join(t.root, "twitch-tokens.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refreshes before expiry once for concurrent calls and persists the rotated token", async () => {
    const t = await setup();
    await t.connect();
    t.setNow(Date.parse("2026-10-28T12:59:01Z"));
    await Promise.all([
      t.adapter.createMarker(stream, star, "one"),
      t.adapter.createMarker(stream, star, "two"),
    ]);
    expect(t.calls("/oauth2/token")).toHaveLength(2);
    const fields = t.calls("/oauth2/token")[1]![1]!.body as URLSearchParams;
    expect(fields.get("grant_type")).toBe("refresh_token");
    expect(fields.get("refresh_token")).toBe("test-refresh");
  });
  it("refreshes on an explicit 401 and retries only once", async () => {
    const t = await setup();
    await t.connect();
    let attempts = 0;
    t.setHandler((url) =>
      url.pathname === "/helix/streams/markers" && ++attempts === 1
        ? response({ message: "private upstream body" }, 401)
        : undefined,
    );
    await expect(t.adapter.createMarker(stream, star, "ok")).resolves.toEqual({
      id: "marker",
      positionSeconds: 16,
    });
    expect(t.calls("/oauth2/token")).toHaveLength(2);
    expect(attempts).toBe(2);
  });
  it("selects live only for explicit opt-in with all settings", async () => {
    expect(configuredTwitch({}, 3000).mode).toBe("mock");
    expect(configuredTwitch({ STARMARK_MOCK: "0" }, 3000).mode).toBe("mock");
    const env = {
      TWITCH_CLIENT_ID: config.clientId,
      TWITCH_CLIENT_SECRET: config.clientSecret,
      TWITCH_CHANNEL: config.channel,
    };
    expect(configuredTwitch(env, 3000).mode).toBe("mock");
    const live = configuredTwitch({ ...env, STARMARK_MOCK: "0" }, 3000);
    expect(live.mode).toBe("live");
    await live.dispose();
  });
});

describe("EventSub sessions", () => {
  it("subscribes on welcome, migrates without duplicate subscriptions, and resubscribes after a dropped socket", async () => {
    const t = await setup();
    await t.connect();
    t.sockets[0]!.welcome();
    await vi.waitFor(() => expect(t.adapter.status().state).toBe("connected"));
    expect(t.calls("/helix/eventsub/subscriptions")).toHaveLength(3);
    t.sockets[0]!.message("session_reconnect", {
      session: {
        reconnect_url: "wss://eventsub.wss.twitch.tv/ws?reconnect=test",
      },
    });
    expect(t.sockets[0]!.closed).toBe(false);
    t.sockets[1]!.welcome("transferred");
    await vi.waitFor(() => expect(t.sockets[0]!.closed).toBe(true));
    expect(t.calls("/helix/eventsub/subscriptions")).toHaveLength(3);
    t.sockets[1]!.terminate();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(3), {
      timeout: 1500,
    });
    t.sockets[2]!.welcome("fresh");
    await vi.waitFor(() => expect(t.adapter.status().state).toBe("connected"));
    const subscriptions = t.calls("/helix/eventsub/subscriptions");
    expect(subscriptions).toHaveLength(6);
    expect(
      subscriptions
        .slice(3)
        .map(
          ([, init]) => JSON.parse(init!.body as string).transport.session_id,
        ),
    ).toEqual(["fresh", "fresh", "fresh"]);
  });
  it("keeps timestamps and roles, deduplicates events, and handles revocation", async () => {
    const t = await setup();
    await t.connect();
    t.sockets[0]!.welcome();
    await vi.waitFor(() => expect(t.adapter.status().state).toBe("connected"));
    const payload = {
      subscription: { type: "channel.chat.message" },
      event: {
        broadcaster_user_id: "123",
        chatter_user_id: "viewer",
        chatter_user_name: "Viewer",
        message_id: "chat-1",
        message: { text: "!star" },
        badges: [{ set_id: "subscriber" }, { set_id: "moderator" }],
      },
    };
    t.sockets[0]!.message("session_keepalive", {});
    t.sockets[0]!.message("notification", payload, "event-1");
    t.sockets[0]!.message("notification", payload, "event-1");
    await vi.waitFor(() =>
      expect(
        t.events.filter((e) => e.type === "channel.chat.message"),
      ).toHaveLength(1),
    );
    expect(
      t.events.find((e) => e.type === "channel.chat.message"),
    ).toMatchObject({
      at: Date.parse("2026-10-28T12:00:14Z"),
      messageId: "chat-1",
      user: { isMod: true, isSubscriber: true },
    });
    t.sockets[0]!.message("revocation", {
      subscription: { status: "authorization_revoked" },
    });
    await vi.waitFor(() => expect(t.adapter.status().state).toBe("error"));
    expect(t.sockets[0]!.closed).toBe(true);
  });
});

describe("Helix delivery safety", () => {
  it("backs off on 429, bounds retries, truncates markers and redacts upstream errors", async () => {
    const t = await setup();
    await t.connect();
    let attempts = 0;
    t.setHandler((url) =>
      url.pathname === "/helix/streams/markers" && ++attempts <= 2
        ? response({ message: "private" }, 429, { "Retry-After": "1" })
        : undefined,
    );
    await t.adapter.createMarker(stream, star, "★".repeat(160));
    expect(t.sleep.mock.calls).toEqual([[1000], [1000]]);
    expect(
      JSON.parse(t.calls("/helix/streams/markers")[0]![1]!.body as string)
        .description,
    ).toHaveLength(140);
    t.setHandler(() => response({ message: "private body /path/token" }, 429));
    await expect(t.adapter.sendChat(stream, "echo")).rejects.toThrow(
      "Twitch request was rejected",
    );
    expect(t.calls("/helix/chat/messages")).toHaveLength(3);
  });
  it.each(["timeout", "500"])(
    "never retries an ambiguous %s write",
    async (kind) => {
      const t = await setup();
      await t.connect();
      t.setHandler((url) => {
        if (url.pathname === "/helix/chat/messages") {
          if (kind === "timeout") throw new Error("private token upstream");
          return response({ message: "private token upstream" }, 500);
        }
      });
      await expect(t.adapter.sendChat(stream, "echo")).rejects.toThrow(
        /^Twitch request/,
      );
      expect(t.calls("/helix/chat/messages")).toHaveLength(1);
    },
  );
  it("polls archives and matches stream_id, never the first video", async () => {
    const t = await setup();
    await t.connect();
    let attempts = 0;
    t.setHandler((url) =>
      url.pathname === "/helix/videos" && ++attempts < 3
        ? response({ data: [{ id: "wrong", stream_id: "previous-stream" }] })
        : undefined,
    );
    expect(await t.adapter.getArchiveVod(stream)).toEqual({ id: "archive" });
    expect(t.sleep.mock.calls).toEqual([[2000], [4000]]);
    expect(
      t
        .calls("/helix/videos")
        .every(
          ([url]) =>
            new URL(String(url)).searchParams.get("type") === "archive",
        ),
    ).toBe(true);
  });
  it("uses marker 404 clip fallback and sends exactly one echo through the real adapter", async () => {
    const t = await setup();
    await t.connect();
    t.setHandler((url) =>
      url.pathname === "/helix/streams/markers"
        ? response({ message: "private" }, 404)
        : undefined,
    );
    const service = new Service(
      new Store(t.root),
      t.adapter,
      "test",
      () => {},
      t.options.clock,
    );
    services.push(service);
    await service.init();
    await service.start({ type: "stream.online", id: stream.id });
    for (const name of ["a", "b", "c"])
      await service.message({ id: name, name }, "!star");
    t.setNow(Date.parse("2026-10-28T12:00:15Z"));
    await service.tick();
    await service.waitForDelivery();
    await service.tick();
    await service.waitForDelivery();
    const saved = await service.end();
    expect(saved.warnings.join(" ")).toContain("Store past broadcasts");
    expect(saved.stars[0]!.clipId).toBe("clip");
    expect(saved.vodId).toBe("archive");
    expect(t.calls("/helix/chat/messages")).toHaveLength(1);
    expect(
      JSON.parse(t.calls("/helix/chat/messages")[0]![1]!.body as string)
        .message,
    ).toContain("3 of you");
  });
});

it("resets the keepalive watchdog and reconnects when keepalives stop", async () => {
  const t = await setup();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  try {
    await t.connect();
    t.sockets[0]!.welcome();
    await vi.waitFor(() => expect(t.adapter.status().state).toBe("connected"));
    await vi.advanceTimersByTimeAsync(9000);
    t.sockets[0]!.message("session_keepalive", {});
    await vi.advanceTimersByTimeAsync(9000);
    expect(t.sockets[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.sockets).toHaveLength(2);
  } finally {
    await t.adapter.dispose();
    vi.useRealTimers();
  }
});
it("does not resurrect credentials or change disconnected status when a refresh finishes late", async () => {
  const t = await setup();
  await t.connect();
  let release!: () => void;
  const gate = new Promise<void>((yes) => {
    release = yes;
  });
  t.setHandler(async (url) => {
    if (url.pathname === "/oauth2/token") {
      await gate;
      return response({
        access_token: "rotated-test-access",
        refresh_token: "rotated-test-refresh",
        expires_in: 3600,
      });
    }
  });
  t.setNow(Date.parse("2026-10-28T13:00:00Z"));
  const delivery = t.adapter.createMarker(stream, star, "test").catch(() => {});
  await vi.waitFor(() => expect(t.calls("/oauth2/token")).toHaveLength(2));
  await t.adapter.disconnect();
  release();
  await delivery;
  expect(t.adapter.status().state).toBe("disconnected");
  expect(t.calls("/helix/streams/markers")).toHaveLength(0);
  await expect(stat(join(t.root, "twitch-tokens.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

async function liveApp() {
  const t = await setup();
  const server = await createApp({
    adapter: t.adapter,
    dataDir: t.root,
    tick: false,
    clock: t.options.clock,
  });
  servers.push(server);
  await server.listen(0);
  await t.connect();
  t.sockets[0]!.welcome();
  await vi.waitFor(() => expect(t.adapter.status().state).toBe("connected"));
  return { ...t, server };
}
it("empty polls after online cannot end the stream and later metadata polls cannot overwrite its stars", async () => {
  const t = await liveApp();
  const end = vi.spyOn(t.server.service, "end");
  t.sockets[0]!.message("notification", {
    subscription: { type: "stream.online" },
    event: {
      broadcaster_user_id: "123",
      id: "live-stream",
      started_at: "2026-10-28T12:00:00Z",
    },
  });
  await vi.waitFor(() =>
    expect(t.server.service.active?.id).toBe("live-stream"),
  );
  await t.server.service.message({ id: "a", name: "a" }, "!star saved");
  await vi.waitFor(() => expect(t.calls("/helix/streams")).toHaveLength(2));
  t.setHandler((url) =>
    url.pathname === "/helix/streams"
      ? response({
          data: [
            {
              id: "live-stream",
              title: "Updated",
              viewer_count: 42,
              started_at: "2026-10-28T12:00:00Z",
            },
          ],
        })
      : undefined,
  );
  t.sockets[0]!.message("session_reconnect", {
    session: {
      reconnect_url: "wss://eventsub.wss.twitch.tv/ws?reconnect=test",
    },
  });
  t.sockets[1]!.welcome("migrated");
  await vi.waitFor(() =>
    expect(t.server.service.active?.title).toBe("Updated"),
  );
  expect(end).not.toHaveBeenCalled();
  expect(t.events.filter((e) => e.type === "stream.offline")).toHaveLength(0);
  expect(t.events.filter((e) => e.type === "stream.online")).toHaveLength(1);
  const saved = await t.server.store.stream("live-stream");
  expect(saved!.stars).toHaveLength(1);
  expect(saved!.endedAt).toBeUndefined();
});
