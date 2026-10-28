/** Pure star engine. All times are injected epoch milliseconds; no I/O or timers. */
export interface Settings {
  mergeMs: number;
  cooldownMs: number;
  gapMs: number;
  blocklist: string[];
  subsOnly: boolean;
  followersOnly: boolean;
  namesOnly: boolean;
  namesOnlyThreshold: number;
}
export const defaults: Settings = {
  mergeMs: 15_000,
  cooldownMs: 90_000,
  gapMs: 20_000,
  blocklist: [],
  subsOnly: false,
  followersOnly: false,
  namesOnly: false,
  namesOnlyThreshold: 500,
};
export interface User {
  id: string;
  name: string;
  isMod?: boolean;
  isBroadcaster?: boolean;
  isSubscriber?: boolean;
  isFollower?: boolean;
}
export interface Star {
  id: string;
  owner: User;
  reason: string;
  lighters: User[];
  openedAt: number;
  closedAt?: number;
  offsetSeconds: number;
  delivery?: "pending" | "processing" | "done";
  marker?: { id: string; positionSeconds: number };
  clipId?: string;
  markerError?: string;
  clipError?: string;
  echoError?: string;
}
export interface Stream {
  id: string;
  channel: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  viewerCount: number;
  stars: Star[];
  cooldowns: Record<string, number>;
  lastOpenedAt?: number;
  sequence: number;
  clipAttempts: number;
  vodId?: string;
  warnings: string[];
  mock: boolean;
}
export type EngineEvent = {
  type: "opened" | "joined" | "closed" | "removed";
  star: Star;
};
export interface Result {
  stream: Stream;
  events: EngineEvent[];
  accepted: boolean;
  message: string;
}
export function sanitizeReason(raw: string, blocklist: string[] = []): string {
  const clean = raw
    .normalize("NFKC")
    .replace(
      /(?:https?:\/\/|www\.)\S+|\b(?:[\p{L}\d-]+\.)+[a-z]{2,}(?:\/\S*)?/giu,
      "",
    )
    .replace(/@[\p{L}\p{N}_.-]+/gu, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const folded = clean.toLocaleLowerCase();
  // JS \b is ASCII-oriented. Unicode letters, combining marks, numbers and
  // connector punctuation form words; punctuation/whitespace form boundaries.
  const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
  for (const entry of blocklist) {
    const word = entry.trim().normalize("NFKC").toLocaleLowerCase();
    if (!word) continue;
    let from = 0;
    for (let index = folded.indexOf(word, from); index >= 0; index = folded.indexOf(word, from)) {
      const before = Array.from(folded.slice(0, index)).at(-1) ?? "";
      const after = Array.from(folded.slice(index + word.length))[0] ?? "";
      if (!wordCharacter.test(before) && !wordCharacter.test(after)) return "";
      from = index + word.length;
    }
  }
  return Array.from(clean).slice(0, 40).join("");
}
export function closeDue(
  stream: Stream,
  now: number,
  settings: Settings,
  force = false,
): Result {
  const events: EngineEvent[] = [];
  const stars = stream.stars.map((star) => {
    if (
      star.closedAt !== undefined ||
      (!force && now < star.openedAt + settings.mergeMs)
    )
      return star;
    const closed = { ...star, closedAt: now, delivery: "pending" as const };
    events.push({ type: "closed", star: closed });
    return closed;
  });
  return {
    stream: { ...stream, stars },
    events,
    accepted: true,
    message: "Closed due stars",
  };
}
export function command(
  input: Stream,
  user: User,
  text: string,
  now: number,
  settings: Settings,
): Result {
  const closed = closeDue(input, now, settings);
  let stream = closed.stream;
  const events = closed.events;
  const reply = (accepted: boolean, message: string): Result => ({
    stream,
    events,
    accepted,
    message,
  });
  if (stream.endedAt !== undefined) return reply(false, "Stream has ended");
  if (/^!unstar\s*$/i.test(text.trim())) {
    if (!user.isMod && !user.isBroadcaster)
      return reply(false, "Only moderators can remove a star");
    const last = stream.stars.at(-1);
    if (!last) return reply(false, "No star to remove");
    stream = { ...stream, stars: stream.stars.slice(0, -1) };
    // Removing a star does not reset anti-spam clocks or delete remote markers/clips.
    events.push({ type: "removed", star: last });
    return reply(true, "Last star removed");
  }
  const match = /^!star(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return reply(false, "Use !star [reason] or !unstar");
  if (
    settings.subsOnly &&
    !user.isSubscriber &&
    !user.isMod &&
    !user.isBroadcaster
  )
    return reply(false, "Subscribers only");
  if (
    settings.followersOnly &&
    !user.isFollower &&
    !user.isMod &&
    !user.isBroadcaster
  )
    return reply(false, "Followers only");
  const open = stream.stars.find((star) => star.closedAt === undefined);
  if (open?.lighters.some((lighter) => lighter.id === user.id))
    return reply(false, "Already lighting this star");
  const last = stream.cooldowns[user.id];
  if (last !== undefined && now - last < settings.cooldownMs)
    return reply(false, "Your star cooldown is active");
  if (
    !open &&
    stream.lastOpenedAt !== undefined &&
    now - stream.lastOpenedAt < settings.gapMs
  )
    return reply(false, "Waiting for the global star gap");
  const cooldowns = { ...stream.cooldowns, [user.id]: now };
  if (open) {
    const joined = { ...open, lighters: [...open.lighters, { ...user }] };
    stream = {
      ...stream,
      cooldowns,
      stars: stream.stars.map((star) => (star.id === open.id ? joined : star)),
    };
    events.push({ type: "joined", star: joined });
    return reply(true, "Joined the open star");
  }
  const star: Star = {
    id: `${stream.id}-${stream.sequence + 1}`,
    owner: { ...user },
    reason: sanitizeReason(match[1] ?? "", settings.blocklist),
    lighters: [{ ...user }],
    openedAt: now,
    offsetSeconds: Math.max(0, Math.floor((now - stream.startedAt) / 1000)),
  };
  stream = {
    ...stream,
    cooldowns,
    lastOpenedAt: now,
    sequence: stream.sequence + 1,
    stars: [...stream.stars, star],
  };
  events.push({ type: "opened", star });
  return reply(true, "A star ignited");
}
export function topThree(stars: Star[]): Star[] {
  return [...stars]
    .sort(
      (a, b) =>
        b.lighters.length - a.lighters.length ||
        a.openedAt - b.openedAt ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 3);
}
export function totalLighters(stars: Star[]): number {
  return stars.reduce((sum, star) => sum + star.lighters.length, 0);
}
export function vodTime(offset: number): string {
  const t = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
}
export function clockTime(offset: number): string {
  const t = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
export function momentUrl(stream: Stream, star: Star): string | undefined {
  if (stream.vodId)
    return `https://www.twitch.tv/videos/${encodeURIComponent(stream.vodId)}?t=${vodTime(star.offsetSeconds)}`;
  if (star.clipId)
    return `https://clips.twitch.tv/${encodeURIComponent(star.clipId)}`;
}
export function markerDescription(star: Star): string {
  return Array.from(
    `★ @${star.owner.name} +${star.lighters.length - 1}${star.reason ? ": " + star.reason : ""}`,
  )
    .slice(0, 140)
    .join("");
}
