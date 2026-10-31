import {
  $,
  clockTime,
  curve,
  dust,
  esc,
  fitStage,
  mk,
  starPath,
  topThree,
  withLine,
  type Stream,
} from "./visuals.js";
export function coldopenPage() {
  document.body.className = "coldopen-page";
  $("app").innerHTML =
    `<div id="co" class="stage"><div id="world"><canvas id="coDust" width="5760" height="1080"></canvas><svg id="coSvg" width="5760" height="1080"></svg></div><div class="coK fade" id="coK"></div><div class="coH fade" id="coH">Your <i>brightest</i> moments</div><div class="count" id="cdown"></div><div class="clip" id="clip"><div class="img"></div><div id="clipMedia"></div><div class="vig"></div><div class="tx"><div class="o" id="cO"></div><div class="why" id="cY"></div><div class="who" id="cW"></div></div></div><div class="endband" id="endb"><div class="tx2">Tonight's sky is empty. Type <b>!star</b> to light the first one.</div><div class="ax2" style="margin-top:46px"></div></div><div class="toast fade" id="toast">stream.online → cold open</div><button class="skip" id="skip">SKIP · 15S</button></div>`;
  fitStage($("co"), 1920, 1080);
  dust($<HTMLCanvasElement>("coDust"), 1700, 23);
  let timers: ReturnType<typeof setTimeout>[] = [],
    run = 0;
  const stop = () => {
    run++;
    timers.forEach(clearTimeout);
    timers = [];
    $("clipMedia").replaceChildren();
    $("co").style.display = "none";
    document.documentElement.dataset.playing = "false";
  };
  $("skip").onclick = stop;
  // The skip button is for a local preview window; on the OBS output it would be seen by viewers. Show it only with ?skip.
  if (!new URLSearchParams(location.search).has("skip")) $("skip").style.display = "none";
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") stop();
  });
  const opacity = (id: string, value: number) =>
    ($(id).style.opacity = String(value));
  const camera = (x: number, y: number, scale: number, seconds: number) => {
    $("world").style.transitionDuration = `${seconds}s, 1s`;
    $("world").style.transform =
      `translate(${960 - x * scale}px,${540 - y * scale}px) scale(${scale})`;
  };
  function play(stream?: Stream) {
    stop();
    const id = run;
    document.documentElement.dataset.playing = "true";
    $("co").style.display = "block";
    const after = (ms: number, fn: () => void) =>
      timers.push(
        setTimeout(() => {
          if (id === run) fn();
        }, ms),
      );
    const svg = $("coSvg");
    svg.replaceChildren();
    const stars = stream?.stars ?? [],
      top = topThree(stars),
      length = Math.max(
        1,
        ((stream?.endedAt ?? stream?.startedAt ?? 0) -
          (stream?.startedAt ?? 0)) /
          1000,
      ),
      max = Math.max(1, ...stars.map((s) => s.lighters.length));
    const wx = (t: number) => 360 + (5040 * t) / length,
      wy = (n: number) => 840 - (n / max) * 620;
    mk(
      "path",
      {
        d: curve(
          stars.map((s) => [wx(s.offsetSeconds), wy(s.lighters.length)]),
        ),
        fill: "none",
        stroke: "rgba(255,214,140,.25)",
        "stroke-width": 2.4,
        "stroke-dasharray": "3 12",
      },
      svg,
    );
    for (const s of stars) {
      const g = mk(
          "g",
          {
            transform: `translate(${wx(s.offsetSeconds)},${wy(s.lighters.length)})`,
          },
          svg,
        ),
        size = 12 + Math.sqrt(s.lighters.length) * 5;
      mk(
        "path",
        {
          d: starPath(size),
          fill: top.includes(s) ? "var(--gold)" : "var(--star)",
        },
        g,
      );
      mk(
        "text",
        { x: 0, y: size + 44, "text-anchor": "middle", class: "cl" },
        g,
      ).textContent = "@" + s.owner.name;
    }
    $("coK").textContent = stream
      ? `LAST STREAM · ${new Date(stream.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase()}`
      : "A NEW SKY";
    $("coH").innerHTML = stars.length
      ? "Your <i>brightest</i> moments"
      : "Your story <i>starts tonight</i>";
    $("clip").classList.remove("on");
    $("cdown").classList.remove("on");
    opacity("endb", 0);
    opacity("coK", 0);
    opacity("coH", 0);
    opacity("toast", 0);
    opacity("world", 0.3);
    camera(960, 540, 1, 0);
    after(80, () => {
      opacity("toast", 1);
      opacity("coK", 1);
      opacity("coH", 1);
    });
    after(2000, () => {
      opacity("coK", 0);
      opacity("coH", 0);
      opacity("world", 1);
      camera(4700, 540, 1, 2.5);
    });
    const order = [...top].reverse();
    for (let i = 0; i < order.length; i++) {
      const star = order[i]!,
        time = 4700 + i * 2600,
        rank = top.indexOf(star) + 1;
      after(time, () => {
        $("clip").classList.remove("on");
        $("clipMedia").replaceChildren();
        $("cdown").textContent = String(rank);
        $("cdown").classList.add("on");
        camera(wx(star.offsetSeconds), wy(star.lighters.length), 2.2, 0.6);
      });
      after(time + 650, () => {
        $("cdown").classList.remove("on");
        $("cO").textContent =
          `NO. ${rank}${rank === 1 ? " · BRIGHTEST" : ""} · ${clockTime(star.offsetSeconds)}`;
        $("cY").textContent = star.reason || "A moment worth keeping";
        $("cW").innerHTML =
          `lit by @${esc(star.owner.name)}<span>${star.lighters.length > 1 ? "with " + esc(withLine(star)) : ""}</span>`;
        $("clipMedia").innerHTML =
          `<div class="mock-caption">${stream?.mock ? "MOCK MOMENT · " + star.lighters.length + " LIGHTERS" : "A MOMENT YOUR CHAT REMEMBERED"}</div>`;
        if (star.clipId && !stream?.mock) {
          const frame = document.createElement("iframe");
          frame.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(star.clipId)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true&muted=false`;
          frame.allow = "autoplay; fullscreen";
          frame.title = "Highlight clip";
          frame.onerror = () => frame.remove();
          $("clipMedia").append(frame);
        }
        $("clip").classList.add("on");
      });
    }
    after(12500, () => {
      $("clip").classList.remove("on");
      $("clipMedia").replaceChildren();
      $("cdown").classList.remove("on");
      opacity("toast", 0);
      camera(2880, 540, 0.34, 0.7);
      opacity("world", 0.25);
      opacity("endb", 1);
    });
    after(15000, stop);
  }
  return play;
}
