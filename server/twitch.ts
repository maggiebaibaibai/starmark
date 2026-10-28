import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { ValidationError } from "./errors.js";
import { TokenVault, type Tokens } from "./twitch-tokens.js";
import type { Star, Stream, User } from "./engine.js";
export type ConnectionState =
  "connected" | "disconnected" | "connecting" | "error";
export interface ConnectionStatus {
  mode: "mock" | "live";
  state: ConnectionState;
}
export type TwitchEvent =
  | {
      type: "stream.online";
      id?: string;
      startedAt?: number;
      title?: string;
      viewerCount?: number;
    }
  | { type: "stream.offline" }
  | { type: "stream.update"; id?: string; title?: string; viewerCount?: number }
  | { type: "connection.state"; status: ConnectionStatus }
  | {
      type: "channel.chat.message";
      user: User;
      text: string;
      messageId: string;
      /** Epoch ms: EventSub metadata.message_timestamp in live; captured arrival time in mock. */
      at: number;
    };
export interface TwitchAdapter {
  readonly mode: "mock" | "live";
  status(): ConnectionStatus;
  initialize?(): Promise<void>;
  authUrl(): Promise<string | undefined>;
  handleCallback(code: string, state: string): Promise<void>;
  disconnect(): Promise<void>;
  createMarker(
    stream: Stream,
    star: Star,
    description: string,
  ): Promise<{ id: string; positionSeconds: number }>;
  createClip(stream: Stream, star: Star): Promise<{ id: string }>;
  sendChat(stream: Stream, text: string): Promise<void>;
  /** Only return an archive whose video.stream_id === stream.id. */
  getArchiveVod(stream: Stream): Promise<{ id: string } | undefined>;
  subscribe(listener: (event: TwitchEvent) => Promise<void>): () => void;
  dispose(): Promise<void>;
}
export class TwitchError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export class MockTwitch implements TwitchAdapter {
  readonly mode = "mock" as const;
  private connection: ConnectionState = "connected";
  status(): ConnectionStatus {
    return { mode: this.mode, state: this.connection };
  }
  async authUrl(): Promise<string | undefined> {
    return undefined;
  }
  async handleCallback(_code: string, _state: string) {
    this.connection = "connected";
    await this.emit({ type: "connection.state", status: this.status() });
  }
  async disconnect() {
    this.connection = "disconnected";
    await this.emit({ type: "connection.state", status: this.status() });
  }
  vodSaving = true;
  calls: { method: string; starId?: string; text?: string }[] = [];
  private listeners = new Set<(event: TwitchEvent) => Promise<void>>();
  async createMarker(_stream: Stream, star: Star, description: string) {
    this.calls.push({
      method: "createMarker",
      starId: star.id,
      text: description,
    });
    if (!this.vodSaving) throw new TwitchError("VOD saving is off", 404);
    return {
      id: `mock-marker-${star.id}`,
      positionSeconds: star.offsetSeconds + 15,
    };
  }
  async createClip(_stream: Stream, star: Star) {
    this.calls.push({ method: "createClip", starId: star.id });
    return { id: `mock-clip-${star.id}` };
  }
  async sendChat(_stream: Stream, text: string) {
    this.calls.push({ method: "sendChat", text });
  }
  async getArchiveVod(stream: Stream) {
    this.calls.push({ method: "getArchiveVod" });
    return this.vodSaving ? { id: `mock-vod-${stream.id}` } : undefined;
  }
  subscribe(listener: (event: TwitchEvent) => Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async emit(event: TwitchEvent) {
    for (const listener of this.listeners) await listener(event);
  }
  async dispose() {
    this.listeners.clear();
  }
}

export const twitchScopes = [
  "user:read:chat",
  "user:write:chat",
  "channel:manage:broadcast",
  "clips:edit",
];
const helix = "https://api.twitch.tv/helix/";
const oauth = "https://id.twitch.tv/oauth2/";
const eventsub = "wss://eventsub.wss.twitch.tv/ws";
type Socket = Pick<WebSocket, "on" | "close" | "terminate">;
export interface LiveTwitchOptions {
  clientId: string;
  clientSecret: string;
  channel: string;
  redirectUri: string;
  dataDir?: string;
  // Dependency injection keeps every Twitch HTTP/WS request fake in tests.
  fetch?: typeof fetch;
  socket?: (url: string) => Socket;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
interface ValidatedToken {
  client_id: string;
  user_id: string;
  login: string;
  scopes: string[];
  expires_in: number;
}
interface LiveStream {
  id: string;
  started_at: string;
  title: string;
  viewer_count: number;
}
interface EventMessage {
  metadata: {
    message_type: string;
    message_id: string;
    message_timestamp: string;
  };
  payload: {
    session?: {
      id: string;
      keepalive_timeout_seconds?: number;
      reconnect_url?: string;
    };
    subscription?: { type: string; status: string };
    event?: {
      id: string;
      started_at: string;
      broadcaster_user_id: string;
      chatter_user_id: string;
      chatter_user_name: string;
      message_id: string;
      message: { text: string };
      badges: { set_id: string }[];
    };
  };
}
/** Broadcaster user-token adapter. Errors deliberately omit upstream bodies, URLs and credentials. */
export class LiveTwitch implements TwitchAdapter {
  readonly mode = "live" as const;
  private connection: ConnectionState = "disconnected";
  private listeners = new Set<(event: TwitchEvent) => Promise<void>>();
  private tokens?: Tokens;
  private vault: TokenVault;
  private fetcher: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private makeSocket: (url: string) => Socket;
  private csrf?: { value: string; expires: number };
  private refreshing?: Promise<void>;
  private authEpoch = 0;
  private abort = new AbortController();
  private socket?: Socket;
  private sockets = new Set<Socket>();
  private heartbeat?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private maintenance?: ReturnType<typeof setInterval>;
  private maintaining = false;
  private validatedAt = 0;
  private streamCheckedAt = 0;
  private reconnectAttempts = 0;
  private seen = new Set<string>();
  private events: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private options: LiveTwitchOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => delay(ms, undefined, { signal: this.abort.signal }));
    this.makeSocket =
      options.socket ??
      ((url) =>
        new WebSocket(url, {
          maxPayload: 256 * 1024,
          handshakeTimeout: 10_000,
        }));
    this.vault = new TokenVault(
      options.dataDir ?? resolve("data"),
      options.clientSecret,
      `${options.clientId}:${options.channel.toLowerCase()}`,
    );
  }
  status(): ConnectionStatus {
    return { mode: this.mode, state: this.connection };
  }
  subscribe(listener: (event: TwitchEvent) => Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async emit(event: TwitchEvent) {
    for (const listener of this.listeners) await listener(event);
  }
  private async setConnection(state: ConnectionState) {
    this.connection = state;
    await this.emit({ type: "connection.state", status: this.status() });
  }
  async authUrl() {
    const value = randomBytes(32).toString("hex");
    this.csrf = { value, expires: this.now() + 600_000 };
    const url = new URL(oauth + "authorize");
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: "code",
      scope: twitchScopes.join(" "),
      state: value,
      force_verify: "true",
    }).toString();
    return url.href;
  }
  async handleCallback(code: string, state: string) {
    const expected = this.csrf;
    this.csrf = undefined; // Single-use, including failed attempts.
    if (
      !expected ||
      this.now() > expected.expires ||
      !code ||
      !/^[a-f0-9]{64}$/.test(state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(expected.value))
    )
      throw new ValidationError(
        "Twitch authorization expired or state did not match",
        400,
      );
    this.stopTransport();
    const epoch = ++this.authEpoch;
    this.refreshing = undefined;
    this.abort.abort();
    this.abort = new AbortController();
    this.stopped = false;
    await this.setConnection("connecting");
    try {
      const response = await this.tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.options.redirectUri,
      });
      const identity = await this.validate(response.access_token);
      this.checkEpoch(epoch);
      this.tokens = {
        access: response.access_token,
        refresh: response.refresh_token,
        expiresAt: this.now() + response.expires_in * 1000,
        userId: identity.user_id,
      };
      await this.vault.save(this.tokens);
      this.checkEpoch(epoch);
      this.startTransport();
    } catch {
      if (epoch === this.authEpoch) {
        this.tokens = undefined;
        await this.setConnection("error");
      }
      throw new ValidationError(
        "Twitch connection failed. Check app settings, permissions and broadcaster account, then reconnect.",
        400,
      );
    }
  }
  async initialize() {
    const epoch = this.authEpoch;
    try {
      this.tokens = await this.vault.load();
      this.checkEpoch(epoch);
      if (!this.tokens) return; // Starting disconnected makes NO Twitch calls.
      await this.ensureToken();
      await this.validateCurrent();
      this.checkEpoch(epoch);
      this.startTransport();
    } catch {
      if (epoch === this.authEpoch) await this.setConnection("error");
    }
  }
  private checkEpoch(epoch: number) {
    if (epoch !== this.authEpoch || this.stopped)
      throw new TwitchError("Twitch connection ended", 401);
  }
  private async request(url: string, init: RequestInit = {}) {
    try {
      return await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(10_000),
        ]),
      });
    } catch {
      throw new TwitchError("Twitch request failed", 503);
    }
  }
  private async json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new TwitchError("Invalid Twitch response", 502);
    }
  }
  private async tokenRequest(
    fields: Record<string, string>,
  ): Promise<TokenResponse> {
    const response = await this.request(oauth + "token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...fields,
      }),
    });
    if (!response.ok)
      throw new TwitchError("Twitch authorization failed", response.status);
    const data = await this.json<TokenResponse>(response);
    if (!data.access_token || !data.refresh_token || !(data.expires_in > 0))
      throw new TwitchError("Invalid Twitch authorization", 502);
    return data;
  }
  private async validate(access: string) {
    const response = await this.request(oauth + "validate", {
      headers: { Authorization: `OAuth ${access}` },
    });
    if (!response.ok)
      throw new TwitchError("Twitch authorization is invalid", response.status);
    const data = await this.json<ValidatedToken>(response);
    if (
      data.client_id !== this.options.clientId ||
      data.login?.toLowerCase() !== this.options.channel.toLowerCase() ||
      !data.user_id ||
      !twitchScopes.every((scope) => data.scopes?.includes(scope))
    )
      throw new TwitchError(
        "Authorize the configured broadcaster with all required permissions",
        403,
      );
    this.validatedAt = this.now();
    return data;
  }
  private async validateCurrent() {
    try {
      await this.validate(this.tokens!.access);
    } catch (error) {
      if (!(error instanceof TwitchError) || error.status !== 401) throw error;
      await this.refresh();
      await this.validate(this.tokens!.access);
    }
  }
  private async ensureToken() {
    if (!this.tokens) throw new TwitchError("Connect Twitch first", 401);
    if (this.now() >= this.tokens.expiresAt - 60_000) await this.refresh();
    return this.tokens!;
  }
  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const epoch = this.authEpoch;
    const old = this.tokens;
    if (!old)
      return Promise.reject(new TwitchError("Connect Twitch first", 401));
    const job = (async () => {
      const response = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: old.refresh,
      });
      this.checkEpoch(epoch);
      this.tokens = {
        ...old,
        access: response.access_token,
        refresh: response.refresh_token,
        expiresAt: this.now() + response.expires_in * 1000,
      };
      await this.vault.save(this.tokens);
      this.checkEpoch(epoch);
    })()
      .catch(async () => {
        if (epoch === this.authEpoch && !this.stopped) {
          this.stopTransport();
          await this.setConnection("error");
        }
        throw new TwitchError(
          "Twitch authorization refresh failed; reconnect",
          401,
        );
      })
      .finally(() => {
        if (this.refreshing === job) this.refreshing = undefined;
      });
    this.refreshing = job;
    return job;
  }
  private async api<T>(
    path: string,
    method = "GET",
    body?: object,
  ): Promise<T> {
    const epoch = this.authEpoch;
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.ensureToken();
      this.checkEpoch(epoch);
      let response: Response;
      try {
        response = await this.request(helix + path, {
          method,
          headers: {
            "Client-Id": this.options.clientId,
            Authorization: `Bearer ${token.access}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        // A timed-out write might have succeeded: NEVER replay marker, clip or chat.
        if (method !== "GET" || attempt === 2) throw error;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.status === 401 && !refreshed && attempt < 2) {
        if (this.tokens?.access === token.access) await this.refresh();
        refreshed = true;
        continue; // Explicit rejection is safe to retry.
      }
      if (response.status === 429 && attempt < 2) {
        const reset =
          Number(response.headers.get("Ratelimit-Reset")) * 1000 - this.now();
        const retryAfter = Number(response.headers.get("Retry-After")) * 1000;
        const wait = Math.max(
          500 * 2 ** attempt,
          ...[reset, retryAfter].filter(Number.isFinite),
        );
        if (wait > 30_000)
          throw new TwitchError("Twitch rate limit reached; try later", 429);
        await this.sleep(wait);
        continue;
      }
      if (response.status >= 500 && method === "GET" && attempt < 2) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok)
        throw new TwitchError("Twitch request was rejected", response.status);
      return await this.json<T>(response);
    }
    throw new TwitchError("Twitch retry limit reached", 503);
  }
  async createMarker(_stream: Stream, _star: Star, description: string) {
    const { userId } = await this.ensureToken();
    const result = await this.api<{
      data: { id: string; position_seconds: number }[];
    }>("streams/markers", "POST", {
      user_id: userId,
      description: [...description].slice(0, 140).join(""),
    });
    const marker = result.data?.[0];
    if (!marker?.id || !Number.isFinite(marker.position_seconds))
      throw new TwitchError("Invalid marker response", 502);
    return { id: marker.id, positionSeconds: marker.position_seconds };
  }
  async createClip(stream: Stream, _star: Star) {
    // Service reserves/persists one of 20 attempts before calling the adapter.
    if (stream.clipAttempts > 20)
      throw new TwitchError("Stream clip limit reached", 429);
    const { userId } = await this.ensureToken();
    const result = await this.api<{ data: { id: string }[] }>(
      `clips?broadcaster_id=${encodeURIComponent(userId)}`,
      "POST",
    );
    if (!result.data?.[0]?.id)
      throw new TwitchError("Invalid clip response", 502);
    return { id: result.data[0].id };
  }
  async sendChat(_stream: Stream, text: string) {
    const { userId } = await this.ensureToken();
    const result = await this.api<{ data: { is_sent: boolean }[] }>(
      "chat/messages",
      "POST",
      {
        broadcaster_id: userId,
        sender_id: userId,
        message: text,
      },
    );
    if (!result.data?.[0]?.is_sent)
      throw new TwitchError("Twitch did not send the chat message", 400);
  }
  async getArchiveVod(stream: Stream) {
    const { userId } = await this.ensureToken();
    // Bounded post-offline polling: archives can appear after the offline event.
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await this.api<{
        data: { id: string; stream_id: string }[];
      }>(`videos?user_id=${encodeURIComponent(userId)}&type=archive&first=100`);
      const video = result.data.find((video) => video.stream_id === stream.id);
      if (video) return { id: video.id };
      if (attempt < 3) await this.sleep(2000 * 2 ** attempt);
    }
    return undefined;
  }
  private startTransport() {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.openSocket();
    this.maintenance = setInterval(() => {
      void this.maintain();
    }, 30_000);
    this.maintenance.unref();
  }
  private async maintain() {
    if (this.maintaining || this.stopped || !this.tokens) return;
    this.maintaining = true;
    try {
      await this.ensureToken();
      if (this.now() - this.validatedAt >= 3_600_000)
        await this.validateCurrent();
      if (this.now() - this.streamCheckedAt >= 60_000) await this.syncStream();
    } catch {
      this.stopTransport();
      await this.setConnection("error");
    } finally {
      this.maintaining = false;
    }
  }
  private queueEvent(action: () => Promise<void>) {
    this.events = this.events.then(action).catch(async (error) => {
      if (!(error instanceof ValidationError))
        await this.setConnection("error");
    });
  }
  private async syncStream() {
    const { userId } = await this.ensureToken();
    const result = await this.api<{ data: LiveStream[] }>(
      `streams?user_id=${encodeURIComponent(userId)}`,
    );
    const stream = result.data[0];
    this.streamCheckedAt = this.now();
    // Helix can lag EventSub. Polls enrich metadata; only EventSub owns lifecycle.
    if (stream)
      this.queueEvent(() =>
        this.emit({
          type: "stream.update",
          id: stream.id,
          title: stream.title,
          viewerCount: stream.viewer_count,
        }),
      );
  }

  private openSocket(url = eventsub, transfer = false) {
    if (this.stopped || !this.tokens) return;
    const old = this.socket;
    const socket = this.makeSocket(url);
    this.sockets.add(socket);
    this.socket = socket;
    void this.setConnection("connecting");
    let welcomed = false;
    let keepalive = 10_000;
    const arm = () => {
      clearTimeout(this.heartbeat);
      this.heartbeat = setTimeout(() => socket.terminate(), keepalive + 1000);
      this.heartbeat.unref();
    };
    arm();
    socket.on("message", (raw) => {
      if (this.stopped || !this.sockets.has(socket)) return;
      let message: EventMessage;
      try {
        message = JSON.parse(raw.toString()) as EventMessage;
      } catch {
        socket.terminate();
        return;
      }
      if (socket === this.socket) arm();
      const { metadata, payload } = message;
      if (!metadata || !payload) {
        socket.terminate();
        return;
      }
      if (metadata.message_type === "session_welcome") {
        if (welcomed || !payload.session?.id) return;
        welcomed = true;
        keepalive = (payload.session.keepalive_timeout_seconds ?? 10) * 1000;
        arm();
        void (async () => {
          // Twitch reconnect_url transfers existing subscriptions; a fresh session must resubscribe.
          if (!transfer) await this.subscribeSession(payload.session!.id);
          if (socket !== this.socket || this.stopped) return;
          if (old && old !== socket) {
            this.sockets.delete(old);
            old.close();
          }
          this.reconnectAttempts = 0;
          await this.setConnection("connected");
          await this.syncStream();
        })().catch(() => {
          socket.terminate();
        });
      } else if (metadata.message_type === "session_reconnect") {
        const target = payload.session?.reconnect_url;
        try {
          const parsed = new URL(target!);
          if (
            parsed.protocol !== "wss:" ||
            parsed.hostname !== "eventsub.wss.twitch.tv" ||
            parsed.port ||
            parsed.username ||
            parsed.password
          )
            throw new Error();
          if (socket === this.socket) this.openSocket(target, true);
        } catch {
          socket.terminate();
        }
      } else if (metadata.message_type === "revocation") {
        this.stopTransport();
        this.authEpoch++;
        this.tokens = undefined;
        this.abort.abort();
        void this.vault
          .delete()
          .catch(() => {})
          .finally(() => this.setConnection("error"));
      } else if (metadata.message_type === "notification") {
        if (this.seen.has(metadata.message_id)) return;
        this.seen.add(metadata.message_id);
        if (this.seen.size > 10_000)
          this.seen.delete(this.seen.values().next().value!);
        this.queueEvent(() => this.notification(message));
      }
      // keepalive resets the watchdog; ws automatically answers protocol ping frames.
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (socket !== this.socket || this.stopped) return;
      clearTimeout(this.heartbeat);
      // If a migration fails, discard both sessions and create/subscribe a fresh one.
      for (const other of this.sockets) other.terminate();
      this.sockets.clear();
      void this.setConnection("connecting");
      if (++this.reconnectAttempts > 8) {
        this.stopTransport();
        void this.setConnection("error");
        return;
      }
      this.retryTimer = setTimeout(
        () => this.openSocket(),
        Math.min(30_000, 500 * 2 ** (this.reconnectAttempts - 1)),
      );
      this.retryTimer.unref();
    });
  }
  private async subscribeSession(sessionId: string) {
    const { userId } = await this.ensureToken();
    await Promise.all(
      ["channel.chat.message", "stream.online", "stream.offline"].map((type) =>
        this.api("eventsub/subscriptions", "POST", {
          type,
          version: "1",
          condition: {
            broadcaster_user_id: userId,
            ...(type === "channel.chat.message" ? { user_id: userId } : {}),
          },
          transport: { method: "websocket", session_id: sessionId },
        }),
      ),
    );
  }
  private async notification(message: EventMessage) {
    const event = message.payload.event;
    if (!event || event.broadcaster_user_id !== this.tokens?.userId) return;
    const type = message.payload.subscription?.type;
    if (type === "channel.chat.message") {
      const at = Date.parse(message.metadata.message_timestamp);
      if (!Number.isFinite(at)) return;
      const badges = new Set(event.badges?.map((badge) => badge.set_id));
      await this.emit({
        type,
        at,
        messageId: event.message_id,
        text: event.message.text,
        user: {
          id: event.chatter_user_id,
          name: event.chatter_user_name,
          isBroadcaster: event.chatter_user_id === this.tokens!.userId,
          isMod: badges.has("moderator"),
          isSubscriber: badges.has("subscriber") || badges.has("founder"),
        },
      });
    } else if (type === "stream.online") {
      await this.emit({
        type,
        id: event.id,
        startedAt: Date.parse(event.started_at),
        viewerCount: 0,
      });
      await this.syncStream();
    } else if (type === "stream.offline") {
      await this.emit({ type });
    }
  }
  private stopTransport() {
    this.stopped = true;
    clearTimeout(this.heartbeat);
    clearTimeout(this.retryTimer);
    clearInterval(this.maintenance);
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.socket = undefined;
  }
  async disconnect() {
    const token = this.tokens?.access;
    this.stopTransport();
    this.authEpoch++;
    this.refreshing = undefined;
    this.csrf = undefined;
    this.abort.abort();
    this.abort = new AbortController();
    this.tokens = undefined;
    let failed = false;
    try {
      if (token) {
        const response = await this.request(oauth + "revoke", {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.options.clientId,
            token,
          }),
        });
        failed = !response.ok;
      }
    } catch {
      failed = true;
    } finally {
      await this.vault.delete();
      await this.setConnection("disconnected");
    }
    if (failed)
      throw new ValidationError(
        "Disconnected locally. Twitch revocation failed; remove Starmark in Twitch Settings → Connections.",
        502,
      );
  }
  async dispose() {
    this.stopTransport();
    this.authEpoch++;
    this.abort.abort();
    this.listeners.clear();
  }
}

/** Only an explicit opt-in AND all three settings enable live mode. Never expose config in status/errors. */
export function configuredTwitch(
  env: NodeJS.ProcessEnv,
  port: number,
): TwitchAdapter {
  if (
    env.STARMARK_MOCK !== "0" ||
    !env.TWITCH_CLIENT_ID ||
    !env.TWITCH_CLIENT_SECRET ||
    !env.TWITCH_CHANNEL
  )
    return new MockTwitch();
  return new LiveTwitch({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    channel: env.TWITCH_CHANNEL,
    redirectUri: `http://localhost:${port}/auth/callback`,
  });
}
