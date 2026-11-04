// Device detail drawer.
import { h, icon, kindIcon, drawer, closeOverlay, setText, setClass, btn, confirmBox } from "../dom.js";
import { state, L, getDevice } from "../store.js";
import { setDevice, describe, fmtW, run } from "../actions.js";
import { toggle, slider, setSlider, colorControls, glowFor } from "../components.js";
import { fmtEnergy } from "../charts.js";

let cur = null;

export function openDetail(id) {
  const d = getDevice(id);
  if (!d) return;
  state.ui.detail = id;
  const r = {};
  r.id = id;
  r.icon = h("div", { class: "dev-icon", style: { width: "48px", height: "48px" } });
  r.name = h("input", { type: "text", style: { fontSize: "18px", fontWeight: "700", background: "transparent", border: "1px solid transparent", padding: "6px 8px" } });
  r.name.addEventListener("focus", () => (r.name.style.borderColor = "var(--accent)"));
  r.name.addEventListener("blur", () => {
    r.name.style.borderColor = "transparent";
    const v = r.name.value.trim();
    const dev = getDevice(id);
    if (v && dev && v !== dev.name) run("device_update", { id, name: v });
  });
  r.name.addEventListener("keydown", (e) => e.key === "Enter" && r.name.blur());
  r.status = h("div", { class: "muted" });
  r.tg = toggle();
  r.tg.addEventListener("click", () => setDevice(id, { on: !L(id).on }));

  const header = h(
    "div",
    { class: "row" },
    r.icon,
    h("div", { class: "grow" }, r.name, r.status),
    h("button", { class: "btn icon ghost", onClick: () => closeOverlay() }, icon("close", 20))
  );

  const power = h("div", { class: "card row" }, h("div", { class: "grow" }, h("div", { class: "t", style: { fontWeight: "700" } }, "Power"), r.status2 = h("div", { class: "muted", style: { fontSize: "12.5px" } })), r.tg);

  const sections = [header, power];

  if (d.caps.includes("dim")) {
    r.bri = slider({ min: 1, max: 100, onInput: (v) => { setDevice(id, { brightness: v }); r.briV.textContent = v + "%"; } });
    r.briV = h("b");
    sections.push(h("div", { class: "card" }, h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } }, h("h3", { style: { margin: 0 } }, "Brightness"), r.briV), r.bri));
  }
  if (d.caps.includes("temp")) {
    r.temp = slider({ min: 2200, max: 6500, step: 50, cls: "temp", onInput: (v) => { setDevice(id, { temp: v }); r.tempV.textContent = v + "K"; } });
    r.tempV = h("b");
    const presets = h(
      "div",
      { class: "row wrap", style: { marginTop: "10px" } },
      ...[["Candle", 2200], ["Warm", 2700], ["Neutral", 4000], ["Cool", 5000], ["Daylight", 6500]].map(([n, k]) => btn(n, { cls: "small" }, () => setDevice(id, { temp: k })))
    );
    sections.push(h("div", { class: "card" }, h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } }, h("h3", { style: { margin: 0 } }, "White temperature"), r.tempV), r.temp, presets));
  }
  if (d.caps.includes("color")) {
    const cc = colorControls(d);
    sections.push(h("div", { class: "card" }, h("h3", null, "Colour"), cc.node));
  }
  if (d.caps.includes("scene") && state.wiz_scenes.length) {
    r.scene = h("select", null, h("option", { value: "" }, "Pick a scene…"), ...state.wiz_scenes.map((s) => h("option", { value: s.id }, s.name)));
    r.scene.addEventListener("change", () => r.scene.value && setDevice(id, { scene_id: +r.scene.value }));
    sections.push(h("div", { class: "card" }, h("h3", null, "Light scene"), r.scene));
  }
  if (d.kind === "plug" || d.caps.includes("power")) {
    r.watts = h("div", { style: { fontSize: "34px", fontWeight: "700", letterSpacing: "-0.02em" } });
    r.life = h("div", { class: "muted" });
    sections.push(h("div", { class: "card" }, h("h3", null, "Energy"), r.watts, r.life));
  }
  if (d.kind === "climate") {
    r.tc = h("b", { style: { fontSize: "26px" } });
    const adj = (dv) => () => setDevice(id, { target: Math.round(((L(id).target ?? 21) + dv) * 2) / 2 });
    sections.push(h("div", { class: "card row", style: { justifyContent: "space-between" } }, btn("−", { cls: "icon" }, adj(-0.5)), r.tc, btn("+", { cls: "icon" }, adj(0.5))));
  }

  // organise
  r.room = h("select", null, h("option", { value: "" }, "No room"));
  r.room.addEventListener("change", () => run("device_update", { id, room: r.room.value }));
  r.fav = btn("", { cls: "small" }, () => run("device_update", { id, favorite: !getDevice(id).favorite }));
  r.note = h("textarea", { rows: 2, placeholder: "Notes (where is it, what is it for…)" });
  r.note.addEventListener("blur", () => { const dev = getDevice(id); if (dev && dev.note !== r.note.value) run("device_update", { id, note: r.note.value }); });
  const blink = d.kind === "light" ? btn("Blink to find", { cls: "small", icon: "bulb", size: 15 }, () => blinkDevice(id)) : null;
  sections.push(h("div", { class: "card form" },
    h("label", { class: "field" }, "Room", r.room),
    h("div", { class: "row" }, r.fav, blink),
    h("label", { class: "field" }, "Notes", r.note)));

  r.info = h("dl", { class: "kv" });
  sections.push(h("div", { class: "card" }, h("h3", null, "Details"), r.info));
  sections.push(h("div", { class: "row" }, btn("Remove device", { cls: "danger", icon: "trash", size: 16 }, () =>
    confirmBox("Remove device?", `${getDevice(id).name} will be removed from this hub. It can be added again by scanning.`, "Remove", async () => {
      await run("device_remove", { id });
      closeOverlay();
    }))));

  const el = h("div", null, ...sections);
  r.el = el;
  cur = r;
  drawer(el, () => { cur = null; state.ui.detail = null; });
  refreshDetail();
}

async function blinkDevice(id) {
  const was = !!L(id).on;
  for (let i = 0; i < 3; i++) {
    setDevice(id, { on: true, brightness: 100 });
    await new Promise((r) => setTimeout(r, 450));
    setDevice(id, { on: false });
    await new Promise((r) => setTimeout(r, 450));
  }
  setDevice(id, { on: was });
}

export function refreshDetail() {
  if (!cur) return;
  const d = getDevice(cur.id);
  if (!d) { closeOverlay(); return; }
  const l = L(d.id);
  const r = cur;
  r.icon.replaceChildren(icon(kindIcon(d.kind), 24));
  setClass(r.icon, "on-glow", false);
  if (l.on && l.online) {
    r.icon.style.background = glowFor(d, l);
    r.icon.style.color = "#1a1a1a";
  } else {
    r.icon.style.background = "";
    r.icon.style.color = "";
  }
  if (document.activeElement !== r.name) r.name.value = d.name;
  setText(r.status, describe(d, l));
  setText(r.status2, l.online ? (l.on ? "On" : "Off") : "Offline");
  setClass(r.tg, "on", !!l.on);
  if (r.bri) { setSlider(r.bri, l.brightness ?? 50); r.briV.textContent = (l.brightness ?? "–") + "%"; }
  if (r.temp) { setSlider(r.temp, l.temp ?? 2700); r.tempV.textContent = l.temp ? l.temp + "K" : "–"; }
  if (r.scene && document.activeElement !== r.scene) r.scene.value = l.scene_id || "";
  if (r.watts) {
    r.watts.textContent = l.watts != null ? fmtW(l.watts) : d.power_supported ? "–" : "Not metered";
    r.life.textContent = `Lifetime ${fmtEnergy(d.energy_wh_lifetime || 0)}`;
  }
  if (r.tc) r.tc.textContent = l.target != null ? `${l.target}° (now ${l.current ?? "–"}°)` : "–";
  // rooms list
  const want = ["", ...state.rooms];
  const have = Array.from(r.room.options).map((o) => o.value);
  if (want.join("|") !== have.join("|")) {
    r.room.replaceChildren(...want.map((n) => h("option", { value: n }, n || "No room")));
  }
  r.room.value = d.room || "";
  r.fav.replaceChildren(icon("star", 15), d.favorite ? "Favourite" : "Add to favourites");
  setClass(r.fav, "primary", d.favorite);
  if (document.activeElement !== r.note) r.note.value = d.note || "";
  const rows = [
    ["Driver", { wiz: "WiZ (local)", ha: "Home Assistant", net: "Network" }[d.driver] || d.driver],
    ["Address", d.ip ? d.ip + (d.port ? ":" + d.port : "") : "–"],
    ["MAC", d.mac || "–"],
    ["Module", d.module || "–"],
    ["Firmware", d.fw || "–"],
    ["Signal", l.rssi != null ? l.rssi + " dBm" : "–"],
    ["Entity", d.ha_entity || null],
  ].filter((x) => x[1] !== null);
  const sig = rows.map((x) => x.join("=")).join("|");
  if (r.sig !== sig) {
    r.sig = sig;
    r.info.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }
}
