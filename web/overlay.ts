import {
  $,
  esc,
  fitStage,
  starPath,
  svgStar,
  topThree,
  withLine,
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
    cy = bounded("y", 330, 0, 1000),
    cw = bounded("width", 380, 120, 1920 - cx);
  const layouts: Record<string, Layout> = {
    bottom: {
      L: 120,
      R: 1800,
      Y: 1046,
      up: -1,
      head: [120, 1000],
      ex: [1800, 1000],
      burstY: 780,
    },
    top: {
      L: 120,
      R: 1420,
      Y: 40,
      up: 1,
      head: [120, 62],
      ex: [1420, 62],
      burstY: 330,
    },
    compact: {
      L: cx,
      R: cx + cw,
      Y: cy,
      up: 1,
      head: [cx, cy + 16],
      ex: [cx + cw, cy + 58],
      burstY: Math.min(800, cy + 270),
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
    burstTimer: ReturnType<typeof setTimeout> | undefined,
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
      .filter((s) => s.id !== active && !queue.includes(s.id))
      .map(
        (s) =>
          `<div class="st ${now() - s.openedAt < 6000 ? "labeled" : ""}" style="left:${x(s.offsetSeconds)}px;top:${lay.Y - lay.up * (10 + hash(s.owner.name) * 22)}px"><svg width="40" height="40" viewBox="-20 -20 40 40"><path class="tw" fill="${top.includes(s.id) ? "var(--gold)" : "var(--star)"}" d="${starPath(Math.min(18, 4 + Math.sqrt(s.lighters.length) * 1.6))}"/></svg><div class="tag">@${esc(s.owner.name)}</div></div>`,
      )
      .join("");
  }
  function updateBurst() {
    const s = state?.active?.stars.find((s) => s.id === active),
      b = $("bursts").firstElementChild;
    if (!s || !b) return;
    const join = b.querySelector(".j")!;
    join.textContent = withLine(s);
    const reason = b.querySelector<HTMLElement>(".r");
    if (reason) reason.hidden = !showReasons();
  }
  function pump() {
    if (active || !queue.length) return;
    active = queue.shift();
    const s = state?.active?.stars.find((s) => s.id === active);
    if (!s) {
      active = undefined;
      pump();
      return;
    }
    const bx =
      pos === "compact"
        ? Math.max(420, Math.min(1500, lay.L + (lay.R - lay.L) / 2))
        : Math.max(420, Math.min(1500, x(s.offsetSeconds)));
    $("bursts").innerHTML =
      `<div class="burst" style="left:${bx}px;top:${lay.burstY}px"><div class="halo"></div><span class="ring"></span>${svgStar()}<div class="u">@${esc(s.owner.name)}</div><div class="r" ${showReasons() ? "" : "hidden"}>${esc(s.reason)}</div><div class="j"></div></div>`;
    updateBurst();
    renderBand();
    burstTimer = setTimeout(() => {
      const b = $("bursts").firstElementChild as HTMLElement | null;
      if (b) b.style.opacity = "0";
      burstTimer = setTimeout(() => {
        active = undefined;
        $("bursts").replaceChildren();
        renderBand();
        $("ex").textContent =
          `try: !star ${["that dodge", "best song tonight", "the cat is back", "gg"][examples++ % 4]}`;
        $("ex").style.opacity = "1";
        clearTimeout(exampleTimer);
        exampleTimer = setTimeout(() => ($("ex").style.opacity = "0"), 5000);
        pump();
      }, 250);
    }, 2250);
  }
  function update(next: Snapshot, events: { type: string; star: Star }[] = []) {
    const first = !state;
    state = next;
    received = Date.now();
    if (streamId !== next.active?.id) {
      streamId = next.active?.id;
      seen = new Set(next.active?.stars.map((s) => s.id));
      queue = [];
      active = undefined;
      clearTimeout(burstTimer);
      clearTimeout(exampleTimer);
      $("bursts").replaceChildren();
      $("ex").style.opacity = "0";
    }
    for (const event of events)
      if (event.type === "opened" && !seen.has(event.star.id)) {
        seen.add(event.star.id);
        if ((active ? 1 : 0) + queue.length < 2) queue.push(event.star.id);
      }
    if (first) for (const star of next.active?.stars ?? []) seen.add(star.id);
    queue = queue.filter((id) => next.active?.stars.some((s) => s.id === id));
    if (active && !next.active?.stars.some((s) => s.id === active)) {
      clearTimeout(burstTimer);
      active = undefined;
      $("bursts").replaceChildren();
    }
    renderBand();
    updateBurst();
    pump();
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
  setInterval(renderBand, 1000);
  return {
    update,
    chat: (line: import("./visuals.js").ChatLine) => {
      if (state) state.messages = [...state.messages, line].slice(-40);
    },
  };
}
