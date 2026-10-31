import { layoutCardLabels, publicCardAddress, type Box } from "./card-layout.js";
import {
  $,
  api,
  clockTime,
  curve,
  dust,
  esc,
  fitStage,
  mk,
  momentUrl,
  starPath,
  topThree,
  totalLighters,
  withLine,
  type Stream,
} from "./visuals.js";
export async function cardPage(id: string) {
  document.body.className = "card-page";
  const stream = await api<
    Stream & { durationSeconds: number; cardUrl: string }
  >(`/api/streams/${encodeURIComponent(id)}`);
  const length = Math.max(1, stream.durationSeconds),
    stars = stream.stars,
    top = topThree(stars),
    max = Math.max(1, ...stars.map((s) => s.lighters.length));
  const title = stream.title.trim();
  const address = publicCardAddress(stream.cardUrl);
  $("app").innerHTML =
    `<div id="card" class="stage"><canvas id="cardDust" width="1080" height="1350"></canvas><div class="ch"><div class="k">STARMAP · TWITCH.TV/${esc(stream.channel.toUpperCase())}</div><div class="h">Last night you lit<br><i>${stars.length} ${stars.length === 1 ? "star" : "stars"}</i></div><div class="m">${esc(new Date(stream.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))} · ${Math.floor(length / 3600)}h ${Math.floor((length % 3600) / 60)}m live · ${totalLighters(stars)} of you lit them${title ? `<br>“${esc(title)}”` : ""}</div></div><svg id="cardSvg" width="1080" height="1350" aria-label="Starmap: time across, lighters up"></svg><div class="cf"><div class="a">Every star opens its moment<small>twitch.tv/${esc(stream.channel)}</small>${address ? `<small class="card-address">${esc(address)}</small>` : ""}</div><div class="b">starmark</div></div><div class="tip" id="tip"><div class="t1"></div><div class="t2"></div><div class="t3"></div><div class="t4"></div></div></div>`;
  fitStage($("card"), 1080, 1350, true);
  await document.fonts.ready;
  dust($<HTMLCanvasElement>("cardDust"), 460, 11);
  const svg = $("cardSvg"),
    defs = mk("defs", {}, svg),
    rg = mk("radialGradient", { id: "glow" }, defs);
  mk("stop", { offset: 0, "stop-color": "rgba(255,210,122,.38)" }, rg);
  mk("stop", { offset: 1, "stop-color": "rgba(255,210,122,0)" }, rg);
  const x = (t: number) => 130 + 820 * Math.min(1, t / length),
    y = (n: number) => 1060 - (n / max) * 500;
  mk(
    "path",
    {
      d: curve(stars.map((s) => [x(s.offsetSeconds), y(s.lighters.length)])),
      fill: "none",
      stroke: "rgba(255,214,140,.22)",
      "stroke-width": 1.6,
      "stroke-dasharray": "2 8",
    },
    svg,
  );
  mk(
    "line",
    { x1: 130, x2: 950, y1: 1110, y2: 1110, stroke: "rgba(255,246,220,.16)" },
    svg,
  );
  const step =
    [
      1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400,
      28800, 86400,
    ].find((n) => n >= length / 3) ?? Math.ceil(length / 3);
  const ticks = [0];
  for (let t = step; t < length; t += step)
    if (length - t > step * 0.2) ticks.push(t);
  ticks.push(length);
  for (const t of ticks)
    mk(
      "text",
      { x: x(t), y: 1146, "text-anchor": "middle", class: "ax" },
      svg,
    ).textContent =
      length < 3600
        ? clockTime(t).slice(2)
        : `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`;
  mk("text", { x: 84, y: 560, class: "ax" }, svg).textContent = "more of you ↑";
  if (!stars.length)
    mk(
      "text",
      { x: 540, y: 820, "text-anchor": "middle", class: "cr" },
      svg,
    ).textContent = "An empty sky. A new beginning.";
  const ordered = [...top, ...stars.filter((s) => !top.includes(s))];
  const labels: {
    group: SVGGElement;
    parent: SVGAElement;
    glyph: SVGPathElement;
    cx: number;
    cy: number;
    isTop: boolean;
  }[] = [];
  for (const s of ordered) {
    const rank = top.indexOf(s),
      isTop = rank >= 0,
      cx = x(s.offsetSeconds),
      cy = y(s.lighters.length),
      size = Math.min(34, 8 + Math.sqrt(s.lighters.length) * 4.2);
    const link = momentUrl(stream, s),
      g = mk(
        "a",
        {
          class: "cs",
          transform: `translate(${cx},${cy})`,
          tabindex: 0,
          "aria-label": `${clockTime(s.offsetSeconds)}, ${s.owner.name}, ${s.lighters.length} lighters, ${s.reason}${link ? "" : ", no recording available"}`,
          ...(link
            ? { href: link, target: "_blank", rel: "noopener noreferrer" }
            : {}),
        },
        svg,
      );
    if (isTop) mk("circle", { r: size * 2.8, fill: "url(#glow)" }, g);
    const glyph = mk(
      "path",
      {
        class: "card-glyph",
        "data-star-id": s.id,
        d: starPath(isTop ? size * 1.25 : size),
        fill: isTop ? "var(--gold)" : "var(--star)",
      },
      g,
    );
    mk("circle", { r: 45, fill: "transparent" }, g);
    // The badge travels with its label, rather than floating over nearby stars.
    const label = mk("g", { class: "card-label", "data-star-id": s.id }, g);
    const textX = isTop ? 46 : 0;
    if (isTop) {
      mk("circle", { cx: 17, cy: -7, r: 17, fill: "var(--gold)" }, label);
      mk("text", { x: 17, y: 0, "text-anchor": "middle", class: "rk" }, label)
        .textContent = String(rank + 1);
    }
    mk("text", { x: textX, y: 0, class: "cl" + (isTop ? " top" : "") }, label)
      .textContent = `${clockTime(s.offsetSeconds)}  @${s.owner.name}`;
    if (isTop) {
      mk("text", { x: textX, y: 38, class: "cr" }, label)
        .textContent = s.reason || "this moment";
      mk("text", { x: textX, y: 66, class: "cj" }, label)
        .textContent = s.lighters.length > 1 ? "with " + withLine(s) : "lit by @" + s.owner.name;
    } else if (/[^\x00-\x7f]/.test(s.reason)) {
      const reason = mk("text", { x: textX, y: 31, class: "cr" }, label);
      reason.style.fill = "rgba(255,246,220,.8)";
      reason.style.fontSize = "26px";
      reason.textContent = s.reason;
    }
    labels.push({ group: label, parent: g, glyph, cx, cy, isTop });
    const show = () => {
      const tip = $("tip");
      tip.innerHTML = `<div class="t1">${clockTime(s.offsetSeconds)} · ${s.lighters.length} of you</div><div class="t2">@${esc(s.owner.name)}</div><div class="t3">${esc(s.reason)}</div><div class="t4">${link ? "↗ Open this moment" + (stream.mock ? " · mock link" : "") : "No recording · timestamp saved"}</div>`;
      tip.style.left = `${Math.min(660, Math.max(20, cx - 180))}px`;
      tip.style.top = `${cy > 640 ? cy - 220 : cy + 50}px`;
      tip.classList.add("on");
    };
    g.addEventListener("mouseenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("mouseleave", () => $("tip").classList.remove("on"));
    g.addEventListener("blur", () => $("tip").classList.remove("on"));
  }
  // SVG-only fonts may load after the header. Measure only once all label fonts
  // are ready, in SVG units so responsive cards and PNG exports share positions.
  for (const label of labels) label.group.getBBox();
  await document.fonts.ready;
  const box = (rect: DOMRect, dx = 0, dy = 0): Box => ({
    left: rect.x + dx, top: rect.y + dy,
    right: rect.x + rect.width + dx, bottom: rect.y + rect.height + dy,
  });
  const glyphs = labels.map((label) => box(label.glyph.getBBox(), label.cx, label.cy));
  for (const label of labels) {
    for (const text of label.group.querySelectorAll("text:not(.rk)")) {
      const element = text as SVGTextElement;
      const width = label.isTop ? 330 : 260;
      if (element.getComputedTextLength() > width) {
        element.setAttribute("textLength", String(width));
        element.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
  }
  const bounds = labels.map((label) => label.group.getBBox());
  const { positions, scale } = layoutCardLabels(labels.map((label, i) => ({
    width: bounds[i]!.width, height: bounds[i]!.height,
    topOffset: (label.isTop ? -14 : 7) + bounds[i]!.y,
    cy: label.cy, glyph: glyphs[i]!,
  })), [...glyphs, ...Array.from(svg.querySelectorAll<SVGTextElement>(".ax"),
    (axis) => box(axis.getBBox()))]);
  labels.forEach((label, i) => {
    const target = positions[i]!, boundsAt = bounds[i]!;
    label.group.setAttribute("transform", `translate(${target.left - boundsAt.x * scale - label.cx},${target.top - boundsAt.y * scale - label.cy}) scale(${scale})`);
    const nearestX = Math.max(target.left, Math.min(target.right, label.cx));
    const nearestY = Math.max(target.top, Math.min(target.bottom, label.cy));
    if (Math.abs(nearestY - label.cy) > 35) {
      const leader = mk("line", {
        x1: 0, y1: 0, x2: nearestX - label.cx, y2: nearestY - label.cy,
        stroke: "rgba(255,246,220,.18)", "pointer-events": "none",
      }, label.parent);
      label.parent.prepend(leader);
    }
  });
  document.documentElement.dataset.ready = "true";
}
