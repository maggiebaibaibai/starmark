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
  | { type: "stream.update"; title?: string; viewerCount?: number }
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
/** Task 2 implementation checklist (never silently connect in Task 1):
 * OAuth authorization code + CSRF state; encrypted tokens/refresh; localhost callback.
 * Scopes: user:read:chat user:write:chat channel:manage:broadcast clips:edit.
 * EventSub WS welcome/keepalive/reconnect/revocation and message-id deduplication;
 * channel.chat.message, stream.online, stream.offline. Resolve channel metadata,
 * subscriber eligibility and viewer count; followers-only is intentionally omitted.
 * Helix requests, 401 refresh, 429 backoff, bounded retries; never retry ambiguous
 * createClip/marker writes blindly. Markers use response position_seconds separately
 * from our original event offset. Archive lookup must match video.stream_id === stream.id,
 * poll after offline until the archive appears. Clip embed parent from public host.
 * Non-Affiliate support; actionable VOD 404; disconnect/revoke and secret redaction.
 */
