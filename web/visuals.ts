import type { Service } from "../server/service.js";
export type Snapshot = Awaited<ReturnType<Service["snapshot"]>>;
export {
  topThree,
  totalLighters,
  clockTime,
  momentUrl,
} from "../server/engine.js";
export type { Star, Stream, Settings } from "../server/engine.js";
export const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// Exact four-point Bézier star from the approved mock. Never substitute a glyph.
export function starPath(r: number) {
  const i = r * 0.28;
  return `M0 ${-r} C${i * 0.4} ${-i} ${i} ${-i * 0.4} ${r} 0 C${i} ${i * 0.4} ${i * 0.4} ${i} 0 ${r} C${-i * 0.4} ${i} ${-i} ${i * 0.4} ${-r} 0 C${-i} ${-i * 0.4} ${-i * 0.4} ${-i} 0 ${-r}Z`;
}
export function svgStar(r = 70, size = 160, fill = "var(--gold)") {
  return `<svg width="${size}" height="${size}" viewBox="-${size / 2} -${size / 2} ${size} ${size}" aria-hidden="true"><path class="core" fill="${fill}" d="${starPath(r)}"/></svg>`;
}
export function withLine(star: import("../server/engine.js").Star) {
  const names = star.lighters
    .slice(1, 4)
    .map((u) => "@" + u.name)
    .join("  ");
  return (
    names + (star.lighters.length > 4 ? `  +${star.lighters.length - 4}` : "")
  );
}
export function mk<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent: Element,
) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    e.setAttribute(key, String(value));
  parent.append(e);
  return e;
}
export function dust(canvas: HTMLCanvasElement, n: number, seed: number) {
  let a = seed;
  const random = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = canvas.getContext("2d")!;
  for (let i = 0; i < n; i++) {
    const x = random() * canvas.width,
      y = random() * canvas.height,
      alpha = 0.06 + random() * 0.42,
      r = random() < 0.93 ? 0.8 : 1.6;
    g.fillStyle = `rgba(255,246,220,${alpha})`;
    g.beginPath();
    g.arc(x, y, r, 0, 7);
    g.fill();
  }
}
export function fitStage(
  stage: HTMLElement,
  width: number,
  height: number,
  card = false,
) {
  const fit = () => {
    const scale = card
      ? Math.min(1, innerWidth / width)
      : Math.min(innerWidth / width, innerHeight / height);
    stage.style.transform = `scale(${scale})`;
    if (card) {
      document.body.style.height = `${height * scale}px`;
      stage.style.left = `${Math.max(0, (innerWidth - width * scale) / 2)}px`;
    }
  };
  addEventListener("resize", fit);
  fit();
}
export function curve(points: number[][]) {
  if (!points.length) return "";
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!,
      [x1, y1] = points[i]!;
    const mx = (x0! + x1!) / 2;
    d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  }
  return d;
}
export async function api<T = Record<string, unknown>>(
  url: string,
  data?: unknown,
  method = "POST",
): Promise<T> {
  const res = await fetch(
    url,
    data === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || "Request failed");
  return value;
}
