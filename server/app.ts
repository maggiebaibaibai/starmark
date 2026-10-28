import express from "express";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { defaults, type Settings, type User } from "./engine.js";
import { Store, validId } from "./store.js";
import { Service } from "./service.js";
import { MockTwitch, type TwitchAdapter } from "./twitch.js";
import { CardRenderer } from "./render.js";
export interface AppOptions {
  dataDir?: string;
  clock?: () => number;
  channel?: string;
  adapter?: TwitchAdapter;
  publicUrl?: string;
  tick?: boolean;
}
const fontUrl =
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+JP:wght@400;500&family=Space+Grotesk:wght@400;500;600&display=swap";
export async function createApp(options: AppOptions = {}) {
  const app = express();
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  const adapter = options.adapter ?? new MockTwitch();
  const store = new Store(options.dataDir);
  const broadcast = (event: object) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients)
      if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  const service = new Service(
    store,
    adapter,
    options.channel ?? "yourchannel",
    broadcast,
    options.clock,
  );
  await service.init();
  const renderer = new CardRenderer((id) => store.pngPath(id));
  let origin = "";
  let generator: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    // Local control API: reject cross-origin writes from unrelated websites.
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      req.headers.origin !== origin &&
      req.headers.origin !== `http://${req.headers.host}`
    ) {
      res
        .status(403)
        .json({ error: "Cross-origin control requests are disabled" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use("/assets", express.static(resolve("dist/public")));
  app.use("/assets", express.static(resolve("web")));
  app.use("/fonts", express.static(resolve(".cache/fonts")));
  app.get("/fonts.css", async (_req, res) => {
    try {
      await access(resolve(".cache/fonts/fonts.css"));
      res.type("css").send(await readFile(resolve(".cache/fonts/fonts.css"), "utf8"));
    } catch {
      res.type("css").send(`@import url('${fontUrl}');`);
    }
  });
  app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
  });
  app.get("/", (_req, res) => {
    res.redirect("/dashboard");
  });
  app.get(
    ["/dashboard", "/overlay", "/coldopen", "/card/:id"],
    async (req, res, next) => {
      const id = typeof req.params.id === "string" ? req.params.id : undefined;
      if (id?.endsWith(".png") || id?.endsWith(".json")) {
        next();
        return;
      }
      if (id && (!validId(id) || !(await store.stream(id)))) {
        res.status(404).type("text").send("Starmap not found");
        return;
      }
      res
        .type("html")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starmark · your chat writes the highlight reel</title><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/assets/styles.css"><script type="module" src="/assets/app.js"></script></head><body><main id="app"></main></body></html>`,
        );
    },
  );
  app.get("/api/state", async (_req, res) => {
    res.json({ ...(await service.snapshot()), generator: !!generator });
  });
  app.get("/api/streams/:id", async (req, res) => {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: "Invalid stream ID" });
      return;
    }
    const stream = await store.stream(req.params.id);
    if (!stream) {
      res.status(404).json({ error: "Stream not found" });
      return;
    }
    res.json({
      ...service.card(stream),
      cardUrl: `${options.publicUrl || origin}/card/${stream.id}`,
    });
  });
  app.get("/card/:file", async (req, res) => {
    const match = /^([\w-]+)\.(png|json)$/.exec(req.params.file);
    if (!match || !validId(match[1]!)) {
      res.status(404).end();
      return;
    }
    const id = match[1]!;
    const stream = await store.stream(id);
    if (!stream) {
      res.status(404).json({ error: "Stream not found" });
      return;
    }
    if (match[2] === "json") {
      res.json({
        ...service.card(stream),
        cardUrl: `${options.publicUrl || origin}/card/${id}`,
      });
      return;
    }
    // Live exports are regenerated; completed streams use their persisted export.
    const path = store.pngPath(id);
    try {
      if (stream.endedAt === undefined) throw new Error("live");
      await access(path);
    } catch {
      await renderer.render(id, origin);
    }
    res.type("png").sendFile(path, { dotfiles: "allow" });
  });
  async function endAndExport() {
    stopGenerator();
    const stream = await service.run(() => service.end());
    await renderer.render(stream.id, origin);
    broadcast({ type: "exported", id: stream.id });
    return stream;
  }
  const unsubscribe = adapter.subscribe(async (event) => {
    if (event.type === "stream.online")
      await service.run(() => service.start(event));
    else if (event.type === "stream.offline") await endAndExport();
    else
      await service.run(() =>
        service.message(event.user, event.text, event.messageId),
      );
  });
  app.post("/api/mock/start", async (req, res) => {
    const stream = await service.run(() =>
      service.start({
        type: "stream.online",
        title: String(req.body.title ?? ""),
        viewerCount: 32,
      }),
    );
    res.json(stream);
  });
  app.post("/api/mock/end", async (_req, res) => {
    const stream = await endAndExport();
    res.json({
      id: stream.id,
      cardUrl: `/card/${stream.id}`,
      pngUrl: `/card/${stream.id}.png`,
    });
  });
  app.post("/api/mock/chat", async (req, res) => {
    const name = String(req.body.name ?? "")
      .trim()
      .replace(/^@/, "");
    if (!/^[\p{L}\p{N}_.-]{1,25}$/u.test(name)) {
      res
        .status(400)
        .json({
          error:
            "Use a name of 1–25 letters, numbers, underscores, dots or dashes",
        });
      return;
    }
    if (typeof req.body.text !== "string" || req.body.text.length > 500) {
      res
        .status(400)
        .json({ error: "Message must be 500 characters or fewer" });
      return;
    }
    const user: User = {
      id: name.toLocaleLowerCase(),
      name,
      isMod: req.body.role === "mod",
      isBroadcaster: req.body.role === "broadcaster",
      isFollower: req.body.follower === true,
      isSubscriber: req.body.subscriber === true,
    };
    res.json(await service.run(() => service.message(user, req.body.text)));
  });
  app.post("/api/mock/advance", async (req, res) => {
    const ms = req.body.ms;
    if (!Number.isFinite(ms) || ms < 0 || ms > 86_400_000) {
      res.status(400).json({ error: "ms must be between 0 and 86400000" });
      return;
    }
    await service.run(() => service.advance(ms));
    res.json({ now: service.now() });
  });
  app.post("/api/mock/vod", async (req, res) => {
    if (adapter instanceof MockTwitch)
      adapter.vodSaving = req.body.enabled !== false;
    res.json({
      enabled: !(adapter instanceof MockTwitch) || adapter.vodSaving,
    });
  });
  function stopGenerator() {
    if (generator) clearInterval(generator);
    generator = undefined;
  }
  app.post("/api/mock/generator", async (req, res) => {
    stopGenerator();
    if (req.body.enabled) {
      if (!service.active) throw new Error("Start a stream first");
      generator = setInterval(() => {
        void service
          .run(async () => {
            if (!service.active) return;
            await service.advance(3000);
            generation++;
            const names = [
              "nova",
              "kiki",
              "orbit",
              "mochi_",
              "sable",
              "lux",
              "tofu",
              "pine",
            ];
            const name = `${names[generation % names.length]}${Math.floor(generation / names.length)}`;
            await service.message(
              { id: name, name, isFollower: true, isSubscriber: true },
              `!star ${["that dodge??", "the cat is back", "best song tonight", "やっと勝った"][Math.floor(generation / 6) % 4]}`,
            );
          })
          .catch((error) =>
            broadcast({ type: "error", message: String(error) }),
          );
      }, 1100);
    }
    res.json({ enabled: !!generator });
  });
  app.post("/api/coldopen", async (_req, res) => {
    broadcast({
      type: "coldopen",
      previous: (await service.snapshot()).previous,
    });
    res.json({ playing: true });
  });
  app.post("/api/settings", async (req, res) => {
    const raw = req.body;
    const settings: Settings = { ...service.state.settings };
    for (const key of ["cooldownMs", "gapMs", "namesOnlyThreshold"] as const) {
      if (raw[key] !== undefined) {
        if (
          !Number.isInteger(raw[key]) ||
          raw[key] < 0 ||
          raw[key] > 86_400_000
        )
          throw new Error(`Invalid ${key}`);
        settings[key] = raw[key];
      }
    }
    for (const key of ["subsOnly", "followersOnly", "namesOnly"] as const)
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "boolean") throw new Error(`Invalid ${key}`);
        settings[key] = raw[key];
      }
    if (raw.blocklist !== undefined) {
      if (
        !Array.isArray(raw.blocklist) ||
        raw.blocklist.length > 100 ||
        raw.blocklist.some(
          (x: unknown) => typeof x !== "string" || x.length > 40,
        )
      )
        throw new Error("Invalid blocklist");
      settings.blocklist = raw.blocklist;
    }
    settings.mergeMs = defaults.mergeMs;
    await service.run(() => service.settings(settings));
    res.json(settings);
  });
  app.delete("/api/stars/:id", async (req, res) => {
    await service.run(() => service.removeStar(req.params.id));
    res.json({ removed: true });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: error.message });
    },
  );
  wss.on("connection", (socket, request) => {
    if (
      request.headers.origin &&
      request.headers.origin !== origin &&
      request.headers.origin !== `http://${request.headers.host}`
    ) {
      socket.close(1008, "Origin rejected");
      return;
    }
    void service
      .snapshot()
      .then((snapshot) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "state", ...snapshot, events: [] }),
          );
      })
      .catch(() => socket.close(1011));
    socket.on("error", () => socket.close());
  });
  const timer =
    options.tick === false
      ? undefined
      : setInterval(() => {
          void service
            .run(() => service.tick())
            .catch((error) =>
              broadcast({ type: "error", message: String(error) }),
            );
        }, 250);
  return {
    app,
    service,
    adapter,
    store,
    renderer,
    async listen(port = 3000, host = "127.0.0.1") {
      await new Promise<void>((yes, no) => {
        http.once("error", no);
        http.listen(port, host, () => {
          http.off("error", no);
          yes();
        });
      });
      const addr = http.address();
      origin = `http://${host}:${typeof addr === "object" && addr ? addr.port : port}`;
      return origin;
    },
    async close() {
      stopGenerator();
      if (timer) clearInterval(timer);
      unsubscribe();
      await service.run(async () => {});
      await renderer.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((yes) => wss.close(() => yes()));
      await new Promise<void>((yes, no) =>
        http.close((error) => (error ? no(error) : yes())),
      );
      await adapter.dispose();
    },
  };
}
