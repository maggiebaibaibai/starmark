import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockTwitch } from "../server/twitch.js";
import { momentUrl } from "../server/engine.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/service-"));
  roots.push(root);
  let time = 1_000_000;
  const twitch = new MockTwitch();
  const service = new Service(
    new Store(root),
    twitch,
    "test",
    () => {},
    () => time,
  );
  await service.init();
  await service.start({ type: "stream.online" });
  return { service, twitch, setTime: (n: number) => (time = n), root };
}
describe("stream lifecycle side effects", () => {
  it("creates one marker, eligible clip, and echo per closed star, even on repeated ticks", async () => {
    const { service, twitch, setTime } = await setup();
    for (const name of ["a", "b", "c"])
      await service.message({ id: name, name }, "!star wow");
    setTime(1_015_000);
    await service.tick();
    await service.tick();
    expect(twitch.calls.map((c) => c.method)).toEqual([
      "createMarker",
      "createClip",
      "sendChat",
    ]);
    expect(service.active!.stars[0]!.offsetSeconds).toBe(0);
    expect(service.active!.stars[0]!.marker?.positionSeconds).toBe(15);
  });
  it("does not create a clip with fewer than three lighters; end flushes an open star", async () => {
    const { service, twitch } = await setup();
    await service.message({ id: "a", name: "a" }, "!star");
    const stream = await service.end();
    expect(stream.stars[0]?.closedAt).toBeDefined();
    expect(twitch.calls.map((c) => c.method)).toEqual([
      "createMarker",
      "sendChat",
      "getArchiveVod",
    ]);
    expect(stream.vodId).toBeDefined();
    expect(service.active).toBeUndefined();
  });
  it("caps clips at 20 while preserving markers, stars and one echo each", async () => {
    const { service, twitch, setTime } = await setup();
    for (let i = 0; i < 22; i++) {
      setTime(1_000_000 + i * 100_000);
      for (let j = 0; j < 3; j++)
        await service.message(
          { id: `u${i}-${j}`, name: `u${i}-${j}` },
          "!star",
        );
      setTime(1_015_000 + i * 100_000);
      await service.tick();
    }
    expect(twitch.calls.filter((c) => c.method === "createClip")).toHaveLength(
      20,
    );
    expect(
      twitch.calls.filter((c) => c.method === "createMarker"),
    ).toHaveLength(22);
    expect(twitch.calls.filter((c) => c.method === "sendChat")).toHaveLength(
      22,
    );
  });
  it("keeps original offsets and uses clip links when VOD saving is off", async () => {
    const { service, twitch } = await setup();
    twitch.vodSaving = false;
    for (const name of ["a", "b", "c"])
      await service.message({ id: name, name }, "!star");
    const stream = await service.end();
    expect(stream.warnings.join(" ")).toContain("Store past broadcasts");
    expect(stream.vodId).toBeUndefined();
    expect(momentUrl(stream, stream.stars[0]!)).toContain(
      "https://clips.twitch.tv/mock-clip-",
    );
    expect(stream.stars[0]?.offsetSeconds).toBe(0);
  });
  it("deduplicates EventSub IDs, survives restart, and does not repeat completed effects", async () => {
    const { service, twitch, setTime, root } = await setup();
    await service.message({ id: "a", name: "a" }, "!star", "same-id");
    await service.message({ id: "b", name: "b" }, "!star", "same-id");
    expect(service.active!.stars[0]!.lighters).toHaveLength(1);
    setTime(1_015_000);
    await service.tick();
    const restored = new Service(
      new Store(root),
      twitch,
      "test",
      () => {},
      () => 1_020_000,
    );
    await restored.init();
    await restored.tick();
    expect(restored.active!.stars).toHaveLength(1);
    expect(
      twitch.calls.filter((c) => c.method === "createMarker"),
    ).toHaveLength(1);
  });
  it("removing an open star prevents its pending marker and clip", async () => {
    const { service, twitch } = await setup();
    await service.message({ id: "a", name: "a" }, "!star");
    await service.message({ id: "mod", name: "mod", isMod: true }, "!unstar");
    await service.end();
    expect(twitch.calls.map((c) => c.method)).toEqual(["getArchiveVod"]);
  });
});
