import { randomUUID } from "node:crypto";
import {
  closeDue,
  command,
  clockTime,
  defaults,
  markerDescription,
  topThree,
  totalLighters,
  type EngineEvent,
  type Settings,
  type Star,
  type Stream,
  type User,
} from "./engine.js";
import { Store, type SavedState } from "./store.js";
import { TwitchError, type TwitchAdapter, type TwitchEvent } from "./twitch.js";
import { ValidationError } from "./errors.js";
export interface ChatLine {
  at: number;
  name: string;
  text: string;
  kind: "viewer" | "bot" | "system";
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const deliveryWarning =
  "Star delivery could not be saved. Check server storage; delivery resumes after the next successful write.";
export class Service {
  state!: SavedState;
  active?: Stream;
  messages: ChatLine[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private seenMessages = new Set<string>();
  private sequence = 0;
  private streamCache?: Promise<Stream[]>;
  private unsubscribeCache: () => void;
  private deliveryJob?: Promise<void>;
  private deliveryFailure?: Error;
  private recovery?: () => void;
  private failureSignal = signal();
  private unsubscribeWrites: () => void;
  private disposed = false;
  private ending?: Promise<Stream>;
  private closing = false;
  constructor(
    readonly store: Store,
    readonly twitch: TwitchAdapter,
    readonly channel: string,
    readonly publish: (event: object) => void,
    private clock = Date.now,
  ) {
    this.unsubscribeWrites = store.onWrite(() => {
      if (!this.deliveryFailure) return;
      this.deliveryFailure = undefined;
      this.failureSignal = signal();
      this.recovery?.();
      this.recovery = undefined;
      this.publish({ type: "delivery.status", warning: null });
      queueMicrotask(() => {
        if (!this.disposed) this.scheduleDelivery();
      });
    });
    this.unsubscribeCache = store.onStreamSaved(() => {
      this.streamCache = undefined;
    });
  }
  now() {
    return this.clock() + this.state.mockOffset;
  }
  async init() {
    await this.store.init();
    this.state = await this.store.state();
    // Pick supported settings so old followersOnly preferences do not survive migration.
    this.state.settings = Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [
        key,
        this.state.settings[key as keyof Settings] ?? value,
      ]),
    ) as unknown as Settings;
    if (this.twitch.mode === "live") this.state.mockOffset = 0;
    if (this.state.activeStreamId)
      this.active = await this.store.stream(this.state.activeStreamId);
    if (
      this.active?.endedAt !== undefined ||
      (this.active && this.active.mock !== (this.twitch.mode === "mock"))
    )
      this.active = undefined;
    if (!this.active) delete this.state.activeStreamId;
    this.recoverInterruptedDelivery();
    await this.persist();
  }
  private recoverInterruptedDelivery() {
    for (const star of this.active?.stars ?? [])
      if (star.delivery === "processing") {
        star.delivery = "done";
        this.warn(
          "A star delivery was interrupted. Review its marker/clip in the moderation queue.",
        );
      }
  }
  /** Serialize state/file mutations only. Never await external I/O jobs inside this queue. */
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.catch(() => undefined);
    return next;
  }
  private warn(text: string) {
    if (this.active && !this.active.warnings.includes(text))
      this.active.warnings.push(text);
  }
  private chat(
    name: string,
    text: string,
    kind: ChatLine["kind"],
    at = this.now(),
  ) {
    const line = { at, name, text, kind };
    this.messages.push(line);
    this.messages = this.messages.slice(-40);
    return line;
  }
  private async persist() {
    if (this.active) await this.store.saveStream(this.active);
    await this.store.saveState(this.state);
  }
  async snapshot() {
    const streams = await (this.streamCache ??= this.store
      .streams()
      .catch((error) => {
        this.streamCache = undefined;
        throw error;
      }));
    return {
      now: this.now(),
      mode: this.twitch.mode,
      connection: this.twitch.status(),
      deliveryWarning: this.deliveryFailure ? deliveryWarning : undefined,
      settings: this.state.settings,
      active: this.active,
      previous: streams.find((s) => s.endedAt !== undefined),
      messages: this.messages,
      streams: streams.map((s) => ({
        id: s.id,
        title: s.title,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        stars: s.stars.length,
        totalLighters: totalLighters(s.stars),
        warnings: s.warnings,
      })),
      sequence: this.sequence,
    };
  }
  private async notify(events: EngineEvent[] = []) {
    this.sequence++;
    this.publish({ type: "state", ...(await this.snapshot()), events });
  }
  start(event: Extract<TwitchEvent, { type: "stream.online" }>) {
    return this.run(async () => {
      if (event.id && this.active?.id === event.id) return this.active;
      if (this.active)
        throw new ValidationError("A stream is already live", 409);
      const saved = event.id ? await this.store.stream(event.id) : undefined;
      // Late/replayed online events must never erase or reopen a completed starmap.
      if (saved?.endedAt !== undefined) return saved;
      if (saved && saved.mock !== (this.twitch.mode === "mock"))
        throw new ValidationError("Stream belongs to a different mode", 409);
      this.active = saved ?? {
        id: event.id ?? `mock-${randomUUID()}`,
        startedAt: event.startedAt ?? this.now(),
        channel: this.channel,
        title: event.title?.trim().slice(0, 140) || "no hints, final boss",
        viewerCount: event.viewerCount ?? 32,
        stars: [],
        cooldowns: {},
        sequence: 0,
        clipAttempts: 0,
        warnings: [],
        mock: this.twitch.mode === "mock",
      };
      if (saved) this.recoverInterruptedDelivery();
      this.state.activeStreamId = this.active.id;
      await this.persist();
      this.chat("eventsub", "stream.online · a new sky is open", "system");
      await this.notify();
      this.publish({
        type: "coldopen",
        previous: (await this.snapshot()).previous,
      });
      return this.active;
    });
  }
  private scheduleDelivery() {
    if (this.deliveryJob) return;
    if (this.deliveryFailure) return;
    this.deliveryJob = this.deliver()
      .catch((error) => {
        this.deliveryFailure = new Error(deliveryWarning);
        this.failureSignal.resolve();
        this.publish({
          type: "error",
          message: "Star delivery could not be saved. Check server storage.",
        });
      })
      .finally(() => {
        this.deliveryJob = undefined;
        if (
          !this.deliveryFailure &&
          this.active?.stars.some((s) => s.delivery === "pending")
        )
          this.scheduleDelivery();
      });
  }
  /** Called outside run(), e.g. on offline or shutdown; normal chat never waits here. */
  async waitForDelivery() {
    while (this.deliveryJob) {
      if (this.deliveryFailure) throw this.deliveryFailure;
      await Promise.race([this.deliveryJob, this.failureSignal.promise]);
    }
    if (this.deliveryFailure) throw this.deliveryFailure;
  }
  /** Keep the in-memory continuation at the failed disk checkpoint. Never replay a remote call. */
  private async deliveryWrite(streamId: string, starId: string) {
    for (;;) {
      if (this.disposed) return false;
      try {
        return await this.run(async () => {
          if (
            this.active?.id !== streamId ||
            !this.active.stars.some((s) => s.id === starId)
          )
            return false;
          await this.store.saveStream(this.active);
          return true;
        });
      } catch {
        const recovered = signal();
        this.recovery = recovered.resolve;
        this.deliveryFailure = new Error(deliveryWarning);
        this.failureSignal.resolve();
        this.publish({ type: "delivery.status", warning: deliveryWarning });
        // Wait OUTSIDE run(), allowing settings, moderation and ticks to prove storage works again.
        await recovered.promise;
      }
    }
  }
  private async patchDelivery(
    streamId: string,
    starId: string,
    patch: (star: Star) => void,
    notify = false,
  ) {
    const applied = await this.run(async () => {
      if (this.active?.id !== streamId) return false;
      const star = this.active.stars.find((s) => s.id === starId);
      if (!star) return false;
      patch(star);
      return true;
    });
    if (!applied || !(await this.deliveryWrite(streamId, starId))) return false;
    if (notify) await this.run(() => this.notify());
    return true;
  }
  private async deliver() {
    for (;;) {
      const work = await this.run(async () => {
        const stream = this.active;
        const star = stream?.stars.find((s) => s.delivery === "pending");
        if (!stream || !star) return undefined;
        star.delivery = "processing"; // Durable lock before any external call.
        const makeClip = star.lighters.length >= 3 && stream.clipAttempts < 20;
        if (makeClip) stream.clipAttempts++;
        return {
          stream: structuredClone(stream),
          star: structuredClone(star),
          makeClip,
        };
      });
      if (!work) return;
      const { stream, star, makeClip } = work;
      if (!(await this.deliveryWrite(stream.id, star.id))) continue;
      let marker: Star["marker"],
        markerError: string | undefined,
        vodOff = false;
      try {
        marker = await this.twitch.createMarker(
          stream,
          star,
          markerDescription(star),
        );
      } catch (error) {
        markerError = "Marker request failed";
        vodOff = error instanceof TwitchError && error.status === 404;
      }
      if (
        !(await this.patchDelivery(stream.id, star.id, (current) => {
          current.marker = marker;
          current.markerError = markerError;
          if (markerError)
            this.warn(
              vodOff
                ? "VOD saving is off. Enable Creator Dashboard → Settings → Stream → Store past broadcasts. Cards use clips when no archive is available."
                : "Marker failed. The original stream offset is saved.",
            );
        }))
      )
        continue;
      if (makeClip) {
        let clipId: string | undefined, clipError: string | undefined;
        try {
          clipId = (await this.twitch.createClip(stream, star)).id;
        } catch {
          clipError = "Clip request failed";
        }
        if (
          !(await this.patchDelivery(stream.id, star.id, (current) => {
            current.clipId = clipId;
            current.clipError = clipError;
            if (clipError)
              this.warn(
                "Clip request failed. The original stream offset is saved.",
              );
          }))
        )
          continue;
      }
      // N includes the owner; marker +N-1 means the other viewers, not a different total.
      const echo = `⭐ @${star.owner.name} lit a star at ${clockTime(star.offsetSeconds)} · ${star.lighters.length} of you`;
      let echoError: string | undefined;
      try {
        await this.twitch.sendChat(stream, echo);
      } catch {
        echoError = "Chat echo request failed";
      }
      await this.patchDelivery(
        stream.id,
        star.id,
        (current) => {
          current.echoError = echoError;
          current.delivery = "done";
          if (echoError) this.warn("Chat echo request failed.");
          else this.chat("starmark", echo, "bot");
        },
        true,
      );
    }
  }
  private async closeTick() {
    if (!this.active || this.active.endedAt !== undefined || this.ending)
      return;
    const result = closeDue(this.active, this.now(), this.state.settings);
    this.active = result.stream;
    if (
      result.events.length ||
      this.active.stars.some((s) => s.delivery === "pending")
    ) {
      await this.persist();
      await this.notify(result.events);
      this.scheduleDelivery();
    }
  }
  tick() {
    return this.run(() => this.closeTick());
  }
  message(
    user: User,
    text: string,
    messageId: string = randomUUID(),
    at = this.now(),
  ) {
    // Default arguments capture mock arrival time BEFORE this message enters the queue.
    return this.run(async () => {
      if (!Number.isFinite(at))
        throw new ValidationError("Invalid message timestamp");
      if (this.seenMessages.has(messageId))
        return { accepted: false, message: "Duplicate event ignored" };
      this.seenMessages.add(messageId);
      if (this.seenMessages.size > 10_000)
        this.seenMessages.delete(this.seenMessages.values().next().value!);
      const line = this.chat(user.name, text, "viewer", at);
      if (!/^!(?:star|unstar)(?:\s|$)/i.test(text.trim())) {
        this.publish({ type: "chat", line });
        return { accepted: false, message: "Chat received" };
      }
      if (!this.active) throw new ValidationError("Start a stream first", 409);
      if (this.closing) throw new ValidationError("Stream is ending", 409);
      const result = command(this.active, user, text, at, this.state.settings);
      if (result.accepted || result.events.length) {
        this.active = result.stream;
        await this.persist();
        await this.notify(result.events);
        this.scheduleDelivery();
      } else this.publish({ type: "chat", line });
      return { accepted: result.accepted, message: result.message };
    });
  }
  end(): Promise<Stream> {
    if (this.ending)
      return Promise.reject(
        new ValidationError("Stream is already ending", 409),
      );
    this.ending = this.finishStream().finally(() => {
      this.ending = undefined;
      this.closing = false;
    });
    return this.ending;
  }
  private async finishStream() {
    const { id, endedAt } = await this.run(async () => {
      if (!this.active) throw new ValidationError("No active stream", 409);
      this.closing = true;
      const closed = closeDue(
        this.active,
        this.now(),
        this.state.settings,
        true,
      );
      this.active = closed.stream;
      await this.persist();
      await this.notify(closed.events);
      this.scheduleDelivery();
      return { id: this.active.id, endedAt: this.active.endedAt ?? this.now() };
    });
    await this.waitForDelivery();
    let vodId: string | undefined,
      archiveFailed = false;
    try {
      vodId = (await this.twitch.getArchiveVod(structuredClone(this.active!)))
        ?.id;
    } catch {
      archiveFailed = true;
    }
    return this.run(async () => {
      const ended = this.active!;
      if (ended.id !== id)
        throw new Error("Stream lifecycle changed during offline");
      ended.endedAt = endedAt;
      ended.vodId = vodId;
      if (archiveFailed)
        this.warn(
          "Archive lookup failed. Retry when the archive is available.",
        );
      if (!vodId)
        this.warn(
          "No archive found. Stars with saved clips remain playable; other stars keep their timestamp.",
        );
      await this.store.saveStream(ended);
      this.active = undefined;
      delete this.state.activeStreamId;
      await this.persist();
      this.chat("eventsub", "stream.offline · your starmap is ready", "system");
      await this.notify();
      return ended;
    });
  }
  advance(ms: number) {
    return this.run(async () => {
      this.state.mockOffset += ms;
      await this.closeTick();
      await this.store.saveState(this.state);
      await this.notify();
    });
  }
  settings(settings: Settings) {
    return this.run(async () => {
      this.state.settings = settings;
      await this.persist();
      await this.notify();
    });
  }
  updateStream(event: Extract<TwitchEvent, { type: "stream.update" }>) {
    return this.run(async () => {
      if (!this.active || (event.id && event.id !== this.active.id)) return;
      if (
        event.viewerCount !== undefined &&
        (!Number.isFinite(event.viewerCount) || event.viewerCount < 0)
      )
        throw new ValidationError("Invalid viewer count");
      if (event.title !== undefined)
        this.active.title = event.title.trim().slice(0, 140);
      if (event.viewerCount !== undefined)
        this.active.viewerCount = Math.floor(event.viewerCount);
      await this.persist();
      await this.notify();
    });
  }
  removeStar(id: string) {
    return this.run(async () => {
      if (!this.active) throw new ValidationError("No active stream", 409);
      const star = this.active.stars.find((s) => s.id === id);
      if (!star) throw new ValidationError("Star not found", 404);
      this.active.stars = this.active.stars.filter((s) => s.id !== id);
      await this.persist();
      await this.notify([{ type: "removed", star }]);
    });
  }
  async dispose() {
    await this.run(async () => {});
    if (this.ending) await this.ending;
    this.disposed = true;
    this.recovery?.();
    await this.deliveryJob;
    this.unsubscribeCache();
    this.unsubscribeWrites();
  }
  card(stream: Stream) {
    return {
      ...stream,
      totalLighters: totalLighters(stream.stars),
      topThree: topThree(stream.stars).map((s) => s.id),
      durationSeconds: Math.max(
        0,
        Math.floor(((stream.endedAt ?? this.now()) - stream.startedAt) / 1000),
      ),
    };
  }
}
