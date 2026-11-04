// Ambient screensaver for screen mode: big clock, weather, home status.
// Any pointer / key / the bottom handle dismisses it and rearms idle.
import { h, setText } from "./dom.js";
import { state, stats, refreshWeather } from "./store.js";
import { activeMedia } from "./views/nowplaying.js";
import { createAmbient } from "./ambient.js";

let root = null;
let clockTimer = null;
let onDismiss = null;
let ambient = null;

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
  const status = h("div", { class: "ss-status" });
  const hint = h("div", { class: "ss-hint" }, "Touch to wake · swipe up for Control · Calls from Home");
  const handle = h("button", {
    class: "ss-handle",
    type: "button",
    title: "Wake display",
    "aria-label": "Wake display",
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
  root._els = { time, date, weather, status, handle, ambientHost, orbs };
  const wake = (e) => {
    e && e.preventDefault && e.preventDefault();
    hide();
  };
  root.addEventListener("pointerdown", wake);
  handle.addEventListener("click", wake);
  // Swipe up on the handle area
  let y0 = 0;
  handle.addEventListener("pointerdown", (e) => {
    y0 = e.clientY;
    e.stopPropagation();
  });
  handle.addEventListener("pointerup", (e) => {
    if (y0 - e.clientY > 24) wake(e);
    else wake(e);
  });
  return root;
}

function mountAmbient() {
  const { ambientHost, orbs } = root._els;
  if (ambient) return;
  try {
    ambient = createAmbient(ambientHost, { fps: 12, className: "ambient-layer" });
    orbs.classList.remove("fallback");
  } catch (_) {
    orbs.classList.add("fallback");
  }
}

function tearAmbient() {
  if (ambient) {
    ambient.destroy();
    ambient = null;
  }
}

function tick() {
  if (!root || !root.classList.contains("on")) return;
  const { time, date, weather, status } = root._els;
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
  const bits = [];
  if (s.lights) bits.push(`${s.on} of ${s.lights} lights on`);
  if (media && (media.playing || media.title)) {
    bits.push(media.title ? `♪ ${media.title}` : `♪ ${media.app || "Playing"}`);
  }
  if (s.total && s.online < s.total) bits.push(`${s.total - s.online} offline`);
  setText(status, bits.join("  ·  ") || "All quiet");
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
  const cb = onDismiss;
  onDismiss = null;
  cb && cb();
}

export function isOn() {
  return !!(root && root.classList.contains("on"));
}

export function refresh() {
  if (isOn()) tick();
}
