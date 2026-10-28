import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockTwitch } from "../server/twitch.js";
import { momentUrl } from "../server/engine.js";
const roots: string[] = [];
const services: Service[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.restoreAllMocks();
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
  services.push(service);
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
    await service.waitForDelivery();
    await service.tick();
    await service.waitForDelivery();
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
      await service.waitForDelivery();
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
    await service.waitForDelivery();
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

describe("chat throughput and delivery scheduling", () => {
  it("publishes 1,000 plain chat lines with zero stream writes, state writes or scans", async () => {
    const { service } = await setup();
    await service.message({ id: "owner", name: "owner" }, "!star");
    await service.waitForDelivery();
    const save = vi.spyOn(service.store, "saveStream");
    const stateSave = vi.spyOn(service.store, "saveState");
    const scan = vi.spyOn(service.store, "streams");
    const publish = vi.spyOn(service, "publish");
    for (let i = 0; i < 1000; i++)
      await service.message({ id: "viewer", name: "viewer" }, `hello ${i}`);
    expect(save).not.toHaveBeenCalled();
    expect(stateSave).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1000);
    expect(
      publish.mock.calls.every(
        ([event]) =>
          Object.keys(event).sort().join() === "line,type" &&
          (event as { type: string }).type === "chat",
      ),
    ).toBe(true);
    expect(service.messages).toHaveLength(40);
  });
  it("caches stream history until any store.saveStream succeeds", async () => {
    const { service } = await setup();
    const scan = vi.spyOn(service.store, "streams");
    await service.snapshot();
    await service.snapshot();
    expect(scan).not.toHaveBeenCalled();
    await service.store.saveStream({ ...service.active!, title: "updated" });
    expect((await service.snapshot()).streams[0]?.title).toBe("updated");
    await service.snapshot();
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it("rejected commands without events publish only a chat line", async () => {
    const { service } = await setup();
    await service.message({ id: "a", name: "a" }, "!star");
    await service.waitForDelivery();
    const save = vi.spyOn(service.store, "saveStream"),
      publish = vi.spyOn(service, "publish");
    expect(
      (await service.message({ id: "a", name: "a" }, "!star")).accepted,
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat" }),
    );
  });
  it("notifies before slow delivery; a queued join uses arrival time within the 15s window", async () => {
    const { service, twitch, setTime } = await setup();
    let releaseMarker!: () => void;
    const blockedMarker = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const realMarker = twitch.createMarker.bind(twitch);
    const notifications: object[] = [];
    vi.spyOn(service, "publish").mockImplementation((e) =>
      notifications.push(structuredClone(e)),
    );
    vi.spyOn(twitch, "createMarker").mockImplementation(async (...args) => {
      expect(notifications).toContainEqual(
        expect.objectContaining({
          type: "state",
          events: expect.arrayContaining([
            expect.objectContaining({ type: "closed" }),
          ]),
        }),
      );
      await blockedMarker;
      return realMarker(...args);
    });
    try {
      await service.message({ id: "first", name: "first" }, "!star");
      setTime(1_015_000);
      await service.tick();
      await vi.waitFor(() =>
        expect(twitch.createMarker).toHaveBeenCalledTimes(1),
      );
      setTime(1_020_000);
      await service.message({ id: "owner", name: "owner" }, "!star second");
      let releaseQueue!: () => void;
      const blockedQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const held = service.run(() => blockedQueue);
      setTime(1_034_999);
      const joined = service.message(
        { id: "join", name: "join" },
        "!star",
        "queued",
        service.now(),
      );
      setTime(1_036_000);
      releaseQueue();
      await held;
      expect((await joined).accepted).toBe(true);
      expect(service.active!.stars[1]!.lighters.map((u) => u.id)).toEqual([
        "owner",
        "join",
      ]);
      expect(service.active!.stars[0]!.delivery).toBe("processing");
      // Concurrent close checks must not acquire the same processing star twice.
      await service.tick();
      await service.tick();
      expect(twitch.createMarker).toHaveBeenCalledTimes(1);
    } finally {
      releaseMarker();
      await service.waitForDelivery();
    }
    expect(
      twitch.calls.filter((c) => c.method === "createMarker"),
    ).toHaveLength(2);
    expect(service.active!.stars[1]!.lighters).toHaveLength(2);
  });
  it("background completion cannot resurrect a star removed while its marker is in flight", async () => {
    const { service, twitch, setTime } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r)),
      real = twitch.createMarker.bind(twitch);
    vi.spyOn(twitch, "createMarker").mockImplementation(async (...args) => {
      await blocked;
      return real(...args);
    });
    try {
      for (const name of ["a", "b", "c"])
        await service.message({ id: name, name }, "!star");
      setTime(1_015_000);
      await service.tick();
      await vi.waitFor(() => expect(twitch.createMarker).toHaveBeenCalled());
      await service.removeStar(service.active!.stars[0]!.id);
    } finally {
      release();
      await service.waitForDelivery();
    }
    expect(service.active!.stars).toEqual([]);
    expect(twitch.calls.map((c) => c.method)).toEqual(["createMarker"]);
  });
  it("uses the same inclusive lighter total in marker and echo", async () => {
    const { service, twitch } = await setup();
    for (const name of ["a", "b", "c"])
      await service.message({ id: name, name }, "!star wow");
    await service.end();
    expect(twitch.calls.find((c) => c.method === "createMarker")?.text).toBe(
      "★ @a +2: wow",
    );
    expect(twitch.calls.find((c) => c.method === "sendChat")?.text).toBe(
      "⭐ @a lit a star at 0:00:00 · 3 of you",
    );
  });
  it("processes an already queued join before offline closes the window", async () => {
    const { service, setTime } = await setup();
    await service.message({ id: "a", name: "a" }, "!star");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = service.run(() => gate);
    setTime(1_014_999);
    const join = service.message({ id: "b", name: "b" }, "!star");
    const ended = service.end();
    release();
    await held;
    expect((await join).accepted).toBe(true);
    expect((await ended).stars[0]!.lighters).toHaveLength(2);
  });
});

it.each(["lock", "marker", "echo"])("resumes a failed %s checkpoint on the next successful write without replaying effects", async (stage) => {
  const { service, twitch, setTime } = await setup();
  for (const name of ["a", "b", "c"]) await service.message({ id: name, name }, "!star");
  const original = service.store.saveStream.bind(service.store);
  let failed = false;
  const spy = vi.spyOn(service.store, "saveStream").mockImplementation(async (stream) => {
    const star = stream.stars[0]!;
    const hit = stage === "lock" ? star.delivery === "processing" : stage === "marker" ? !!star.marker : star.delivery === "done";
    if (!failed && hit) { failed = true; throw new Error("private storage path"); }
    return original(stream);
  });
  setTime(1_015_000);
  await service.tick();
  await expect(service.waitForDelivery()).rejects.toThrow("could not be saved");
  expect((await service.snapshot()).deliveryWarning).toContain("next successful write");
  spy.mockRestore();
  await service.settings(service.state.settings);
  await service.waitForDelivery();
  expect((await service.snapshot()).deliveryWarning).toBeUndefined();
  expect(twitch.calls.map((c) => c.method)).toEqual(["createMarker", "createClip", "sendChat"]);
  expect((await service.store.stream(service.active!.id))!.stars[0]!.delivery).toBe("done");
});
