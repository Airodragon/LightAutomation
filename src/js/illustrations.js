// Empty-state SVGs — same stroke language as icons in dom.js.
import { h } from "./dom.js";

const ATTR = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.6",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

function svg(paths, size = 64) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("viewBox", "0 0 64 64");
  el.setAttribute("aria-hidden", "true");
  el.classList.add("illust");
  for (const [tag, attrs] of paths) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries({ ...ATTR, ...attrs })) n.setAttribute(k, v);
    el.append(n);
  }
  return el;
}

/** Calm house silhouette for “no devices”. */
export function illustHouse(size = 64) {
  return svg([
    ["path", { d: "M10 30 L32 12 L54 30" }],
    ["path", { d: "M16 28 V50 H48 V28" }],
    ["path", { d: "M26 50 V36 H38 V50" }],
    ["circle", { cx: "40", cy: "38", r: "1.2", fill: "currentColor", stroke: "none" }],
  ], size);
}

/** Camera body with a slash for offline / no cams. */
export function illustNoCamera(size = 64) {
  return svg([
    ["rect", { x: "12", y: "20", width: "32", height: "24", rx: "4" }],
    ["path", { d: "M44 28 L54 22 V42 L44 36" }],
    ["circle", { cx: "28", cy: "32", r: "6" }],
    ["path", { d: "M14 50 L50 14" }],
  ], size);
}

/** Two dots / missing peer for Calls empty. */
export function illustNoPeer(size = 64) {
  return svg([
    ["circle", { cx: "24", cy: "24", r: "8" }],
    ["path", { d: "M10 46c2-8 10-12 14-12s12 4 14 12" }],
    ["circle", { cx: "46", cy: "24", r: "6", "stroke-dasharray": "3 3" }],
    ["path", { d: "M38 46c1-5 5-8 8-8", "stroke-dasharray": "3 3" }],
  ], size);
}

export function emptyBlock({ title, body, illust, actions = [] }) {
  return h("div", { class: "empty empty-illust" },
    illust,
    h("h3", null, title),
    body ? h("p", null, body) : null,
    actions.length
      ? h("div", { class: "row", style: { justifyContent: "center", marginTop: "14px" } }, ...actions)
      : null);
}
