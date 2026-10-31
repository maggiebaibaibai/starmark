import { advanceIgnition, ignitionGrowth, ignitionPhase, isOpen } from "./ignition.js";
import {
  $,
  esc,
  fitStage,
  starPath,
  svgStar,
  topThree,
  type Snapshot,
  type Star,
} from "./visuals.js";
interface Layout {
  L: number;
  R: number;
  Y: number;
  up: number;
  head: number[];
  ex: number[] | null;
  burstY: number;
}
export function overlayPage() {
  document.body.className = "overlay-page";
  $("app").innerHTML =
    `<div id="live" class="stage"><canvas id="aurora" width="1920" height="1080"></canvas><div class="axis" id="axis"></div><div class="head" id="head">TONIGHT'S SKY · <b id="cnt">0</b> ★</div><div class="ex" id="ex" style="opacity:0"></div><div id="stars"></div><div class="play" id="play"></div><div id="bursts"></div></div>`;
  fitStage($("live"), 1920, 1080);
  const params = new URLSearchParams(location.search),
    pos = params.get("pos") || "bottom";
  const bounded = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const cx = bounded("x", 1480, 0, 1800),
    requestedY = bounded("y", 330, 0, 1000),
    // Compact sources stay below the reserved webcam even with custom x/y.
    cy = cx < 400 ? Math.max(260, requestedY) : requestedY,
    cw = bounded("width", 380, 120, 1920 - cx);
  const layouts: Record<string, Layout> = {
    bottom: {
      L: 120,
      R: 1800,
      Y: 1046,
      up: -1,
      head: [120, 1000],
      ex: [1800, 1000],
      burstY: 690,
    },
    top: {
      L: 120,
      R: 1420,
      Y: 40,
      up: 1,
      head: [120, 62],
      ex: [1420, 62],
      burstY: 400,
    },
    compact: {
      L: cx,
      R: cx + cw,
      Y: cy,
      up: 1,
      head: [cx, cy + 16],
      ex: [cx + cw, cy + 58],
      burstY: Math.max(620, Math.min(790, cy + 270)),
    },
  };
  const lay = layouts[pos] ?? layouts.bottom!;
  const accent = params.get("accent")?.replace(/^#/, "");
  if (accent && /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent))
    document.documentElement.style.setProperty("--gold", "#" + accent);
  const auroraOn = params.has("aurora")
    ? params.get("aurora") !== "0"
    : pos === "bottom";
  $("axis").style.cssText =
    `left:${lay.L}px;width:${lay.R - lay.L}px;top:${lay.Y}px`;
  $("head").style.cssText =
    `left:${lay.head[0]}px;top:${lay.head[1]}px;${pos === "bottom" ? "transform:translateY(-100%)" : ""}`;
  if (lay.ex)
    $("ex").style.cssText =
      `left:${lay.ex[0]}px;top:${lay.ex[1]}px;opacity:0;transform:${pos === "bottom" ? "translate(-100%,-100%)" : "translateX(-100%)"};${pos === "compact" ? "font-size:14px" : ""}`;
  if (pos === "compact") $("head").style.fontSize = "14px";
  let state: Snapshot | undefined,
    received = Date.now(),
    seen = new Set<string>(),
    streamId: string | undefined,
    active: string | undefined,
    queue: string[] = [],
    fading: { id: string; until: number } | undefined,
    exampleTimer: ReturnType<typeof setTimeout> | undefined,
    examples = 0;
  const now = () => (state ? state.now + (Date.now() - received) : Date.now());
  const duration = () =>
    Math.max(1, (now() - (state?.active?.startedAt ?? now())) / 1000);
  const x = (seconds: number) =>
    lay.L + (lay.R - lay.L) * Math.min(1, seconds / duration());
  const hash = (s: string) => {
    let h = 2166136261;
    for (const c of s) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  };
  const showReasons = () =>
    params.has("reasons")
      ? params.get("reasons") !== "0"
      : !state?.settings.namesOnly &&
        !(
          state?.mode !== "mock" &&
          (state?.active?.viewerCount ?? 0) >=
            (state?.settings.namesOnlyThreshold ?? 500)
        );
  function renderBand() {
    const stars = state?.active?.stars ?? [],
      top = topThree(stars).map((s) => s.id);
    $("cnt").textContent = String(stars.length);
    $("play").style.cssText =
      `left:${state?.active ? lay.R : lay.L}px;top:${lay.Y}px`;
    $("stars").innerHTML = stars
      .filter((s) => s.id !== active && s.id !== fading?.id && !queue.includes(s.id))
      .map(
        (s) =>
          `<div data-star-id="${esc(s.id)}" class="st ${now() - s.openedAt < 6000 ? "labeled" : ""}" style="left:${x(s.offsetSeconds)}px;top:${lay.Y - lay.up * (10 + hash(s.owner.name) * 22)}px"><svg width="40" height="40" viewBox="-20 -20 40 40"><path class="tw" fill="${top.includes(s.id) ? "var(--gold)" : "var(--star)"}" d="${starPath(Math.min(18, 4 + Math.sqrt(s.lighters.length) * 1.6))}"/></svg><div class="tag">@${esc(s.owner.name)}</div></div>`,
      )
      .join("");
  }
  function updateBurst() {
    const s = state?.active?.stars.find((s) => s.id === active),
      b = $("bursts").querySelector<HTMLElement>(".burst:not(.settling)");
    if (!s || !b) return;
    if (b.dataset.phase !== "open") b.dataset.phase = ignitionPhase(s, now());
    b.style.setProperty("--growth", String(ignitionGrowth(s.lighters.length)));
    const join = b.querySelector<HTMLElement>(".j")!;
    const joiners = s.lighters.slice(1, 4);
    join.querySelector<HTMLElement>(".join-prefix")!.hidden = !joiners.length;
    for (const chip of join.querySelectorAll<HTMLElement>("[data-user-id]")) {
      if (!joiners.some((user) => user.id === chip.dataset.userId)) chip.remove();
    }
    for (const user of joiners) {
      if (Array.from(join.children).some((chip) => (chip as HTMLElement).dataset.userId === user.id)) continue;
      const chip = document.createElement("span");
      chip.className = "join-chip";
      chip.dataset.userId = user.id;
      chip.textContent = "@" + user.name + " ";
      join.append(chip);
    }
    const extra = Math.max(0, s.lighters.length - 4);
    const previous = join.querySelector(".join-extra");
    if (previous?.textContent !== (extra ? `+${extra}` : undefined)) {
      previous?.remove();
      if (extra) {
        const chip = document.createElement("span");
        chip.className = "join-chip join-extra";
        chip.textContent = `+${extra}`;
        join.append(chip);
      }
    }
    const reason = b.querySelector<HTMLElement>(".r");
    if (reason) reason.hidden = !showReasons();
  }
  function showBurst(s: Star) {
    const bx =
      pos === "compact"
        ? Math.max(450, Math.min(1470, lay.L + (lay.R - lay.L) / 2))
        : Math.max(450, Math.min(1470, x(s.offsetSeconds)));
    const b = document.createElement("div");
    b.className = "burst";
    b.dataset.starId = s.id;
    b.style.cssText = `left:${bx}px;top:${lay.burstY}px`;
    b.innerHTML = `<div class="halo"></div><span class="ring"></span><div class="glyph-slot"><div class="glyph-open"><div class="glyph-growth">${svgStar(140, 320)}</div></div></div><div class="u">@${esc(s.owner.name)}</div><div class="r" ${showReasons() ? "" : "hidden"}>${esc(s.reason)}</div><div class="j"><span class="join-prefix" hidden>with </span></div>`;
    $("bursts").append(b);
    updateBurst();
  }
  function showExample() {
    $("ex").textContent =
      `try: !star ${["that dodge", "best song tonight", "the cat is back", "gg"][examples++ % 4]}`;
    $("ex").style.opacity = "1";
    clearTimeout(exampleTimer);
    exampleTimer = setTimeout(() => ($("ex").style.opacity = "0"), 5000);
  }
  function syncIgnition(opened: string[] = []) {
    const stars = state?.active?.stars ?? [];
    const previous = active;
    const next = advanceIgnition({ active, queue }, stars, now(), state?.settings.mergeMs ?? 15000, opened);
    active = next.active;
    queue = next.queue;
    if (previous && previous !== active) {
      // Fade for 250 ms as before, but release the queue immediately. A queued
      // star only gets its remaining open time, never a fresh 15-second timer.
      $("bursts").querySelector(".settling")?.remove();
      const b = $("bursts").querySelector<HTMLElement>(".burst");
      if (b) {
        b.classList.add("settling");
        b.dataset.phase = "settling";
        fading = { id: previous, until: Date.now() + 250 };
      }
    }
    if (fading && Date.now() >= fading.until) {
      $("bursts").querySelector(".settling")?.remove();
      fading = undefined;
      showExample();
      renderBand();
    }
    if (active && active !== previous) showBurst(stars.find((s) => s.id === active)!);
    updateBurst();
    if (active !== previous) renderBand();
  }
  function update(next: Snapshot, events: { type: string; star: Star }[] = []) {
    state = next;
    received = Date.now();
    const opened: string[] = [];
    if (streamId !== next.active?.id) {
      streamId = next.active?.id;
      seen = new Set(next.active?.stars.map((s) => s.id));
      queue = [];
      active = undefined;
      fading = undefined;
      clearTimeout(exampleTimer);
      $("bursts").replaceChildren();
      $("ex").style.opacity = "0";
      // Connecting midway through a window still shows its remaining open time.
      opened.push(...(next.active?.stars ?? [])
        .filter((s) => isOpen(s, next.now, next.settings.mergeMs)).map((s) => s.id));
    }
    for (const event of events) {
      if (event.type === "opened" && !seen.has(event.star.id)) {
        seen.add(event.star.id);
        opened.push(event.star.id);
      }
    }
    syncIgnition(opened);
    renderBand();
  }
  const ag = $<HTMLCanvasElement>("aurora").getContext("2d")!;
  function animate(ts: number) {
    ag.clearRect(0, 0, 1920, 1080);
    if (auroraOn && state?.active) {
      const speed = Math.min(
          1,
          state.messages.filter(
            (m) => m.kind === "viewer" && now() - m.at < 15000,
          ).length / 12,
        ),
        dir = pos === "bottom" ? -1 : 1,
        H = pos === "compact" ? 40 : 70;
      ag.save();
      ag.filter = "blur(10px)";
      ag.globalCompositeOperation = "lighter";
      for (const [c, phase, k] of [
        ["95,224,200", 0, 1],
        ["143,125,255", 2.1, 0.75],
      ] as const) {
        ag.beginPath();
        ag.moveTo(lay.L, lay.Y);
        for (let px = lay.L; px <= lay.R; px += 8) {
          const h =
            (0.15 + speed * 0.75) *
            H *
            k *
            (1 + 0.18 * Math.sin(px / 53 + ts / 800 + phase));
          ag.lineTo(px, lay.Y + dir * h);
        }
        ag.lineTo(lay.R, lay.Y);
        ag.closePath();
        const gr = ag.createLinearGradient(0, lay.Y, 0, lay.Y + dir * H);
        gr.addColorStop(0, `rgba(${c},.55)`);
        gr.addColorStop(1, `rgba(${c},0)`);
        ag.fillStyle = gr;
        ag.fill();
      }
      ag.restore();
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  // Deadline fallback also works when no more state messages arrive.
  setInterval(syncIgnition, 50);
  setInterval(renderBand, 1000);
  return {
    update,
    chat: (line: import("./visuals.js").ChatLine) => {
      if (state) state.messages = [...state.messages, line].slice(-40);
    },
  };
}
