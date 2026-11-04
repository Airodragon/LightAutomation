import { h, icon, reconcile, setText, setClass, setAttr, btn } from "../dom.js";
import { state, stats, reorderLocal, refreshEnergy, refreshWeather, L } from "../store.js";
import { deviceCard, updateDeviceCard, toggle, slider, setSlider } from "../components.js";
import { makeSortable } from "../sortable.js";
import { applyScene, run, setDevice, fmtW, toggleDevice } from "../actions.js";
import { openAddDevice } from "./devices.js";
import { fmtEnergy } from "../charts.js";
import { onDrop } from "./rooms.js";
import { createPlan } from "./plan.js";
import { createClimate } from "./climate.js";
import { createActivity } from "./activity.js";
import { createNowPlaying, activeMedia } from "./nowplaying.js";
import { PRESENCE, presenceMode, setPresence } from "../wall.js";
import { call as hubCall } from "../api.js";

export function reorderSubset(keys) {
  const all = state.devices.map((d) => d.id);
  const slots = all.map((id, i) => (keys.includes(id) ? i : -1)).filter((i) => i >= 0);
  const out = [...all];
  slots.forEach((slot, i) => (out[slot] = keys[i]));
  reorderLocal(out);
  run("devices_reorder", { ids: out }).catch(() => {});
}

export function filterDevices(room) {
  let list = state.devices;
  if (room === "fav") list = list.filter((d) => d.favorite);
  else if (room === "unassigned") list = list.filter((d) => !d.room);
  else if (room !== "all") list = list.filter((d) => d.room === room);
  return list;
}

function roomIcon(name) {
  if (/bed|sleep|guest/i.test(name)) return "moon";
  if (/living|lounge|tv|family/i.test(name)) return "sofa";
  if (/kitchen|dining/i.test(name)) return "sparkles";
  if (/office|study|work/i.test(name)) return "devices";
  if (/fav/i.test(name)) return "star";
  return "rooms";
}

// ---------- room section ----------

function makeSection() {
  const ic = h("div", { class: "room-ico" });
  const title = h("h3");
  const sub = h("div", { class: "sub" });
  const master = slider({ min: 1, max: 100, onInput: (v) => {
    for (const d of sec._devs) if (d.caps.includes("dim") && d.kind === "light") setDevice(d.id, { brightness: v });
  } });
  master.classList.add("master", "no-drag");
  master.title = "Room brightness";
  const tg = toggle();
  const tiles = h("div", { class: "tiles" });
  const sec = h("div", { class: "room-sec" },
    h("div", { class: "room-sec-head" }, ic, h("div", { class: "grow" }, title, sub), master, tg),
    tiles);
  sec._r = { ic, title, sub, master, tg, tiles, icon: null };
  sec._devs = [];
  tg.addEventListener("click", () => {
    const on = !sec._anyOn;
    for (const d of sec._devs) if (d.caps.includes("onoff")) setDevice(d.id, { on });
  });
  makeSortable(tiles, { item: ".dev", group: "dash", onDrop });
  return sec;
}

function updateSection(sec, s) {
  const r = sec._r;
  const devs = s.devices;
  sec._devs = devs;
  const on = devs.filter((d) => L(d.id).on && L(d.id).online);
  sec._anyOn = on.length > 0;
  const watts = devs.reduce((a, d) => a + (L(d.id).online ? L(d.id).watts || 0 : 0), 0);
  const ico = roomIcon(s.name);
  if (r.icon !== ico) { r.icon = ico; r.ic.replaceChildren(icon(ico, 18)); }
  setText(r.title, s.name);
  setText(r.sub, `${devs.length} device${devs.length === 1 ? "" : "s"} · ${on.length} on${watts > 0 ? " · " + fmtW(watts) : ""}`);
  setClass(r.tg, "on", sec._anyOn);
  setAttr(r.tg, "aria-pressed", String(sec._anyOn));
  setAttr(r.tg, "aria-label", `Toggle all in ${s.name}`);
  setAttr(r.master, "aria-label", `${s.name} brightness`);
  r.tg.style.display = devs.some((d) => d.caps.includes("onoff")) ? "" : "none";
  const lights = devs.filter((d) => d.kind === "light" && d.caps.includes("dim") && L(d.id).online);
  r.master.style.display = lights.length > 1 ? "" : "none";
  if (lights.length) {
    const lit = lights.filter((d) => L(d.id).on);
    const pool = lit.length ? lit : lights;
    setSlider(r.master, Math.round(pool.reduce((a, d) => a + (L(d.id).brightness || 50), 0) / pool.length));
  }
  sec.dataset.roomKey = s.key;
  r.tiles.dataset.room = s.virtual ? "__virtual__" : s.name === "No room" ? "" : s.name;
  reconcile(r.tiles, devs, (d) => d.id, deviceCard, updateDeviceCard);
}

// ---------- hub bits ----------

function kpi(iconName, label) {
  const v = h("div", { class: "kv2" });
  const s = h("div", { class: "ks" });
  const el = h("div", { class: "kpi" }, h("div", { class: "kl" }, icon(iconName, 14), label), v, s);
  el._v = v;
  el._s = s;
  return el;
}

function setKpi(el, value, unit, sub) {
  const sig = `${value}|${unit}`;
  if (el._v.dataset.sig !== sig) {
    el._v.dataset.sig = sig;
    el._v.replaceChildren(String(value), unit ? h("small", null, unit) : "");
  }
  setText(el._s, sub);
}

function chipCard() {
  const ico = h("div", { class: "chip-ico" });
  const name = h("div", { class: "chip-name" });
  const sub = h("div", { class: "chip-sub" });
  const el = h("button", { class: "hub-chip", type: "button" }, ico, h("div", { class: "grow" }, name, sub));
  el._r = { ico, name, sub, id: null, kind: null };
  el.addEventListener("click", () => { if (el._r.id) toggleDevice(el._r.id); });
  return el;
}

function updateChip(el, d) {
  const l = L(d.id);
  const r = el._r;
  r.id = d.id;
  if (r.kind !== d.kind) {
    r.kind = d.kind;
    r.ico.replaceChildren(icon(d.kind === "plug" || d.kind === "switch" ? "plug" : "bulb", 16));
  }
  setText(r.name, d.name);
  const on = !!(l.on && l.online);
  setClass(el, "on", on);
  setClass(el, "off", l.online && !l.on);
  setClass(el, "offline", !l.online);
  let line = !l.online ? "Offline" : on ? "On" : "Off";
  if (on && d.kind === "light" && l.brightness != null) line = `${Math.round(l.brightness)}%`;
  if (on && l.watts != null) line += ` · ${fmtW(l.watts)}`;
  if (d.room) line = `${d.room} · ${line}`;
  setText(r.sub, line);
  setAttr(el, "aria-pressed", String(on));
  setAttr(el, "aria-label", `Toggle ${d.name}`);
}

function pickQuick(kind, limit) {
  const match = (d) => {
    if (kind === "light") return d.kind === "light";
    if (kind === "plug") return d.kind === "plug" || d.kind === "switch";
    return false;
  };
  const list = state.devices.filter(match);
  const fav = list.filter((d) => d.favorite);
  const on = list.filter((d) => L(d.id).on && L(d.id).online);
  const pool = fav.length ? fav : on.length ? on : list;
  return pool.slice(0, limit);
}

// ---------- dashboard ----------

export function createDashboard() {
  const banners = h("div", { class: "banners" });

  // Hero: time + weather
  const clockTime = h("div", { class: "hub-clock-time" });
  const clockDate = h("div", { class: "hub-clock-date" });
  const clockGreeting = h("div", { class: "hub-greeting muted" });
  const clockCard = h("div", { class: "panel hub-clock s6" },
    clockGreeting, clockTime, clockDate);

  const wTemp = h("div", { class: "hero-temp" });
  const wLabel = h("div", { class: "hero-wlabel" });
  const wRange = h("div", { class: "hero-range muted" });
  const wStatus = h("div", { class: "hero-status" });
  const weatherHero = h("div", { class: "panel weather-hero s6" },
    h("div", { class: "grow" }, wTemp, wLabel, wRange),
    wStatus);

  const presenceBar = h("div", { class: "s12 presence-bar" });
  const nowPlaying = createNowPlaying();
  const npWrap = h("div", { class: "s12" }, nowPlaying.el);

  const boardList = h("ul", { class: "board-list" });
  const boardInput = h("input", { type: "text", placeholder: "Add a note for the household…", class: "board-input" });
  boardInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const t = boardInput.value.trim();
    if (!t) return;
    const notes = [...(state.settings.board_notes || []), t];
    boardInput.value = "";
    try {
      await hubCall("board_set", { notes });
    } catch (_) {}
  });
  const boardPanel = h("div", { class: "panel hub-panel s6" },
    h("div", { class: "panel-head" }, icon("edit", 16), h("h3", null, "Family board"), h("div", { class: "grow" }),
      btn("Call", { cls: "small", icon: "media", size: 14 }, () => { location.hash = "#/call"; }),
      btn("Cams", { cls: "small", icon: "film", size: 14 }, () => { location.hash = "#/cameras"; })),
    boardList, boardInput);

  const securityGlance = h("div", { class: "panel hub-panel s6" },
    h("div", { class: "panel-head" }, icon("power", 16), h("h3", null, "Security"), h("div", { class: "grow" }),
      btn("Open", { cls: "small" }, () => { location.hash = "#/cameras"; })),
    h("div", { class: "security-glance" }));

  const kLights = kpi("bulb", "Lights");
  const kPlugs = kpi("plug", "Plugs");
  const kPower = kpi("energy", "Power");
  const kOnline = kpi("wifi", "Online");

  const lightsGrid = h("div", { class: "hub-chips" });
  const plugsGrid = h("div", { class: "hub-chips" });
  const lightsPanel = h("div", { class: "panel hub-panel s6" },
    h("div", { class: "panel-head" },
      icon("bulb", 16), h("h3", null, "Lights"), h("div", { class: "grow" }),
      btn("All on", { cls: "small", icon: "sun", size: 14 }, () => kindSet("light", true)),
      btn("Off", { cls: "small", icon: "power", size: 14 }, () => kindSet("light", false))),
    lightsGrid,
    h("p", { class: "hub-empty muted" }, "No lights yet"));
  const plugsPanel = h("div", { class: "panel hub-panel s6" },
    h("div", { class: "panel-head" },
      icon("plug", 16), h("h3", null, "Plugs & switches"), h("div", { class: "grow" }),
      btn("All on", { cls: "small" }, () => kindSet("plug", true)),
      btn("Off", { cls: "small" }, () => kindSet("plug", false))),
    plugsGrid,
    h("p", { class: "hub-empty muted" }, "No plugs yet"));

  const scenesRow = h("div", { class: "scene-row" });
  const scenesWrap = h("div", { class: "s12" },
    h("div", { class: "section-title" }, h("h2", null, "Scenes")),
    scenesRow);

  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Room filter" });
  const sections = h("div", { class: "rooms-wrap" });
  const empty = h("div", { class: "empty" },
    h("h3", null, "No devices yet"),
    h("p", null, "Scan your network to find WiZ lights and plugs, or connect Home Assistant."),
    h("div", { class: "row", style: { justifyContent: "center", marginTop: "14px" } },
      btn("Scan network", { cls: "primary", icon: "search", size: 16 }, () => openAddDevice("scan")),
      btn("Add by IP", { icon: "plus", size: 16 }, () => openAddDevice("ip"))));

  const plan = createPlan((key) => {
    const target = key === "__none" ? "unassigned" : key;
    state.ui.room = state.ui.room === target ? "all" : target;
    update();
    requestAnimationFrame(() => {
      const sec = sections.querySelector(`[data-room-key="${CSS.escape(key)}"]`) || sections.firstElementChild;
      if (sec) {
        sec.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        sec.classList.add("flash");
        setTimeout(() => sec.classList.remove("flash"), 900);
      }
    });
  });
  const climate = createClimate();
  const activity = createActivity(8);

  const planWrap = h("div", { class: "s8" }, plan.el);
  const side = h("div", { class: "s4 col" }, climate.el, activity.el);
  const roomsHead = h("div", { class: "s12" },
    h("div", { class: "section-title", style: { flexWrap: "wrap" } },
      h("h2", null, "Rooms"), tabs, h("div", { class: "grow" }),
      btn("All on", { cls: "small", icon: "sun", size: 14 }, () => allSet(true)),
      btn("All off", { cls: "small", icon: "power", size: 14 }, () => allSet(false))));

  const el = h("section", { class: "home" },
    h("div", { class: "s12" }, banners),
    presenceBar,
    clockCard,
    weatherHero,
    npWrap,
    h("div", { class: "s12 kpis" }, kLights, kPlugs, kPower, kOnline),
    boardPanel,
    securityGlance,
    lightsPanel,
    plugsPanel,
    scenesWrap,
    planWrap, side,
    roomsHead,
    h("div", { class: "s12" }, sections, empty));

  function kindSet(kind, on) {
    for (const d of state.devices) {
      const match = kind === "light" ? d.kind === "light" : d.kind === "plug" || d.kind === "switch";
      if (match && d.caps.includes("onoff")) setDevice(d.id, { on });
    }
  }

  function allSet(on) {
    for (const d of state.devices) if (["light", "plug", "switch"].includes(d.kind) && d.caps.includes("onoff")) setDevice(d.id, { on });
  }

  function greeting(h) {
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 21) return "Good evening";
    return "Good night";
  }

  let lastEnergy = 0;
  let lastActSig = "";
  let lastClockMin = "";

  function update() {
    const s = stats();
    const e = state.energy;
    const lights = state.devices.filter((d) => d.kind === "light");
    const plugs = state.devices.filter((d) => d.kind === "plug" || d.kind === "switch");
    const metered = state.devices.some((d) => L(d.id).online && L(d.id).watts != null);

    // Clock
    const now = new Date();
    const minKey = `${now.getHours()}:${now.getMinutes()}`;
    if (minKey !== lastClockMin) {
      lastClockMin = minKey;
      setText(clockTime, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setText(clockDate, now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
      setText(clockGreeting, greeting(now.getHours()));
    }

    // Weather
    refreshWeather();
    const w = state.weather;
    if (w && w.temp != null) {
      const unit = w.units === "F" ? "°F" : "°C";
      wTemp.replaceChildren(String(Math.round(w.temp)), h("small", null, unit));
      setText(wLabel, w.label || "");
      setText(wRange, w.high != null ? `H ${Math.round(w.high)}${unit} · L ${Math.round(w.low)}${unit}` : "");
      if (w.period) document.documentElement.dataset.period = w.period;
    } else {
      setText(wTemp, "–");
      setText(wLabel, "Weather");
      setText(wRange, "Fetching…");
    }
    const media = activeMedia();
    const bits = [];
    if (s.on) bits.push(`${s.on} light${s.on === 1 ? "" : "s"} on`);
    const plugsOn = plugs.filter((d) => L(d.id).on && L(d.id).online).length;
    if (plugsOn) bits.push(`${plugsOn} plug${plugsOn === 1 ? "" : "s"} on`);
    if (media && media.playing) bits.push(media.app ? `♪ ${media.app}` : "Playing");
    setText(wStatus, bits.join(" · ") || "All quiet");

    nowPlaying.update();

    // Presence
    const mode = presenceMode();
    reconcile(presenceBar, PRESENCE, (p) => p.id,
      () => {
        const b = h("button", { class: "presence-chip", type: "button" });
        b.addEventListener("click", () => setPresence(b._p.id));
        return b;
      },
      (b, p) => {
        b._p = p;
        setText(b, p.label);
        setClass(b, "on", mode === p.id);
      });

    // Family board
    const notes = state.settings.board_notes || [];
    reconcile(boardList, notes.map((t, i) => ({ id: String(i), t })), (n) => n.id,
      () => {
        const li = h("li", null, h("span", { class: "grow" }), h("button", { class: "btn icon ghost", type: "button", title: "Remove" }, "×"));
        li.querySelector("button").addEventListener("click", async () => {
          const cur = state.settings.board_notes || [];
          const next = cur.filter((_, i) => String(i) !== li._id);
          try { await hubCall("board_set", { notes: next }); } catch (_) {}
        });
        return li;
      },
      (li, n) => { li._id = n.id; setText(li.querySelector("span"), n.t); });

    // Security glance
    const sg = securityGlance.querySelector(".security-glance");
    const alarms = state.devices.filter((d) => d.kind === "alarm" || d.caps.includes("alarm"));
    const locks = state.devices.filter((d) => d.kind === "lock" || d.caps.includes("lock"));
    const cams = state.devices.filter((d) => d.kind === "camera" || d.caps.includes("camera"));
    const secBits = [];
    if (alarms.length) {
      const a = alarms[0];
      const l = L(a.id);
      secBits.push(h("div", null, h("b", null, a.name), " · ", l.value || (l.on ? "armed" : "disarmed")));
    }
    if (locks.length) secBits.push(h("div", { class: "muted" }, `${locks.filter((d) => L(d.id).on || L(d.id).value === "locked").length}/${locks.length} locked`));
    if (cams.length) secBits.push(h("div", { class: "muted" }, `${cams.length} camera${cams.length === 1 ? "" : "s"}`));
    if (!secBits.length) secBits.push(h("p", { class: "muted" }, "Import locks, alarms and cameras from Home Assistant."));
    sg.replaceChildren(...secBits);

    // Ambient kiosk: hide dense admin until Control
    setClass(el, "ambient", !!state.ui.kiosk);

    // KPIs
    const litRooms = [...new Set(lights.filter((d) => L(d.id).on && L(d.id).online).map((d) => d.room || "No room"))];
    setKpi(kLights, s.on, `/ ${s.lights}`, litRooms.length ? litRooms.slice(0, 3).join(", ") : s.lights ? "Everything off" : "No lights");
    setKpi(kPlugs, plugsOn, `/ ${plugs.length}`, plugs.length ? (plugsOn ? "Active" : "All off") : "None yet");
    setKpi(kPower, e ? fmtW(e.live_watts) : fmtW(s.watts), "", e ? `${e.currency}${e.cost_today.toFixed(2)} today` : metered ? "Live draw" : "No meters");
    const offline = state.devices.filter((d) => !L(d.id).online);
    setKpi(kOnline, `${s.online}`, `/ ${s.total}`, offline.length ? `${offline.slice(0, 2).map((d) => d.name).join(", ")} offline` : s.total ? "All reachable" : "");
    kOnline.querySelector(".kl").style.color = offline.length ? "var(--warn)" : "";

    // Quick lights / plugs
    const qLights = pickQuick("light", 8);
    const qPlugs = pickQuick("plug", 8);
    lightsPanel.querySelector(".hub-empty").style.display = qLights.length ? "none" : "";
    plugsPanel.querySelector(".hub-empty").style.display = qPlugs.length ? "none" : "";
    lightsPanel.style.display = lights.length || plugs.length ? "" : "none";
    plugsPanel.style.display = plugs.length ? "" : lights.length ? "none" : "none";
    if (!lights.length && plugs.length) lightsPanel.style.display = "none";
    reconcile(lightsGrid, qLights, (d) => d.id, chipCard, updateChip);
    reconcile(plugsGrid, qPlugs, (d) => d.id, chipCard, updateChip);

    // banners
    const bsig = `${state.effect ? state.effect.effect : ""}|${state.candidates.length}`;
    if (banners.dataset.sig !== bsig) {
      banners.dataset.sig = bsig;
      banners.replaceChildren();
      if (state.effect) {
        banners.append(h("div", { class: "banner" }, icon("studio", 18), h("div", { class: "grow" }, h("b", null, `Effect running: ${state.effect.effect}`), h("span", { class: "muted" }, "  Any manual change stops it.")), btn("Stop", { cls: "small primary", icon: "stop", size: 14 }, () => run("effect_stop"))));
      }
      if (state.candidates.length) {
        banners.append(h("div", { class: "banner" }, icon("wifi", 18), h("div", { class: "grow" }, h("b", null, `${state.candidates.length} other device${state.candidates.length > 1 ? "s" : ""} found on your network`)), btn("Review", { cls: "small" }, () => openAddDevice("scan"))));
      }
      banners.parentElement.style.display = banners.firstChild ? "" : "none";
    }

    // scenes
    scenesWrap.style.display = state.scenes.length ? "" : "none";
    reconcile(scenesRow, state.scenes, (sc) => sc.id,
      (sc) => {
        const b = h("button", { class: "scene" }, h("div", { class: "si" }), h("div", null, h("div", { class: "sn" }), h("div", { class: "sd" })));
        b.addEventListener("click", () => applyScene(b._sc));
        return b;
      },
      (b, sc) => {
        b._sc = sc;
        if (b.dataset.icon !== sc.icon) { b.dataset.icon = sc.icon; b.querySelector(".si").replaceChildren(icon(sc.icon || "sparkles", 16)); }
        setText(b.querySelector(".sn"), sc.name);
        setText(b.querySelector(".sd"), sc.builtin ? "Built-in" : `${sc.items.length} devices`);
      });

    // rooms
    const tabItems = [{ id: "all", name: "All" }];
    if (state.devices.some((d) => d.favorite)) tabItems.push({ id: "fav", name: "Favourites" });
    state.rooms.forEach((r) => tabItems.push({ id: r, name: r }));
    if (state.devices.some((d) => !d.room)) tabItems.push({ id: "unassigned", name: "No room" });
    if (!tabItems.some((t) => t.id === state.ui.room)) state.ui.room = "all";
    reconcile(tabs, tabItems, (t) => t.id,
      () => {
        const b = h("button", { class: "tab", role: "tab" });
        b.addEventListener("click", () => { state.ui.room = b._t.id; update(); });
        return b;
      },
      (b, t) => { b._t = t; setText(b, t.name); setClass(b, "active", state.ui.room === t.id); setAttr(b, "aria-selected", String(state.ui.room === t.id)); });
    tabs.style.display = tabItems.length > 2 ? "" : "none";

    const allRooms = state.rooms.map((r) => ({ key: r, name: r, devices: state.devices.filter((d) => d.room === r) }));
    const loose = state.devices.filter((d) => !d.room);
    if (loose.length) allRooms.push({ key: "__none", name: "No room", devices: loose });
    const planRooms = allRooms.filter((r) => r.devices.length || state.devices.length === 0);
    planWrap.style.display = planRooms.length ? "" : "none";
    plan.update(planRooms, state.ui.room === "unassigned" ? "__none" : state.ui.room);

    const cur = state.ui.room;
    let secs;
    if (cur === "fav") secs = [{ key: "__fav", name: "Favourites", devices: state.devices.filter((d) => d.favorite), virtual: true }];
    else if (cur === "unassigned") secs = [{ key: "__none", name: "No room", devices: loose }];
    else if (cur !== "all") secs = allRooms.filter((r) => r.key === cur);
    else secs = allRooms;
    reconcile(sections, secs, (x) => x.key, makeSection, updateSection);
    empty.style.display = state.devices.length === 0 ? "" : "none";
    sections.style.display = state.devices.length === 0 ? "none" : "";
    roomsHead.style.display = state.devices.length === 0 ? "none" : "";

    climate.update(state.devices.filter((d) => d.kind === "climate"));
    const actSig = `${s.on}|${s.online}|${state.scenes.length}|${media ? media.title : ""}`;
    activity.refresh(actSig !== lastActSig);
    lastActSig = actSig;

    if (performance.now() - lastEnergy > 15000) { lastEnergy = performance.now(); refreshEnergy(); }
  }

  return { el, update };
}
