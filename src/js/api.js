// Transport: Tauri IPC inside the Mac app, HTTP + Server-Sent Events in a browser.

const T = window.__TAURI__;
export const isTauri = !!(T && T.core && T.event);

const PIN_KEY = "hub-pin";
export const getPin = () => localStorage.getItem(PIN_KEY) || "";
export const setPin = (p) => (p ? localStorage.setItem(PIN_KEY, p) : localStorage.removeItem(PIN_KEY));

export class AuthError extends Error {}

export async function ping() {
  if (isTauri) return { ok: true, pin_required: false };
  const r = await fetch("/api/ping");
  return r.json();
}

export async function call(cmd, args = {}) {
  if (isTauri) {
    try {
      return await T.core.invoke("call", { cmd, args });
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e.message || String(e));
    }
  }
  const r = await fetch(`/api/call/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-pin": getPin() },
    body: JSON.stringify(args),
  });
  if (r.status === 401) throw new AuthError("PIN required");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.data;
}

/**
 * Subscribe to hub events. handlers: { snapshot, live, menu, scanning, status(connected:boolean), auth() }
 * Returns a function that stops listening.
 */
export function subscribe(h) {
  if (isTauri) {
    const offs = [];
    const on = (name, fn) =>
      T.event.listen(name, (e) => fn(e.payload)).then((off) => offs.push(off));
    on("hub://snapshot", (p) => h.snapshot && h.snapshot(p));
    on("hub://live", (p) => h.live && h.live(p));
    on("hub://menu", (p) => h.menu && h.menu(p));
    on("hub://scanning", (p) => h.scanning && h.scanning(p));
    for (const ev of ["wall_notify", "wall_ring", "doorbell", "presence", "webrtc", "home_call", "call_started", "wall_clients"]) {
      on(`hub://${ev}`, (p) => h[ev] && h[ev](p));
    }
    h.status && h.status(true);
    return () => offs.forEach((o) => o());
  }
  let es = null;
  let stopped = false;
  let retry = 800;
  const open = () => {
    if (stopped) return;
    es = new EventSource(`/api/events?pin=${encodeURIComponent(getPin())}`);
    es.addEventListener("snapshot", (e) => {
      retry = 800;
      h.status && h.status(true);
      h.snapshot && h.snapshot(JSON.parse(e.data));
    });
    es.addEventListener("live", (e) => h.live && h.live(JSON.parse(e.data)));
    es.addEventListener("scanning", (e) => h.scanning && h.scanning(JSON.parse(e.data)));
    for (const ev of ["wall_notify", "wall_ring", "doorbell", "presence", "webrtc", "home_call", "call_started", "wall_clients"]) {
      es.addEventListener(ev, (e) => h[ev] && h[ev](JSON.parse(e.data)));
    }
    es.onerror = async () => {
      h.status && h.status(false);
      es.close();
      // 401 shows up as an error too: check whether we need a PIN
      try {
        const p = await ping();
        if (p.pin_required) {
          const r = await fetch(`/api/state`, { headers: { "x-hub-pin": getPin() } });
          if (r.status === 401) {
            h.auth && h.auth();
            return;
          }
        }
      } catch (_) {}
      setTimeout(open, retry);
      retry = Math.min(retry * 1.6, 8000);
    };
  };
  open();
  return () => {
    stopped = true;
    es && es.close();
  };
}

export async function setFullscreen(on) {
  if (isTauri) return T.core.invoke("set_fullscreen", { on });
  if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  return on;
}

export function openUrl(url) {
  if (isTauri) {
    T.core.invoke("plugin:opener|open_url", { url }).catch(() => window.open(url, "_blank"));
  } else window.open(url, "_blank");
}
