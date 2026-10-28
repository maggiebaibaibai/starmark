import {
  $,
  api,
  clockTime,
  esc,
  totalLighters,
  type Snapshot,
} from "./visuals.js";
export function dashboardPage() {
  document.body.className = "dashboard-page";
  $("app").innerHTML =
    `<div class="wrap dashboard"><header class="top"><div><div class="brand">Star<i>mark</i></div><div class="sub">your chat writes the highlight reel</div></div><div class="connection"><span class="status-dot"></span><span id="connection">Connecting…</span><span class="mode">MOCK STUDIO</span></div></header><div class="studio-intro"><div><div class="eyebrow">A little sky. A shared memory.</div><h1>Make tonight<br><i>worth keeping.</i></h1></div><div class="intro-note">Your viewers light the moments.<br>You leave with a constellation.<p>Mock mode · no Twitch account needed.<br>Generated links are placeholders.</p></div></div><div id="notice" class="notice" role="status" aria-live="polite">Start a stream, then type your first !star.</div><section class="panel session-panel"><div class="panel-heading"><h2>01 <span>The live room</span></h2><span id="liveState" class="pill">OFFLINE</span></div><form id="startForm" class="session-controls"><label class="grow">Stream title<input id="streamTitle" value="no hints, final boss" maxlength="140" required></label><button class="btn" id="start" type="submit">Start mock stream</button><button class="btn ghost" id="end" type="button" disabled>End & make card</button></form><div class="metrics"><span><b id="starCount">0</b> stars</span><span><b id="lighterCount">0</b> lighters</span><span><b id="elapsed">0:00:00</b> live</span></div><div class="preview"><div class="preview-feed"></div><span class="preview-label">OBS PREVIEW · TRANSPARENT OVERLAY</span><div class="preview-cam">your cam</div><iframe id="overlayPreview" src="/overlay" title="Live transparent overlay preview"></iframe></div><div class="preview-options"><label>Position<select id="position"><option value="bottom">Bottom</option><option value="top">Top</option><option value="compact">Compact</option></select></label><a id="overlayLink" href="/overlay" target="_blank">Open OBS source ↗</a><button class="btn ghost small" id="coldopen">Play last stream’s cold open</button><a href="/coldopen?play=1" target="_blank">Cold open source ↗</a></div><div id="deliveryWarning" role="status"></div><div id="warnings"></div></section><div class="dashboard-grid"><section class="panel"><div class="panel-heading"><h2>02 <span>Light a moment</span></h2><span class="eyebrow">MOCK CHAT</span></div><form id="chatForm"><div class="form-row"><label class="grow">Name<input id="name" placeholder="luma" value="luma" maxlength="25" required></label><label>Role<select id="role"><option value="viewer">Viewer</option><option value="mod">Moderator</option><option value="broadcaster">Broadcaster</option></select></label></div><label>Message<input id="message" value="!star he finally beat the boss" maxlength="500" required></label><div class="form-row checks"><label><input id="subscriber" type="checkbox">Subscriber</label><button class="btn" type="submit">Send to chat</button></div></form><div class="chat" id="chat" role="log" aria-live="polite"></div><div class="form-row generator-row"><label class="check"><input id="generator" type="checkbox">Generate mock chat</label><button class="btn ghost small" id="advance">Advance 20s</button></div><p class="help">The generator advances mock time by 3s per message. Unique viewers join for 15s; a new star can open after 20s. Lighters count unique viewers per star.</p></section><section class="panel"><div class="panel-heading"><h2>03 <span>Set the atmosphere</span></h2><span class="eyebrow">SETTINGS</span></div><form id="settingsForm"><div class="form-row"><label class="grow">User cooldown (seconds)<input id="cooldown" type="number" min="0" max="86400" required></label><label class="grow">Global gap (seconds)<input id="gap" type="number" min="0" max="86400" required></label></div><div class="checks"><label><input id="subsOnly" type="checkbox">Subscribers only</label><label><input id="namesOnly" type="checkbox">Names only on overlay</label></div><label>Auto names-only viewer threshold<input id="threshold" type="number" min="0" max="1000000" required></label><label>Hidden words / phrases (comma separated)<input id="blocklist" placeholder="word, phrase"></label><div class="form-row"><button class="btn ghost" type="submit">Save settings</button><label class="check"><input id="vodSaving" type="checkbox" checked>Mock VOD saving</label></div></form><p class="help">Auto names-only applies in live mode; mock defaults to showing reasons. Blocked reasons are hidden, never displayed on stream.</p></section></div><section class="panel"><div class="panel-heading"><h2>04 <span>Moderation queue</span></h2><span class="eyebrow">CURRENT STREAM</span></div><div id="modQueue" class="empty">Your sky is waiting for its first star.</div><p class="help">Moderators can type !unstar to remove the latest star. Removal preserves cooldowns and cannot erase remote markers or clips.</p></section><section class="panel"><div class="panel-heading"><h2>05 <span>The nights you made</span></h2><span class="eyebrow">SAVED STREAMS</span></div><div id="streams" class="empty">Your first starmap will appear here.</div></section><footer class="studio-footer"><span>Star<i>mark</i> · a sky made together</span><div><button id="connectTwitch" class="btn ghost small" disabled>Connect Twitch</button><a href="/coldopen" target="_blank">OBS cold open ↗</a></div></footer></div>`;
  let state: Snapshot | undefined,
    received = Date.now(),
    settingsLoaded = false;
  const input = (id: string) => $<HTMLInputElement>(id);
  function notice(text: string, error = false) {
    $("notice").textContent = text;
    $("notice").classList.toggle("error", error);
  }
  async function action(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), true);
    }
  }
  $("connectTwitch").onclick = () => {
    if (state?.mode !== "live") return;
    if (
      state.connection.state === "connected" ||
      state.connection.state === "connecting"
    ) {
      void action(async () => {
        await api("/auth/disconnect", {});
        notice("Twitch disconnected.");
      });
    } else location.assign("/auth/connect");
  };
  function adapterStatus(status: Snapshot["connection"]) {
    if (state) state.connection = status;
    const button = $<HTMLButtonElement>("connectTwitch");
    button.disabled = status.mode === "mock";
    button.textContent =
      status.mode === "live" &&
      ["connected", "connecting"].includes(status.state)
        ? "Disconnect Twitch"
        : "Connect Twitch";
    if (status.mode === "live")
      $("connection").textContent = `Twitch ${status.state}`;
    if (status.state === "error")
      notice(
        "Twitch connection interrupted. Check app settings and reconnect.",
        true,
      );
  }
  $("startForm").onsubmit = (e) => {
    e.preventDefault();
    void action(async () => {
      await api("/api/mock/start", { title: input("streamTitle").value });
      notice("Live. Type !star to light the first one.");
    });
  };
  $("end").onclick = () => {
    void action(async () => {
      $<HTMLButtonElement>("end").disabled = true;
      notice("Closing the sky and rendering your 1080 × 1350 card…");
      try {
        const result = await api<{ cardUrl: string }>("/api/mock/end", {});
        input("generator").checked = false;
        notice(
          "Starmap saved. Open your interactive card or download its PNG below.",
        );
      } finally {
        $<HTMLButtonElement>("end").disabled = !state?.active;
      }
    });
  };
  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    void action(async () => {
      const result = await api<{ accepted: boolean; message: string }>(
        "/api/mock/chat",
        {
          name: input("name").value,
          text: input("message").value,
          role: input("role").value,
          subscriber: input("subscriber").checked,
        },
      );
      notice(result.message, !result.accepted);
    });
  };
  $("generator").onchange = () => {
    void action(async () => {
      try {
        const r = await api<{ enabled: boolean }>("/api/mock/generator", {
          enabled: input("generator").checked,
        });
        input("generator").checked = r.enabled;
        notice(
          r.enabled
            ? "Mock chat is flowing. Time advances with each message."
            : "Mock generator paused.",
        );
      } catch (error) {
        input("generator").checked = false;
        throw error;
      }
    });
  };
  $("advance").onclick = () => {
    void action(async () => {
      await api("/api/mock/advance", { ms: 20000 });
      notice("Mock clock advanced 20 seconds.");
    });
  };
  $("coldopen").onclick = () => {
    void action(async () => {
      await api("/api/coldopen", {});
      notice("Cold open sent to connected /coldopen sources.");
    });
  };
  $("vodSaving").onchange = () => {
    void action(async () => {
      await api("/api/mock/vod", { enabled: input("vodSaving").checked });
      notice(
        input("vodSaving").checked
          ? "Mock archives enabled."
          : "VOD saving disabled. The next marker will show the fallback warning.",
      );
    });
  };
  $("position").onchange = () => {
    const url = "/overlay?pos=" + input("position").value;
    $<HTMLIFrameElement>("overlayPreview").src = url;
    $<HTMLAnchorElement>("overlayLink").href = url;
  };
  $("settingsForm").onsubmit = (e) => {
    e.preventDefault();
    void action(async () => {
      await api("/api/settings", {
        cooldownMs: Number(input("cooldown").value) * 1000,
        gapMs: Number(input("gap").value) * 1000,
        namesOnlyThreshold: Number(input("threshold").value),
        blocklist: input("blocklist")
          .value.split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        subsOnly: input("subsOnly").checked,
        namesOnly: input("namesOnly").checked,
      });
      notice("Settings saved.");
    });
  };
  $("modQueue").onclick = (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>(
      "[data-remove]",
    );
    if (button)
      void action(async () => {
        await api(
          "/api/stars/" + encodeURIComponent(button.dataset.remove!),
          {},
          "DELETE",
        );
        notice("Star removed from your sky.");
      });
  };
  function update(next: Snapshot & { generator?: boolean }) {
    state = next;
    deliveryStatus(next.deliveryWarning);
    received = Date.now();
    const active = next.active;
    const live = next.mode === "live";
    adapterStatus(next.connection);
    document.querySelector(".mode")!.textContent = live
      ? "TWITCH LIVE"
      : "MOCK STUDIO";
    for (const id of ["start", "end", "chatForm"])
      $(id).style.display = live ? "none" : "";
    document.querySelector<HTMLElement>(".generator-row")!.style.display = live
      ? "none"
      : "";
    document.querySelector<HTMLElement>(
      ".generator-row + .help",
    )!.style.display = live ? "none" : "";
    input("vodSaving").parentElement!.style.display = live ? "none" : "";
    input("streamTitle").readOnly = live;
    if (live) {
      input("streamTitle").value =
        active?.title ?? "Waiting for your Twitch stream";
      document.querySelector(".intro-note p")!.textContent =
        "Connect your broadcaster account. Streams start and end automatically.";
      $("chatForm").previousElementSibling!.querySelector(
        ".eyebrow",
      )!.textContent = "TWITCH CHAT";
      if (!settingsLoaded)
        notice(
          "Connect Twitch below, then go live and type !star in Twitch chat.",
        );
    }
    $<HTMLButtonElement>("start").disabled = !!active;
    $<HTMLButtonElement>("end").disabled = !active;
    $("liveState").textContent = active ? "● LIVE" : "OFFLINE";
    $("liveState").classList.toggle("live", !!active);
    $("starCount").textContent = String(active?.stars.length ?? 0);
    $("lighterCount").textContent = String(totalLighters(active?.stars ?? []));
    if (next.generator !== undefined)
      input("generator").checked = next.generator;
    if (!active) input("generator").checked = false;
    if (!settingsLoaded) {
      settingsLoaded = true;
      input("cooldown").value = String(next.settings.cooldownMs / 1000);
      input("gap").value = String(next.settings.gapMs / 1000);
      input("threshold").value = String(next.settings.namesOnlyThreshold);
      input("blocklist").value = next.settings.blocklist.join(", ");
      for (const key of ["subsOnly", "namesOnly"] as const)
        input(key).checked = next.settings[key];
    }
    $("chat").innerHTML = next.messages
      .slice(-10)
      .map(
        (m) =>
          `<div class="m ${m.kind === "bot" ? "bot" : m.kind === "system" ? "sys" : ""}"><span class="who">${esc(m.name)}</span>${esc(m.text)}</div>`,
      )
      .join("");
    $("chat").scrollTop = $("chat").scrollHeight;
    $("warnings").innerHTML = (
      active?.warnings ??
      next.previous?.warnings ??
      []
    )
      .map((w) => `<p class="warning">${esc(w)}</p>`)
      .join("");
    $("modQueue").innerHTML = active?.stars.length
      ? `<div class="queue-list">${[...active.stars]
          .reverse()
          .map(
            (s) =>
              `<div class="queue-item"><span class="queue-star">✦</span><div class="grow"><strong>@${esc(s.owner.name)}</strong><span class="queue-reason">${esc(s.reason || "No reason · names only")}</span></div><span class="mono">${s.lighters.length} lit · ${clockTime(s.offsetSeconds)}</span><span class="delivery">${s.closedAt === undefined ? "JOINING" : s.markerError ? "OFFSET SAVED" : s.clipId ? "MARKER + CLIP" : "MARKER"}</span><button class="btn ghost small" data-remove="${esc(s.id)}">Remove</button></div>`,
          )
          .join("")}</div>`
      : "Your sky is waiting for its first star.";
    $("streams").innerHTML = next.streams.length
      ? next.streams
          .map(
            (s) =>
              `<article class="stream-row"><div><h3>${esc(s.title)}</h3><p>${new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${s.stars} stars · ${s.totalLighters} lighters · ${s.endedAt === undefined ? "live" : "saved"}</p></div><div class="stream-links"><a href="/card/${s.id}" target="_blank">Open card ↗</a><a href="/card/${s.id}.json" download>JSON ↓</a><a class="download" href="/card/${s.id}.png" download>PNG ↓</a></div></article>`,
          )
          .join("")
      : "Your first starmap will appear here.";
  }
  setInterval(() => {
    $("elapsed").textContent = state?.active
      ? clockTime(
          (state.now + Date.now() - received - state.active.startedAt) / 1000,
        )
      : "0:00:00";
  }, 1000);
  function deliveryStatus(warning?: string | null) {
    $("deliveryWarning").textContent = warning ?? "";
    $("deliveryWarning").className = warning ? "warning" : "";
  }
  return {
    deliveryStatus,
    adapterStatus,
    update,
    notice,
    chat: (line: import("./visuals.js").ChatLine) => {
      if (state) state.messages = [...state.messages, line].slice(-40);
      const row = document.createElement("div");
      row.className = `m ${line.kind === "bot" ? "bot" : line.kind === "system" ? "sys" : ""}`;
      row.innerHTML = `<span class="who">${esc(line.name)}</span>${esc(line.text)}`;
      $("chat").append(row);
      while ($("chat").children.length > 10)
        $("chat").firstElementChild!.remove();
      $("chat").scrollTop = $("chat").scrollHeight;
    },
    connection: (connected: boolean) => {
      $("connection").textContent = connected
        ? state?.mode === "live"
          ? `Twitch ${state.connection.state}`
          : "Connected"
        : "Reconnecting…";
      document
        .querySelector(".status-dot")
        ?.classList.toggle("disconnected", !connected);
    },
  };
}
