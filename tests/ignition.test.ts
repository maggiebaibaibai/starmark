import { describe, expect, it } from "vitest";
import { advanceIgnition, ignitionGrowth, ignitionPhase } from "../web/ignition.js";
import type { Star } from "../server/engine.js";

const star = (id: string, openedAt = 0): Star => ({
  id, openedAt, offsetSeconds: openedAt / 1000, reason: "that sky",
  owner: { id, name: id }, lighters: [{ id, name: id }],
});
const empty = () => ({ queue: [] as string[] });

describe("overlay ignition window", () => {
  it("stays visible across late joiners and releases at the original deadline", () => {
    const s = star("a");
    let queue = advanceIgnition(empty(), [s], 0, 15000, [s.id]);
    for (const now of [5000, 9000, 14999]) {
      queue = advanceIgnition(queue, [s], now, 15000);
      expect(queue.active).toBe("a");
    }
    expect(advanceIgnition(queue, [s], 15000, 15000)).toEqual(empty());
    expect(ignitionPhase(s, 1999)).toBe("igniting");
    expect(ignitionPhase(s, 2000)).toBe("open");
  });
  it("honors early server close and removal", () => {
    const s = star("a");
    const queue = advanceIgnition(empty(), [s], 0, 15000, [s.id]);
    expect(advanceIgnition(queue, [{ ...s, closedAt: 4000 }], 4000, 15000).active).toBeUndefined();
    expect(advanceIgnition(queue, [], 4000, 15000).active).toBeUndefined();
  });
  it("keeps FIFO and the two-burst cap, giving the next star only its remaining time", () => {
    const stars = [star("a"), star("b", 1000), star("c", 2000)];
    const queue = advanceIgnition(empty(), stars, 2000, 15000, ["a", "b", "c"]);
    expect(queue).toEqual({ active: "a", queue: ["b"] });
    const promoted = advanceIgnition(queue, stars, 15000, 15000);
    expect(promoted).toEqual({ active: "b", queue: [] });
    expect(advanceIgnition(promoted, stars, 16000, 15000).active).toBeUndefined();
    expect(advanceIgnition(queue, stars, 15000, 15000)).toEqual(promoted);
  });
  it("expires queued and delayed events without replaying closed windows", () => {
    const stars = [star("a"), star("b")];
    const queued = advanceIgnition(empty(), stars, 0, 15000, ["a", "b"]);
    expect(advanceIgnition(queued, stars, 15000, 15000)).toEqual(empty());
    expect(advanceIgnition(empty(), stars, 16000, 15000, ["a", "b"])).toEqual(empty());
  });
  it("uses the configured window without mutating input and deduplicates pending IDs", () => {
    const stars = [star("a")];
    const before = structuredClone(stars);
    const input = empty();
    const queue = advanceIgnition(input, stars, 0, 4000, ["a", "a"]);
    expect(queue).toEqual({ active: "a", queue: [] });
    expect(advanceIgnition(queue, stars, 4000, 4000).active).toBeUndefined();
    expect(input).toEqual(empty());
    expect(stars).toEqual(before);
  });
  it("grows a little for each joiner and caps growth", () => {
    expect(ignitionGrowth(1)).toBe(1);
    expect(ignitionGrowth(2)).toBe(1.06);
    expect(ignitionGrowth(3)).toBe(1.12);
    expect(ignitionGrowth(100)).toBeCloseTo(1.36);
  });
});
