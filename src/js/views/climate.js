// Climate widget: one dial per thermostat / AC (comes from Home Assistant).
import { h, icon, reconcile, setText, setClass, setAttr } from "../dom.js";
import { L } from "../store.js";
import { setDevice } from "../actions.js";
import { toggle } from "../components.js";

const MIN = 16;
const MAX = 30;
const NS = "http://www.w3.org/2000/svg";
const R = 78;
const CIRC = 2 * Math.PI * R;
const ARC = CIRC * 0.75;

function svg(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}

function make() {
  const tg = toggle(true);
  const name = h("h3");
  const mode = h("span", { class: "eyebrow" });
  const dial = svg("svg", { viewBox: "0 0 200 184", role: "img" });
  const track = svg("circle", { class: "track", cx: 100, cy: 100, r: R, "stroke-dasharray": `${ARC} ${CIRC}`, transform: "rotate(135 100 100)" });
  const val = svg("circle", { class: "val", cx: 100, cy: 100, r: R, "stroke-dasharray": `0 ${CIRC}`, transform: "rotate(135 100 100)" });
  const big = svg("text", { class: "big", x: 100, y: 108 });
  const cap = svg("text", { class: "cap", x: 100, y: 128 });
  const lo = svg("text", { class: "cap", x: 45, y: 178 });
  const hi = svg("text", { class: "cap", x: 155, y: 178 });
  lo.textContent = `${MIN}°`;
  hi.textContent = `${MAX}°`;
  dial.append(track, val, big, cap, lo, hi);
  const minus = h("button", { class: "btn icon", title: "Lower temperature" }, "−");
  const plus = h("button", { class: "btn icon", title: "Raise temperature" }, "+");
  const el = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, icon("sensor", 16), name, h("div", { class: "grow" }), mode, tg),
    h("div", { class: "climate" }, dial, h("div", { class: "climate-ctl" }, minus, plus)));
  el._r = { tg, name, mode, val, big, cap, dial, minus, plus, id: null };
  const step = (dv) => () => {
    const l = L(el._r.id);
    const next = Math.min(MAX, Math.max(MIN, Math.round(((l.target ?? 21) + dv) * 2) / 2));
    setDevice(el._r.id, { target: next });
  };
  minus.addEventListener("click", step(-0.5));
  plus.addEventListener("click", step(0.5));
  tg.addEventListener("click", () => setDevice(el._r.id, { on: !L(el._r.id).on }));
  return el;
}

function update(el, d) {
  const r = el._r;
  const l = L(d.id);
  r.id = d.id;
  const dead = !l.online;
  const on = l.on !== false && !dead;
  setText(r.name, d.name);
  setText(r.mode, dead ? "Offline" : l.value ? String(l.value)[0].toUpperCase() + String(l.value).slice(1) : "");
  setClass(r.tg, "on", on);
  setAttr(r.tg, "aria-pressed", String(on));
  setAttr(r.tg, "aria-label", `Power ${d.name}`);
  const t = l.target ?? l.current ?? 21;
  const frac = Math.min(1, Math.max(0, (t - MIN) / (MAX - MIN)));
  r.val.setAttribute("stroke-dasharray", `${(on ? frac : 0) * ARC} ${CIRC}`);
  r.val.style.setProperty("--c", t >= 25 ? "var(--warn)" : "var(--accent)");
  setText(r.big, l.target != null ? `${l.target}°` : "–");
  setText(r.cap, l.current != null ? `Now ${l.current}°` : "Target");
  r.dial.setAttribute("aria-label", `${d.name}: target ${l.target ?? "unknown"} degrees`);
  r.minus.disabled = r.plus.disabled = dead;
}

export function createClimate() {
  const el = h("div", { class: "col" });
  function render(devices) {
    el.style.display = devices.length ? "" : "none";
    reconcile(el, devices, (d) => d.id, make, update);
  }
  return { el, update: render };
}
