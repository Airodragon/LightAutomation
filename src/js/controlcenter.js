// Swipe-up Control Center for kiosk / wall screens — full house control on a table tablet.
import { h, icon, btn } from "./dom.js";
import { state, L } from "./store.js";
import { applyScene, setDevice, toggleDevice, fmtW } from "./actions.js";
import { PRESENCE, presenceMode, setPresence } from "./wall.js";
import { openOutputsPicker } from "./views/nowplaying.js";

let root = null;
let open = false;
let lastFocus = null;

export function isControlOpen() {
  return open;
}

export function closeControlCenter() {
  if (!root || !open) return;
  root.classList.remove("on");
  root.setAttribute("aria-hidden", "true");
  root.removeAttribute("aria-modal");
  open = false;
  document.removeEventListener("keydown", onKey);
  if (lastFocus && typeof lastFocus.focus === "function") {
    try { lastFocus.focus(); } catch (_) {}
  }
  lastFocus = null;
  // Rearm idle after dismissing Control on a wall tablet
  if (state.ui.kiosk) {
    import("./app.js").then((m) => m.armIdle && m.armIdle()).catch(() => {});
  }
}

export function openControlCenter() {
  ensure();
  lastFocus = document.activeElement;
  root.classList.add("on");
  root.setAttribute("aria-hidden", "false");
  root.setAttribute("aria-modal", "true");
  open = true;
  paint();
  document.addEventListener("keydown", onKey);
  // Pause screensaver idle while Control is up
  import("./app.js").then((m) => {
    if (m.armIdle) {
      // armIdle no-ops while open; calling clears any pending dim timer first
      m.armIdle();
    }
  }).catch(() => {});
  requestAnimationFrame(() => {
    const first = root._sheet.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    first && first.focus();
  });
}

function onKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeControlCenter();
  }
}

function ensure() {
  if (root) return root;
  root = h("div", {
    id: "control-center",
    class: "control-center",
    role: "dialog",
    "aria-label": "Control Center",
    "aria-hidden": "true",
  });
  const sheet = h("div", { class: "cc-sheet" });
  root._sheet = sheet;
  root.append(h("div", { class: "cc-backdrop" }), sheet);
  root.querySelector(".cc-backdrop").addEventListener("click", closeControlCenter);
  document.body.append(root);

  // Swipe up from bottom edge
  let y0 = 0;
  window.addEventListener("pointerdown", (e) => {
    if (!state.ui.kiosk) return;
    if (e.clientY < window.innerHeight - 28) return;
    y0 = e.clientY;
  }, true);
  window.addEventListener("pointerup", (e) => {
    if (!state.ui.kiosk || !y0) return;
    if (y0 - e.clientY > 40) openControlCenter();
    y0 = 0;
  }, true);

  // Swipe down from top for notifications hint — open control as well
  let ty0 = 0;
  window.addEventListener("pointerdown", (e) => {
    if (!state.ui.kiosk) return;
    if (e.clientY > 24) return;
    ty0 = e.clientY;
  }, true);
  window.addEventListener("pointerup", (e) => {
    if (!state.ui.kiosk || !ty0) return;
    if (e.clientY - ty0 > 40) openControlCenter();
    ty0 = 0;
  }, true);

  return root;
}

function roomDevices(name) {
  return state.devices.filter((d) => d.room === name && ["light", "plug", "switch"].includes(d.kind) && d.caps.includes("onoff"));
}

function setRoom(name, on) {
  for (const d of roomDevices(name)) setDevice(d.id, { on });
}

function paint() {
  const sheet = root._sheet;
  const mode = presenceMode();
  const scenes = state.scenes || [];
  const starred = state.devices.filter((d) => d.favorite && (d.kind === "light" || d.kind === "plug" || d.kind === "switch"));

  const presenceRow = h("div", { class: "cc-presence" },
    ...PRESENCE.map((p) => {
      const b = h("button", { class: "cc-pill" + (mode === p.id ? " on" : ""), type: "button" }, p.label);
      b.addEventListener("click", () => setPresence(p.id).then(paint));
      return b;
    }));

  const sceneRow = h("div", { class: "cc-grid" },
    ...scenes.map((sc) => {
      const b = h("button", { class: "cc-tile", type: "button" }, icon(sc.icon || "sparkles", 18),
        h("span", { class: "t" }, sc.name));
      b.addEventListener("click", () => { applyScene(sc); closeControlCenter(); });
      return b;
    }));

  const favRow = h("div", { class: "cc-favs" },
    ...starred.map((d) => {
      const l = L(d.id);
      const on = !!(l.on && l.online);
      let line = !l.online ? "Offline" : on ? "On" : "Off";
      if (on && d.kind === "light" && l.brightness != null) line = `${Math.round(l.brightness)}%`;
      if (on && l.watts != null) line += ` · ${fmtW(l.watts)}`;
      if (d.room) line = `${d.room} · ${line}`;
      const b = h("button", {
        class: "cc-fav" + (on ? " on" : ""),
        type: "button",
        "aria-pressed": String(on),
      }, h("span", { class: "t" }, d.name), h("span", { class: "s" }, line));
      b.addEventListener("click", () => { toggleDevice(d.id); requestAnimationFrame(paint); });
      return b;
    }));

  const rooms = (state.rooms || []).filter((r) => roomDevices(r).length);
  const roomList = h("div", { class: "cc-rooms" },
    ...rooms.map((name) => {
      const devs = roomDevices(name);
      const onCount = devs.filter((d) => L(d.id).on && L(d.id).online).length;
      const row = h("div", { class: "cc-room" },
        h("div", { class: "name" }, name),
        h("div", { class: "cc-room-actions" },
          btn("On", { cls: "small", icon: "sun", size: 14 }, () => { setRoom(name, true); paint(); }),
          btn("Off", { cls: "small", icon: "power", size: 14 }, () => { setRoom(name, false); paint(); })),
        h("div", { class: "sub" }, `${onCount} of ${devs.length} on`));
      return row;
    }));

  const children = [
    h("div", { class: "cc-handle" }),
    h("div", { class: "cc-title" }, "Control"),
    h("div", { class: "eyebrow" }, "Presence"),
    presenceRow,
  ];
  if (scenes.length) {
    children.push(h("div", { class: "eyebrow cc-section" }, "Scenes"), sceneRow);
  }
  if (starred.length) {
    children.push(h("div", { class: "eyebrow cc-section" }, "Favorites"), favRow);
  }
  if (rooms.length) {
    children.push(h("div", { class: "eyebrow cc-section" }, "Rooms"), roomList);
  }
  children.push(
    h("div", { class: "cc-actions cc-section" },
      btn("All lights off", { cls: "small", icon: "power", size: 14 }, () => {
        for (const d of state.devices) if (d.kind === "light" && d.caps.includes("onoff")) setDevice(d.id, { on: false });
        paint();
      }),
      btn("Music outputs", { cls: "small", icon: "wifi", size: 14 }, () => { openOutputsPicker(); closeControlCenter(); }),
      btn("Calls", { cls: "small", icon: "media", size: 14 }, () => { location.hash = "#/call"; closeControlCenter(); }),
      btn("Cameras", { cls: "small", icon: "film", size: 14 }, () => { location.hash = "#/cameras"; closeControlCenter(); }),
      btn("Screensaver", { cls: "small", icon: "moon", size: 14 }, async () => {
        closeControlCenter();
        const app = await import("./app.js");
        app.startScreensaver();
      }),
      state.ui.kiosk
        ? btn("Exit screen", { cls: "small", icon: "close", size: 14 }, async () => {
          closeControlCenter();
          (await import("./app.js")).exitKiosk();
        })
        : btn("Screen mode", { cls: "small", icon: "fullscreen", size: 14 }, async () => {
          closeControlCenter();
          (await import("./app.js")).enterKiosk();
        })));

  sheet.replaceChildren(...children);
}

export function initControlCenter() {
  ensure();
}
