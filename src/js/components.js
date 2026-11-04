// Reusable pieces: device card, compact row, colour controls.
import { h, icon, kindIcon, setText, setClass, setStyle, setAttr } from "./dom.js";
import { state, L, glowColor } from "./store.js";
import { setDevice, toggleDevice, describe, hexToRgb, rgbToHex, run } from "./actions.js";
import { openDetail } from "./views/detail.js";

export const toggle = (small = false) => h("button", { class: "toggle" + (small ? " small" : ""), "aria-label": "Toggle" });

export function setPct(range) {
  const min = +range.min || 0, max = +range.max || 100;
  range.style.setProperty("--pct", ((range.value - min) / (max - min)) * 100 + "%");
}

/** Range input that never fights the user: ignores state while being dragged. */
export function slider({ min, max, step = 1, cls = "", onInput }) {
  const el = h("input", { type: "range", min, max, step, class: cls });
  el._active = false;
  const down = () => (el._active = true);
  const up = () => setTimeout(() => (el._active = false), 350);
  el.addEventListener("pointerdown", down);
  el.addEventListener("touchstart", down, { passive: true });
  window.addEventListener("pointerup", up);
  el.addEventListener("keydown", down);
  el.addEventListener("keyup", up);
  el.addEventListener("input", () => {
    setPct(el);
    onInput && onInput(+el.value);
  });
  return el;
}

export function setSlider(el, value) {
  if (el._active || value == null) return;
  if (+el.value !== value) el.value = value;
  setPct(el);
}

export function glowFor(d, l) {
  return glowColor(d, l) || (d.kind === "light" ? "#ffd27a" : "var(--accent)");
}

// ---------- device card ----------

export function deviceCard() {
  const tg = toggle();
  const iconBox = h("div", { class: "dev-icon" });
  const name = h("div", { class: "dev-name" });
  const status = h("div", { class: "dev-sub" });
  const tag = h("span", { class: "dev-tag" });
  const sl = slider({ min: 1, max: 100 });
  const wrap = h("div", { class: "slider-wrap no-drag" }, sl);
  const climate = h("div", { class: "row no-drag", style: { justifyContent: "space-between" } });
  const el = h(
    "div",
    { class: "dev" },
    h("div", { class: "dev-head" }, iconBox, h("div", { class: "grow" }), tag, tg),
    h("div", null, name, status),
    wrap,
    climate
  );
  const minus = h("button", { class: "btn small icon no-drag" }, "−");
  const plus = h("button", { class: "btn small icon no-drag" }, "+");
  const tval = h("b");
  climate.append(minus, tval, plus);
  el._r = { tg, iconBox, name, status, tag, sl, wrap, climate, tval, kind: null, id: null };
  tg.addEventListener("click", (e) => { e.stopPropagation(); toggleDevice(el._r.id); });
  el.addEventListener("click", (e) => {
    if (e.target.closest(".no-drag, .toggle")) return;
    openDetail(el._r.id);
  });
  sl.addEventListener("input", () => setDevice(el._r.id, { brightness: +sl.value }));
  const adj = (dv) => () => {
    const l = L(el._r.id);
    setDevice(el._r.id, { target: Math.round(((l.target ?? 21) + dv) * 2) / 2 });
  };
  minus.addEventListener("click", adj(-0.5));
  plus.addEventListener("click", adj(0.5));
  return el;
}

export function updateDeviceCard(el, d) {
  const r = el._r;
  const l = L(d.id);
  r.id = d.id;
  const on = !!l.on;
  const dead = !l.online;
  setClass(el, "on", on && !dead);
  setClass(el, "off-line", dead);
  setStyle(el, "--glow", glowFor(d, l));
  const iconKind = /fan/i.test(`${d.kind} ${d.name}`) ? "fan" : kindIcon(d.kind);
  if (r.kind !== iconKind) {
    r.kind = iconKind;
    r.iconBox.replaceChildren(icon(iconKind, 18));
  }
  setText(r.name, d.name);
  setText(r.status, describe(d, l));
  setClass(r.tg, "on", on);
  setAttr(r.tg, "aria-pressed", String(on));
  setAttr(r.tg, "aria-label", `Toggle ${d.name}`);
  r.tg.style.display = d.caps.includes("onoff") ? "" : "none";
  const showDim = d.caps.includes("dim") && !dead && d.kind === "light";
  r.wrap.style.display = showDim ? "" : "none";
  if (showDim) { setSlider(r.sl, l.brightness ?? 50); setAttr(r.sl, "aria-label", `${d.name} brightness`); }
  setText(r.tag, d.driver === "ha" ? "HA" : d.driver === "net" ? "Net" : d.kind === "fan" || /fan/i.test(d.name) ? "Fan" : d.kind === "climate" ? "AC" : "");
  const showClimate = d.kind === "climate" && !dead;
  r.climate.style.display = showClimate ? "" : "none";
  if (showClimate) setText(r.tval, l.target != null ? `${l.target}°` : "–");
}

// ---------- compact row (rooms view) ----------

export function miniRow() {
  const tg = toggle(true);
  const ic = h("div", { class: "mi" });
  const name = h("div", { class: "t", style: { fontWeight: 700 } });
  const sub = h("div", { class: "s muted", style: { fontSize: "12px" } });
  const el = h("div", { class: "mini" }, ic, h("div", { class: "grow" }, name, sub), tg);
  el._r = { tg, ic, name, sub, kind: null, id: null };
  tg.addEventListener("click", (e) => { e.stopPropagation(); toggleDevice(el._r.id); });
  el.addEventListener("click", (e) => {
    if (e.target.closest(".toggle")) return;
    openDetail(el._r.id);
  });
  return el;
}

export function updateMini(el, d) {
  const r = el._r;
  const l = L(d.id);
  r.id = d.id;
  setClass(el, "on", !!l.on && !!l.online);
  setStyle(el, "--glow", glowFor(d, l));
  const iconKind = /fan/i.test(`${d.kind} ${d.name}`) ? "fan" : kindIcon(d.kind);
  if (r.kind !== iconKind) {
    r.kind = iconKind;
    r.ic.replaceChildren(icon(iconKind, 18));
  }
  setText(r.name, d.name);
  setText(r.sub, describe(d, l));
  setClass(r.tg, "on", !!l.on);
  r.tg.style.display = d.caps.includes("onoff") ? "" : "none";
}

// ---------- colour controls ----------

export const PALETTE = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#32ade6", "#5e5ce6", "#bf5af2", "#ff2d92", "#ffffff"];

export function colorControls(d) {
  const sw = h("div", { class: "swatches" });
  for (const c of PALETTE) {
    sw.append(h("button", { class: "swatch", style: { background: c }, title: c, onClick: () => setDevice(d.id, { color: c }) }));
  }
  const picker = h("input", { type: "color", style: { width: "34px", height: "34px", padding: 0, border: 0, background: "none" }, title: "Custom colour" });
  picker.addEventListener("input", () => setDevice(d.id, { color: picker.value }));
  sw.append(picker);
  const hue = slider({ min: 0, max: 360, cls: "hue", onInput: (v) => setDevice(d.id, { color: hslHex(v, 100, 55) }) });
  hue.style.setProperty("--pct", "0%");
  hue.style.background = "none";
  return { node: h("div", { class: "stack", style: { gap: "12px" } }, sw, hue), picker };
}

export function hslHex(hh, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return rgbToHex([f(0), f(8), f(4)]);
}

export function statusDot(online, seen) {
  return h("span", { class: "dot " + (online ? "on" : seen ? "bad" : "warn") });
}

export { run, hexToRgb };
