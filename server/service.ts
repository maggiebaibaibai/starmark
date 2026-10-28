import { randomUUID } from 'node:crypto';
import { closeDue, command, clockTime, defaults, markerDescription, topThree, totalLighters, type EngineEvent, type Settings, type Stream, type User } from './engine.js';
import { Store, type SavedState } from './store.js';
import { TwitchError, type TwitchAdapter, type TwitchEvent } from './twitch.js';
export interface ChatLine { at: number; name: string; text: string; kind: 'viewer' | 'bot' | 'system' }
export class Service {
  state!: SavedState;
  active?: Stream;
  messages: ChatLine[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private seenMessages = new Set<string>();
  private sequence = 0;
  constructor(readonly store: Store, readonly twitch: TwitchAdapter, readonly channel: string,
    readonly publish: (event: object) => void, private clock = Date.now) {}
  now() { return this.clock() + this.state.mockOffset; }
  async init() {
    await this.store.init(); this.state = await this.store.state();
    this.state.settings = { ...defaults, ...this.state.settings };
    if (this.state.activeStreamId) this.active = await this.store.stream(this.state.activeStreamId);
    if (this.active?.endedAt !== undefined) this.active = undefined;
    if (!this.active) delete this.state.activeStreamId;
    // An interrupted external write is ambiguous: do not duplicate remote side effects.
    for (const star of this.active?.stars ?? []) if (star.delivery === 'processing') {
      star.delivery = 'done'; this.warn('A star delivery was interrupted. Review its marker/clip in the moderation queue.');
    }
    await this.persist();
  }
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.catch(() => undefined);
    return next;
  }
  private warn(text: string) { if (this.active && !this.active.warnings.includes(text)) this.active.warnings.push(text); }
  private chat(name: string, text: string, kind: ChatLine['kind']) {
    this.messages.push({ at: this.now(), name, text, kind }); this.messages = this.messages.slice(-40);
  }
  private async persist() { if (this.active) await this.store.saveStream(this.active); await this.store.saveState(this.state); }
  async snapshot() {
    const streams = await this.store.streams();
    return { now: this.now(), mode: this.twitch.mode, settings: this.state.settings, active: this.active,
      previous: streams.find(s => s.endedAt !== undefined), messages: this.messages,
      streams: streams.map(s => ({ id: s.id, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, stars: s.stars.length, totalLighters: totalLighters(s.stars), warnings: s.warnings })), sequence: this.sequence };
  }
  private async notify(events: EngineEvent[] = []) { this.sequence++; this.publish({ type: 'state', ...(await this.snapshot()), events }); }
  async start(event: Extract<TwitchEvent, { type: 'stream.online' }>) {
    if (this.active) throw new Error('A stream is already live');
    const startedAt = event.startedAt ?? this.now();
    this.active = { id: event.id ?? `mock-${randomUUID()}`, startedAt, channel: this.channel,
      title: event.title?.trim().slice(0, 140) || 'no hints, final boss', viewerCount: event.viewerCount ?? 32,
      stars: [], cooldowns: {}, sequence: 0, clipAttempts: 0, warnings: [], mock: this.twitch.mode === 'mock' };
    this.state.activeStreamId = this.active.id;
    await this.persist(); this.chat('eventsub', 'stream.online · a new sky is open', 'system');
    await this.notify(); this.publish({ type: 'coldopen', previous: (await this.snapshot()).previous });
    return this.active;
  }
  private async deliver() {
    if (!this.active) return;
    const stream = this.active;
    for (const star of stream.stars.filter(s => s.delivery === 'pending')) {
      star.delivery = 'processing'; await this.persist();
      try { star.marker = await this.twitch.createMarker(stream, star, markerDescription(star)); }
      catch (error) {
        star.markerError = error instanceof Error ? error.message : 'Marker failed';
        this.warn(error instanceof TwitchError && error.status === 404
          ? 'VOD saving is off. Enable Creator Dashboard → Settings → Stream → Store past broadcasts. Cards use clips when no archive is available.'
          : `Marker failed: ${star.markerError}. The original stream offset is saved.`);
      }
      if (star.lighters.length >= 3 && stream.clipAttempts < 20) {
        stream.clipAttempts++; await this.persist();
        try { star.clipId = (await this.twitch.createClip(stream, star)).id; }
        catch (error) { star.clipError = error instanceof Error ? error.message : 'Clip failed'; this.warn(`Clip failed: ${star.clipError}`); }
      }
      const echo = `⭐ @${star.owner.name} lit a star at ${clockTime(star.offsetSeconds)} · ${star.lighters.length} of you joined`;
      try { await this.twitch.sendChat(stream, echo); this.chat('starmark', echo, 'bot'); }
      catch (error) { star.echoError = error instanceof Error ? error.message : 'Chat echo failed'; this.warn(`Chat echo failed: ${star.echoError}`); }
      star.delivery = 'done'; await this.persist();
    }
  }
  async tick() {
    if (!this.active) return;
    const result = closeDue(this.active, this.now(), this.state.settings);
    this.active = result.stream;
    if (result.events.length || this.active.stars.some(s => s.delivery === 'pending')) {
      await this.deliver(); await this.persist(); await this.notify(result.events);
    }
  }
  async message(user: User, text: string, messageId: string = randomUUID()) {
    if (!this.active) throw new Error('Start a mock stream first');
    if (this.seenMessages.has(messageId)) return { accepted: false, message: 'Duplicate event ignored' };
    this.seenMessages.add(messageId); if (this.seenMessages.size > 10_000) this.seenMessages.delete(this.seenMessages.values().next().value!);
    this.chat(user.name, text, 'viewer');
    const result = command(this.active, user, text, this.now(), this.state.settings);
    this.active = result.stream; await this.deliver(); await this.persist(); await this.notify(result.events);
    return { accepted: result.accepted, message: result.message };
  }
  async end() {
    if (!this.active) throw new Error('No active stream');
    const closed = closeDue(this.active, this.now(), this.state.settings, true);
    this.active = closed.stream; await this.deliver();
    try { this.active.vodId = (await this.twitch.getArchiveVod(this.active))?.id; }
    catch (error) { this.warn(`Archive lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    if (!this.active.vodId) this.warn('No archive found. Stars with saved clips remain playable; other stars keep their timestamp.');
    this.active.endedAt = this.now(); const ended = this.active;
    await this.store.saveStream(ended); this.active = undefined; delete this.state.activeStreamId;
    await this.persist(); this.chat('eventsub', 'stream.offline · your starmap is ready', 'system');
    await this.notify(closed.events); return ended;
  }
  async advance(ms: number) { this.state.mockOffset += ms; await this.tick(); await this.persist(); await this.notify(); }
  async settings(settings: Settings) { this.state.settings = settings; await this.persist(); await this.notify(); }
  async removeStar(id: string) {
    if (!this.active) throw new Error('No active stream');
    const star = this.active.stars.find(s => s.id === id); if (!star) throw new Error('Star not found');
    this.active.stars = this.active.stars.filter(s => s.id !== id); await this.persist(); await this.notify([{ type: 'removed', star }]);
  }
  card(stream: Stream) {
    return { ...stream, totalLighters: totalLighters(stream.stars), topThree: topThree(stream.stars).map(s => s.id),
      durationSeconds: Math.max(0, Math.floor(((stream.endedAt ?? this.now()) - stream.startedAt) / 1000)) };
  }
}
