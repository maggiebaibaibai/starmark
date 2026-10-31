import type { Star } from "../server/engine.js";

export interface IgnitionQueue {
  active?: string;
  queue: string[];
}

export function isOpen(star: Star, now: number, mergeMs: number) {
  return star.closedAt === undefined && now < star.openedAt + mergeMs;
}

/** Two bursts total, FIFO. Queued stars retain their original deadline, so
 * delayed/closed stars go straight to the band instead of replaying a window.
 * `opened` contains unseen event IDs (or open stars on initial connection).
 */
export function advanceIgnition(
  current: IgnitionQueue,
  stars: Star[],
  now: number,
  mergeMs: number,
  opened: string[] = [],
): IgnitionQueue {
  const eligible = new Set(stars.filter((s) => isOpen(s, now, mergeMs)).map((s) => s.id));
  let active = current.active && eligible.has(current.active) ? current.active : undefined;
  const queue = current.queue.filter((id) => eligible.has(id));
  for (const id of opened) {
    if (eligible.has(id) && id !== active && !queue.includes(id) &&
        Number(Boolean(active)) + queue.length < 2) queue.push(id);
  }
  active ??= queue.shift();
  return { active, queue };
}

export const ignitionPhase = (star: Star, now: number) =>
  now - star.openedAt < 2000 ? "igniting" : "open";

export const ignitionGrowth = (lighters: number) =>
  1 + Math.min(6, Math.max(0, lighters - 1)) * 0.06;
