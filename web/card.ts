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
  $("app").innerHTML =
    `<div id="card" class="stage"><canvas id="cardDust" width="1080" height="1350"></canvas><div class="ch"><div class="k">STARMAP · TWITCH.TV/${esc(stream.channel.toUpperCase())}</div><div class="h">Last night you lit<br><i>${stars.length} ${stars.length === 1 ? "star" : "stars"}</i></div><div class="m">${esc(new Date(stream.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))} · ${Math.floor(length / 3600)}h ${Math.floor((length % 3600) / 60)}m live · ${totalLighters(stars)} of you lit them<br>“${esc(stream.title)}”</div></div><svg id="cardSvg" width="1080" height="1350" aria-label="Starmap: time across, lighters up"></svg><div class="cf"><div class="a">Every star opens its moment<small>twitch.tv/${esc(stream.channel)}</small><small class="card-address">${esc(stream.cardUrl)}</small></div><div class="b">starmark</div></div><div class="tip" id="tip"><div class="t1"></div><div class="t2"></div><div class="t3"></div><div class="t4"></div></div></div>`;
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
  // Labels keep their approved visual hierarchy; reserve rows to avoid collisions.
  const occupied: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }[] = [];
  const ordered = [...top, ...stars.filter((s) => !top.includes(s))];
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
    mk(
      "path",
      {
        d: starPath(isTop ? size * 1.25 : size),
        fill: isTop ? "var(--gold)" : "var(--star)",
      },
      g,
    );
    mk("circle", { r: 45, fill: "transparent" }, g);
    const height = isTop ? 100 : /[^\x00-\x7f]/.test(s.reason) ? 65 : 30;
    const width = isTop ? 330 : 260;
    let left = cx > 760,
      lx = left ? -(size + 18) : size + 18,
      anchor = left ? "end" : "start";
    let boxLeft = left ? cx + lx - width : cx + lx,
      labelY = cy + (isTop ? -14 : 7);
    const collision = (bx: number, by: number) =>
      occupied.find(
        (b) =>
          bx < b.right &&
          bx + width > b.left &&
          by - 25 < b.bottom &&
          by + height - 25 > b.top,
      );
    if (collision(boxLeft, labelY) || boxLeft < 40 || boxLeft + width > 1060) {
      const alt = left ? cx + size + 18 : cx - size - 18 - width;
      if (alt >= 40 && alt + width <= 1060 && !collision(alt, labelY)) {
        left = !left;
        lx = left ? -(size + 18) : size + 18;
        anchor = left ? "end" : "start";
        boxLeft = alt;
      }
    }
    for (let n = 0; n < 16; n++) {
      const conflict = collision(boxLeft, labelY);
      if (!conflict) break;
      labelY = conflict.bottom + 30;
      if (labelY + height > 1090) labelY = 540 + n * 28;
    }
    occupied.push({
      left: boxLeft,
      right: boxLeft + width,
      top: labelY - 25,
      bottom: labelY + height - 25,
    });
    if (Math.abs(labelY - cy) > 50)
      mk(
        "line",
        {
          x1: 0,
          y1: 0,
          x2: lx,
          y2: labelY - cy,
          stroke: "rgba(255,246,220,.18)",
        },
        g,
      );
    if (isTop) {
      const bx = left ? size + 20 : -(size + 20);
      mk("circle", { cx: bx, cy: -size - 6, r: 17, fill: "var(--gold)" }, g);
      mk(
        "text",
        { x: bx, y: -size + 1, "text-anchor": "middle", class: "rk" },
        g,
      ).textContent = String(rank + 1);
    }
    const text = mk(
      "text",
      {
        x: lx,
        y: labelY - cy,
        "text-anchor": anchor,
        class: "cl" + (isTop ? " top" : ""),
      },
      g,
    );
    text.textContent = `${clockTime(s.offsetSeconds)}  @${s.owner.name}`;
    if (text.getComputedTextLength() > width) {
      text.setAttribute("textLength", String(width));
      text.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
    if (isTop) {
      const reason = mk(
        "text",
        { x: lx, y: labelY - cy + 38, "text-anchor": anchor, class: "cr" },
        g,
      );
      reason.textContent = s.reason || "this moment";
      if (reason.getComputedTextLength() > width) {
        reason.setAttribute("textLength", String(width));
        reason.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
      const credits = mk(
        "text",
        { x: lx, y: labelY - cy + 66, "text-anchor": anchor, class: "cj" },
        g,
      );
      credits.textContent =
        s.lighters.length > 1
          ? "with " + withLine(s)
          : "lit by @" + s.owner.name;
      if (credits.getComputedTextLength() > width) {
        credits.setAttribute("textLength", String(width));
        credits.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
    if (!isTop && /[^\x00-\x7f]/.test(s.reason)) {
      const reason = mk(
        "text",
        { x: lx, y: labelY - cy + 31, "text-anchor": anchor, class: "cr" },
        g,
      );
      reason.style.fill = "rgba(255,246,220,.8)";
      reason.style.fontSize = "26px";
      reason.textContent = s.reason;
    }
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
  await document.fonts.ready;
  document.documentElement.dataset.ready = "true";
}
