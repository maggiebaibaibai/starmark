import { describe, expect, it } from "vitest";
import {
  closeDue,
  command,
  defaults,
  markerDescription,
  momentUrl,
  sanitizeReason,
  topThree,
  totalLighters,
  vodTime,
  type Stream,
  type User,
} from "../server/engine.js";
const user = (id: string): User => ({ id, name: id });
const fresh = (): Stream => ({
  id: "s",
  channel: "test",
  title: "Test",
  startedAt: 0,
  viewerCount: 10,
  stars: [],
  cooldowns: {},
  sequence: 0,
  clipAttempts: 0,
  warnings: [],
  mock: true,
});
const star = (s: Stream, id: string, at: number, text = "!star") =>
  command(s, user(id), text, at, defaults);
describe("pure star engine", () => {
  it("merges inside 15 seconds and preserves first owner and reason without mutating input", () => {
    const original = fresh();
    const first = star(original, "a", 0, "!star first");
    const joined = star(first.stream, "b", 14_999, "!star second");
    expect(original.stars).toEqual([]);
    expect(first.stream.stars[0]!.lighters).toHaveLength(1);
    expect(joined.stream.stars).toHaveLength(1);
    expect(joined.stream.stars[0]).toMatchObject({
      owner: user("a"),
      reason: "first",
      lighters: [user("a"), user("b")],
    });
  });
  it("closes exactly at 15s, rejects until 20s global gap, then opens", () => {
    const first = star(fresh(), "a", 0).stream;
    const edge = star(first, "b", 15_000);
    expect(edge.accepted).toBe(false);
    expect(edge.events[0]?.type).toBe("closed");
    expect(star(edge.stream, "b", 19_999).accepted).toBe(false);
    expect(star(edge.stream, "b", 20_000).stream.stars).toHaveLength(2);
  });
  it("counts stable user IDs once even with cooldown disabled and renamed users", () => {
    const s = star(fresh(), "a", 0).stream;
    const duplicate = command(s, { id: "a", name: "renamed" }, "!star", 1, {
      ...defaults,
      cooldownMs: 0,
    });
    expect(duplicate.accepted).toBe(false);
    expect(totalLighters(duplicate.stream.stars)).toBe(1);
  });
  it("applies 90s cooldown to both new stars and joining; exact boundary accepted", () => {
    let s = star(fresh(), "a", 0).stream;
    s = star(s, "b", 80_000).stream;
    expect(star(s, "a", 89_999).accepted).toBe(false);
    expect(star(s, "a", 90_000).accepted).toBe(true);
    expect(star(fresh(), "a", 0).accepted).toBe(true);
  });
  it("allows eligible joins during the global minimum gap", () => {
    const s = star(fresh(), "a", 0).stream;
    expect(star(s, "b", 10_000).accepted).toBe(true);
  });
  it("sanitizes URLs, mentions, whitespace, controls, blocked phrases and Unicode length", () => {
    expect(
      sanitizeReason(
        "  wow https://bad.test/x @person www.x.io test.com go\n now  ",
      ),
    ).toBe("wow go now");
    expect(sanitizeReason("a BADword z", ["badword"])).toBe("");
    expect(sanitizeReason("ｂａｄ", ["bad"])).toBe("");
    expect(sanitizeReason("😀".repeat(45))).toBe("😀".repeat(40));
    expect(sanitizeReason("")).toBe("");
    expect(sanitizeReason("x".repeat(40) + " banned", ["banned"])).toBe("");
  });
  it("parses commands strictly and allows optional reasons", () => {
    expect(star(fresh(), "a", 0, "!starlight").accepted).toBe(false);
    expect(star(fresh(), "a", 0, "!STAR  hi").stream.stars[0]?.reason).toBe(
      "hi",
    );
  });
  it("formats offsets, clamps invalid values, uses offset instead of close marker position", () => {
    expect(vodTime(6420)).toBe("1h47m0s");
    expect(vodTime(0)).toBe("0h0m0s");
    expect(vodTime(3661.9)).toBe("1h1m1s");
    expect(vodTime(-1)).toBe("0h0m0s");
    expect(vodTime(NaN)).toBe("0h0m0s");
    const s = star(fresh(), "a", 6_420_000).stream;
    expect(momentUrl({ ...s, vodId: "123" }, s.stars[0]!)).toBe(
      "https://www.twitch.tv/videos/123?t=1h47m0s",
    );
    expect(momentUrl(s, { ...s.stars[0]!, clipId: "clip" })).toBe(
      "https://clips.twitch.tv/clip",
    );
    expect(momentUrl(s, s.stars[0]!)).toBeUndefined();
  });
  it("ranks by unique lighters, resolves ties chronologically, never mutates, handles empty", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) {
      s = star(s, `owner${i}`, i * 100_000).stream;
      for (let j = 0; j < i % 3; j++)
        s = star(s, `join${i}${j}`, i * 100_000 + j + 1).stream;
    }
    const before = [...s.stars];
    expect(topThree(s.stars).map((x) => x.owner.id)).toEqual([
      "owner2",
      "owner1",
      "owner4",
    ]);
    expect(s.stars).toEqual(before);
    expect(topThree([])).toEqual([]);
  });
  it("restricts !unstar to mods/broadcaster; retains clocks; permits subsequent new IDs", () => {
    const s = star(fresh(), "a", 0).stream;
    expect(command(s, user("x"), "!unstar", 1, defaults).accepted).toBe(false);
    const removed = command(
      s,
      { ...user("mod"), isMod: true },
      "!unstar",
      1,
      defaults,
    );
    expect(removed.stream.stars).toHaveLength(0);
    expect(removed.events.at(-1)?.type).toBe("removed");
    expect(star(removed.stream, "b", 2).accepted).toBe(false);
    expect(star(removed.stream, "b", 20_000).stream.stars[0]?.id).toBe("s-2");
    expect(
      command(
        s,
        { ...user("host"), isBroadcaster: true },
        "!unstar",
        1,
        defaults,
      ).accepted,
    ).toBe(true);
  });
  it("closes only once, flushes at stream end, caps marker description", () => {
    const s = star(fresh(), "a", 0).stream;
    const closed = closeDue(s, 15_000, defaults);
    expect(closed.events).toHaveLength(1);
    expect(closeDue(closed.stream, 16_000, defaults).events).toHaveLength(0);
    expect(closeDue(s, 1, defaults, true).events).toHaveLength(1);
    expect(markerDescription(s.stars[0]!)).toBe("★ @a +0");
    expect(
      Array.from(
        markerDescription({ ...s.stars[0]!, owner: user("a".repeat(200)) }),
      ).length,
    ).toBe(140);
  });
  it("enforces optional eligibility and ended stream guard", () => {
    expect(
      command(fresh(), user("a"), "!star", 0, { ...defaults, subsOnly: true })
        .accepted,
    ).toBe(false);
    expect(
      command(fresh(), { ...user("a"), isFollower: true }, "!star", 0, {
        ...defaults,
        followersOnly: true,
      }).accepted,
    ).toBe(true);
    expect(star({ ...fresh(), endedAt: 0 }, "a", 1).accepted).toBe(false);
  });
});
