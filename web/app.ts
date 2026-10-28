import { $, api, type Snapshot, type Star, type Stream } from "./visuals.js";
import { cardPage } from "./card.js";
import { overlayPage } from "./overlay.js";
import { coldopenPage } from "./coldopen.js";
import { dashboardPage } from "./dashboard.js";
async function main() {
  const path = location.pathname;
  if (path.startsWith("/card/")) {
    await cardPage(decodeURIComponent(path.slice(6)));
    return;
  }
  let update: (
      state: Snapshot,
      events?: { type: string; star: Star }[],
    ) => void = () => {},
    play: ((stream?: Stream) => void) | undefined,
    connection: (ok: boolean) => void = () => {},
    notice: (s: string, error?: boolean) => void = () => {};
  if (path === "/overlay") update = overlayPage();
  else if (path === "/coldopen") play = coldopenPage();
  else {
    const dashboard = dashboardPage();
    update = dashboard.update;
    connection = dashboard.connection;
    notice = dashboard.notice;
  }
  const initial = await api<Snapshot>("/api/state");
  update(initial);
  if (play && new URLSearchParams(location.search).get("play") === "1")
    play(initial.previous);
  let sequence = initial.sequence,
    retry = 500;
  function connect() {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    socket.onopen = () => {
      sequence = -1;
      connection(true);
      retry = 500;
    };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "state" && data.sequence >= sequence) {
          sequence = data.sequence;
          update(data, data.events);
        } else if (data.type === "coldopen") play?.(data.previous);
        else if (data.type === "error") notice(data.message, true);
      } catch (error) {
        notice(
          error instanceof Error ? error.message : "Invalid live update",
          true,
        );
      }
    };
    socket.onclose = () => {
      connection(false);
      setTimeout(connect, retry);
      retry = Math.min(10000, retry * 2);
    };
    socket.onerror = () => socket.close();
  }
  connect();
  document.documentElement.dataset.ready = "true";
}
void main().catch((error) => {
  $("app").textContent =
    `Starmark could not load: ${error instanceof Error ? error.message : String(error)}. Refresh to reconnect.`;
});
