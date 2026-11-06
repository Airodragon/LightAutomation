// Ambient screensaver for screen mode: big clock, weather, home status.
// Tap / Escape wakes; swipe up on the handle opens Control Center.
import { h, setText } from "./dom.js";
import { state, stats, refreshWeather } from "./store.js";
import { activeMedia } from "./views/nowplaying.js";
import { createAmbient } from "./ambient.js";
import { openControlCenter } from "./controlcenter.js";

let root = null;
let clockTimer = null;
let onDismiss = null;
let ambient = null;
let openControlOnHide = false;

function ensure() {
  if (root) return root;
  root = document.getElementById("screensaver");
  if (!root) {
    root = h("div", { id: "screensaver", "aria-hidden": "true" });
    document.body.append(root);
  }
  const time = h("div", { class: "ss-time" });
  const date = h("div", { class: "ss-date" });
  const weather = h("div", { class: "ss-weather" });
  const statusPrimary = h("div", { class: "ss-status-primary" });
  const statusSecondary = h("div", { class: "ss-status-secondary" });
  const status = h("div", { class: "ss-status" }, statusPrimary, statusSecondary);
  const hint = h("div", { class: "ss-hint" }, "Tap to wake · swipe up for Control");
  const handle = h("button", {
    class: "ss-handle",
    type: "button",
    title: "Swipe up for Control",
    "aria-label": "Swipe up for Control Center, or tap to wake",
  });
  const ambientHost = h("div", { class: "ss-ambient" });
  const orbs = h("div", { class: "ss-orbs" }, h("i"), h("i"), h("i"));
  root.replaceChildren(
    ambientHost,
    orbs,
    h("div", { class: "ss-center" }, time, date, weather, status),
    hint,
    handle
  );
  root._els = { time, date, weather, status, statusPrimary, statusSecondary, handle, ambientHost, orbs };

  const wake = () => {
    openControlOnHide = false;
    hide();
  };
  const wakeToControl = () => {
    openControlOnHide = true;
    hide();
  };

  let edgeY0 = 0;
  let edgeTracking = false;
  root.addEventListener("pointerdown", (e) => {
    if (e.target === handle || (e.target.closest && e.target.closest(".ss-handle"))) return;
    if (e.clientY >= window.innerHeight - 48) {
      edgeY0 = e.clientY;
      edgeTracking = true;
      return;
    }
    wake();
  });
  root.addEventListener("pointerup", (e) => {
    if (!edgeTracking) return;
    edgeTracking = false;
    if (edgeY0 - e.clientY > 28) wakeToControl();
    else wake();
    edgeY0 = 0;
  });
  root.addEventListener("pointercancel", () => {
    edgeTracking = false;
    edgeY0 = 0;
  });

  let y0 = 0;
  let tracking = false;
  handle.addEventListener("pointerdown", (e) => {
    y0 = e.clientY;
    tracking = true;
    e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    e.stopPropagation();
    if (y0 - e.clientY > 24) wakeToControl();
    else wake();
    y0 = 0;
  });
  handle.addEventListener("pointercancel", () => {
    tracking = false;
    y0 = 0;
  });
  handle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  return root;
}

function mountAmbient() {
  const { ambientHost, orbs } = root._els;
  if (ambient) return;
  ambient = createAmbient(ambientHost, { fps: 12, className: "ambient-layer" });
  if (ambient && ambient.static) orbs.classList.add("fallback");
  else orbs.classList.remove("fallback");
}

function tearAmbient() {
  if (ambient) {
    ambient.destroy();
    ambient = null;
  }
  if (root && root._els) root._els.orbs.classList.remove("fallback");
}

function tick() {
  if (!root || !root.classList.contains("on")) return;
  const { time, date, weather, statusPrimary, statusSecondary } = root._els;
  const d = new Date();
  setText(time, d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  setText(date, d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
  const w = state.weather;
  if (w && w.temp != null) {
    const unit = w.units === "F" ? "°F" : "°C";
    weather.replaceChildren(
      h("span", { class: "ss-temp" }, `${Math.round(w.temp)}${unit}`),
      h("span", { class: "ss-wlabel" }, w.label || "")
    );
  } else {
    setText(weather, "");
  }
  const s = stats();
  const media = activeMedia();
  setText(statusPrimary, s.lights ? `${s.on} of ${s.lights} lights on` : "All quiet");
  const secondary = [];
  if (media && (media.playing || media.title)) {
    secondary.push(media.title ? `♪ ${media.title}` : `♪ ${media.app || "Playing"}`);
  }
  if (s.total && s.online < s.total) secondary.push(`${s.total - s.online} offline`);
  setText(statusSecondary, secondary.join("  ·  "));
  statusSecondary.style.display = secondary.length ? "" : "none";
  if (w && w.period) {
    document.documentElement.dataset.period = w.period;
    ambient && ambient.setPeriod(w.period);
  }
  if (ambient) {
    ambient.setEnergy(media && media.playing ? 0.4 : s.on > 0 ? 0.2 : 0);
  }
}

export function show(dismissCb) {
  const el = ensure();
  onDismiss = dismissCb || null;
  openControlOnHide = false;
  el.classList.add("on");
  el.setAttribute("aria-hidden", "false");
  document.body.classList.add("screensaver-on");
  mountAmbient();
  refreshWeather();
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

export function hide() {
  if (!root) return;
  if (!root.classList.contains("on")) {
    onDismiss && onDismiss();
    return;
  }
  root.classList.remove("on");
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("screensaver-on");
  clearInterval(clockTimer);
  clockTimer = null;
  tearAmbient();
  const openCc = openControlOnHide;
  openControlOnHide = false;
  const cb = onDismiss;
  onDismiss = null;
  cb && cb();
  if (openCc) {
    requestAnimationFrame(() => openControlCenter());
  }
}

export function isOn() {
  return !!(root && root.classList.contains("on"));
}

export function refresh() {
  if (isOn()) tick();
}
