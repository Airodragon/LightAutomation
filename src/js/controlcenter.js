// Swipe-up Control Center for kiosk / wall screens.
import { h, icon, btn } from "./dom.js";
import { state } from "./store.js";
import { applyScene, setDevice } from "./actions.js";
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

function paint() {
  const sheet = root._sheet;
  const mode = presenceMode();
  const scenes = (state.scenes || []).slice(0, 6);
  const presenceRow = h("div", { class: "cc-presence" },
    ...PRESENCE.map((p) => {
      const b = h("button", { class: "cc-pill" + (mode === p.id ? " on" : ""), type: "button" }, p.label);
      b.addEventListener("click", () => setPresence(p.id).then(paint));
      return b;
    }));

  const sceneRow = h("div", { class: "cc-grid" },
    ...scenes.map((sc) => {
      const b = h("button", { class: "cc-tile", type: "button" }, icon(sc.icon || "sparkles", 18), sc.name);
      b.addEventListener("click", () => { applyScene(sc); closeControlCenter(); });
      return b;
    }));

  sheet.replaceChildren(
    h("div", { class: "cc-handle" }),
    h("div", { class: "cc-title" }, "Control"),
    h("div", { class: "eyebrow" }, "Presence"),
    presenceRow,
    scenes.length ? h("div", { class: "eyebrow", style: { marginTop: "14px" } }, "Scenes") : null,
    scenes.length ? sceneRow : null,
    h("div", { class: "cc-actions" },
      btn("All lights off", { cls: "small", icon: "power", size: 14 }, () => {
        for (const d of state.devices) if (d.kind === "light" && d.caps.includes("onoff")) setDevice(d.id, { on: false });
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
}

export function initControlCenter() {
  ensure();
}
