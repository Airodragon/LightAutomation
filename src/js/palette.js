// Command palette (Cmd/Ctrl+K): jump to a page, toggle a device, apply a scene.
import { h, icon, overlayPanel, closeOverlay } from "./dom.js";
import { state, L } from "./store.js";
import { toggleDevice, applyScene, setDevice } from "./actions.js";
import { openAddDevice } from "./views/devices.js";

// Subsequence match with a small bonus for prefix / word-start hits. Returns -1 for no match.
function score(q, text) {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 ? 20 : 0);
  let ti = 0;
  let sc = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    sc += f === ti ? 3 : 1;
    ti = f + 1;
  }
  return sc;
}

export function openPalette({ routes, go, kiosk, theme }) {
  const items = [];
  const add = (group, title, sub, ic, run) => items.push({ group, title, sub, ic, run });

  for (const [id, name, ic] of routes) add("Go to", name, "", ic, () => go(id));
  for (const sc of state.scenes) add("Scenes", sc.name, "Apply scene", sc.icon || "sparkles", () => applyScene(sc));
  for (const d of state.devices) {
    if (!d.caps.includes("onoff")) continue;
    const l = L(d.id);
    add("Devices", d.name, `${d.room || "No room"} · ${l.online ? (l.on ? "On" : "Off") : "Offline"}`, d.kind === "plug" ? "plug" : "bulb", () => toggleDevice(d.id));
  }
  const all = (on) => () => state.devices.forEach((d) => ["light", "plug", "switch"].includes(d.kind) && d.caps.includes("onoff") && setDevice(d.id, { on }));
  add("Actions", "Turn everything on", "", "sun", all(true));
  add("Actions", "Turn everything off", "", "power", all(false));
  add("Actions", "Add device", "Scan, by IP or Home Assistant", "plus", () => openAddDevice("scan"));
  add("Actions", "Toggle screen mode", "Wall display", "fullscreen", kiosk);
  add("Actions", "Show screensaver", "Ambient clock", "moon", () => {
    import("./app.js").then((m) => m.startScreensaver());
  });
  add("Actions", "Toggle theme", "Dark or light", "moon", theme);

  const input = h("input", { type: "search", placeholder: "Search devices, scenes, pages…", "aria-label": "Command palette", autocomplete: "off", spellcheck: false });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" }, h("span", null, "↑↓ move"), h("span", null, "↵ run"), h("span", null, "esc close"));
  const el = h("div", { class: "palette" }, input, list, foot);
  let shown = [];
  let active = 0;

  const run = (it) => { closeOverlay(); it && it.run(); };

  function paint() {
    const q = input.value.trim().toLowerCase();
    shown = items
      .map((it) => ({ it, s: Math.max(score(q, it.title), q ? score(q, `${it.group} ${it.title}`) - 5 : 0) }))
      .filter((x) => x.s >= 0 && (!q || x.s > 0))
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 40)
      .map((x) => x.it);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren();
    if (!shown.length) { list.append(h("div", { class: "pal-empty" }, "No matches")); return; }
    let lastGroup = "";
    shown.forEach((it, i) => {
      if (!q && it.group !== lastGroup) { lastGroup = it.group; list.append(h("div", { class: "pal-group" }, it.group)); }
      const b = h("button", { class: "pal-item" + (i === active ? " active" : ""), role: "option", "aria-selected": String(i === active) },
        icon(it.ic, 16), h("span", { class: "pt" }, it.title), it.sub ? h("span", { class: "ps" }, it.sub) : null);
      b.addEventListener("click", () => run(it));
      b.addEventListener("pointermove", () => { if (active !== i) { active = i; mark(); } });
      list.append(b);
    });
  }
  function mark() {
    const rows = list.querySelectorAll(".pal-item");
    rows.forEach((r, i) => { r.classList.toggle("active", i === active); r.setAttribute("aria-selected", String(i === active)); });
    rows[active] && rows[active].scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("input", () => { active = 0; paint(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[active]); }
  });
  overlayPanel(el);
  paint();
  setTimeout(() => input.focus(), 0);
}
