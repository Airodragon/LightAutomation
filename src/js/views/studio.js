import { h, icon, reconcile, setText, setClass, btn, throttleLatest } from "../dom.js";
import { state, L, glowColor, reorderLocal } from "../store.js";
import { run } from "../actions.js";
import { makeSortable } from "../sortable.js";
import { slider, setSlider } from "../components.js";
import { reorderSubset } from "./dashboard.js";

const KEY = "studio-params";
const defaults = { effect: "chase", duration: 4, spread: 1.4, fade: 0.65, trail: 0.35, direction: "forward", brightness: 100, color: "#ff7a1a", scope: "all" };
const params = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };

const PARAMS = [
  ["duration", "Cycle time", 0.5, 20, 0.1, (v) => v.toFixed(1) + " s"],
  ["spread", "Spread", 0.4, 4, 0.05, (v) => v.toFixed(2)],
  ["fade", "Softness (distance fade)", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"],
  ["trail", "Trail", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"],
  ["brightness", "Peak brightness", 10, 100, 1, (v) => v + "%"],
];

export function createStudio() {
  const strip = h("div", { class: "strip" });
  makeSortable(strip, { item: ".bulb", group: "strip", onDrop: ({ keys }) => reorderSubset(keys) });
  const none = h("div", { class: "muted" }, "No WiZ lights yet. Add some from the Devices page.");
  const fx = h("div", { class: "fx" });
  const sliders = {};
  const values = {};
  const grid = h("div", { class: "params" });
  for (const [k, label, min, max, step, fmt] of PARAMS) {
    const val = h("b");
    values[k] = val;
    const s = slider({ min, max, step, onInput: (v) => { params[k] = v; val.textContent = fmt(v); changed(); } });
    sliders[k] = s;
    grid.append(h("div", { class: "param" }, h("div", { class: "pl" }, label, val), s));
  }
  const color = h("input", { type: "color", style: { width: "100%", height: "38px", padding: "2px" } });
  color.addEventListener("input", () => { params.color = color.value; changed(); });
  const dirSeg = h("div", { class: "seg" });
  ["forward", "reverse"].forEach((d) => {
    const b = h("button", null, d === "forward" ? "Forward" : "Reverse");
    b.dataset.d = d;
    b.addEventListener("click", () => { params.direction = d; changed(); update(); });
    dirSeg.append(b);
  });
  const scope = h("select");
  scope.addEventListener("change", () => { params.scope = scope.value; changed(); });
  grid.append(
    h("div", { class: "param" }, h("div", { class: "pl" }, "Colour"), color),
    h("div", { class: "param" }, h("div", { class: "pl" }, "Direction"), dirSeg),
    h("div", { class: "param" }, h("div", { class: "pl" }, "Lights"), scope));

  const startBtn = btn("Start", { cls: "primary", icon: "play", size: 16 }, () => start());
  const stopBtn = btn("Stop", { icon: "stop", size: 16 }, () => run("effect_stop"));
  const status = h("div", { class: "muted" });

  function start() {
    localStorage.setItem(KEY, JSON.stringify(params));
    run("effect_start", { ...params }).catch(() => {});
  }
  function changed() {
    localStorage.setItem(KEY, JSON.stringify(params));
    if (state.effect) throttleLatest("fx", () => run("effect_start", { ...params }), 250);
  }

  const el = h("section", { class: "stack" },
    h("div", null, h("div", { class: "section-title", style: { marginTop: 0 } }, h("h2", null, "Your lights, in order"), h("span", { class: "muted", style: { fontSize: "12.5px" } }, "Drag to set the order. Effects travel along it.")), strip),
    h("div", { class: "card" }, h("h3", null, "Effect"), fx),
    h("div", { class: "card" }, h("h3", null, "Fine-tune"), grid),
    h("div", { class: "row" }, startBtn, stopBtn, status));

  function update() {
    const lights = state.devices.filter((d) => d.kind === "light" && d.driver === "wiz");
    reconcile(strip, lights, (d) => d.id,
      () => {
        const orb = h("div", { class: "orb" }), n = h("div", { class: "bn" }), i = h("div", { class: "bi" });
        const b = h("div", { class: "bulb" }, orb, n, i);
        b._r = { n, i };
        return b;
      },
      (b, d) => {
        const l = L(d.id);
        const c = glowColor(d, l) || "#ffe2a8";
        b.style.setProperty("--c", c);
        setClass(b, "on", !!l.on && !!l.online);
        if (l.on && l.brightness != null) b.firstChild.style.opacity = 0.35 + (l.brightness / 100) * 0.65;
        else b.firstChild.style.opacity = "";
        setText(b._r.n, d.name);
        setText(b._r.i, String(lights.indexOf(d) + 1));
      });
    none.style.display = lights.length ? "none" : "";
    if (strip.lastElementChild !== none) strip.append(none);
    // effects
    reconcile(fx, state.effects, (e) => e.id,
      () => { const b = h("button", null, h("div", { class: "fn" }), h("div", { class: "fd" })); b.addEventListener("click", () => { params.effect = b._e.id; changed(); update(); }); return b; },
      (b, e) => { b._e = e; setText(b.firstChild, e.name); setText(b.lastChild, e.desc); setClass(b, "active", params.effect === e.id); });
    for (const [k, , , , , fmt] of PARAMS) { setSlider(sliders[k], params[k]); values[k].textContent = fmt(params[k]); }
    if (color.value !== params.color) color.value = params.color;
    dirSeg.querySelectorAll("button").forEach((b) => setClass(b, "active", b.dataset.d === params.direction));
    const opts = ["all", "favorites", ...state.rooms.map((r) => "room:" + r)];
    const sig = opts.join("|");
    if (scope.dataset.sig !== sig) {
      scope.dataset.sig = sig;
      scope.replaceChildren(...opts.map((o) => h("option", { value: o }, o === "all" ? "All lights" : o === "favorites" ? "Favourites" : "Room: " + o.slice(5))));
    }
    scope.value = params.scope;
    const running = !!state.effect;
    startBtn.style.display = running ? "none" : "";
    stopBtn.style.display = running ? "" : "none";
    setText(status, running ? `Running ${state.effect.effect}. Changes apply live.` : "Frames are written straight to the lights, so what you see here is what they do.");
  }
  return { el, update };
}
