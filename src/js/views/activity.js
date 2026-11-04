// Recent activity feed (what the hub saw: lights on/off, scenes, devices dropping off).
import { h, icon, reconcile, setText } from "../dom.js";
import { call } from "../api.js";

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function createActivity(limit = 8) {
  const list = h("ul", { class: "feed" });
  const empty = h("p", { class: "muted", style: { padding: "6px 0" } }, "Nothing yet. Changes to your lights will show up here.");
  const el = h("div", { class: "panel" },
    h("div", { class: "panel-head" }, icon("activity", 16), h("h3", null, "Activity")),
    list, empty);
  let last = 0;
  let busy = false;
  let items = [];

  function paint() {
    empty.style.display = items.length ? "none" : "";
    reconcile(list, items, (e) => `${e.ts}:${e.id}:${e.text}`,
      (e) => h("li", null, h("span", { class: "fdot" }), h("span", { class: "ft" }), h("time")),
      (li, e) => {
        li.firstChild.className = `fdot ${e.kind}`;
        const ft = li.querySelector(".ft");
        const sig = `${e.name}|${e.text}`;
        if (ft.dataset.sig !== sig) {
          ft.dataset.sig = sig;
          ft.replaceChildren(...(e.name ? [h("b", null, e.name), ` ${e.text}`] : [e.text[0].toUpperCase() + e.text.slice(1)]));
        }
        const t = li.querySelector("time");
        setText(t, ago(e.ts));
        t.dateTime = new Date(e.ts).toISOString();
      });
  }

  async function refresh(force = false) {
    if (busy || (!force && Date.now() - last < 5000)) { paint(); return; }
    busy = true;
    last = Date.now();
    try { items = await call("activity", { limit }); } catch (_) {}
    busy = false;
    paint();
  }
  return { el, refresh };
}
