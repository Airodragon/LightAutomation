import { h, icon, setText, setClass, btn, modal, toast, closeOverlay } from "./dom.js";
import { state, subscribeStore, setSnapshot, applyLive, notify, stats, refreshWeather } from "./store.js";
import { call, subscribe, isTauri, setFullscreen, setPin, getPin, ping, AuthError } from "./api.js";
import { refreshDetail } from "./views/detail.js";
import { createDashboard } from "./views/dashboard.js";
import { createRooms } from "./views/rooms.js";
import { createDevices, openAddDevice } from "./views/devices.js";
import { createScenes } from "./views/scenes.js";
import { createAutomations } from "./views/automations.js";
import { createEnergy } from "./views/energy.js";
import { createStudio } from "./views/studio.js";
import { createSettings } from "./views/settings.js";
import { createMusic } from "./views/music.js";
import { createCameras } from "./views/cameras.js";
import { createCall } from "./views/call.js";
import { openPalette } from "./palette.js";
import { show as showScreensaver, hide as hideScreensaver, isOn as screensaverOn, refresh as refreshScreensaver } from "./screensaver.js";
import { registerWall, startHeartbeat } from "./wall.js";
import { initControlCenter, isControlOpen, closeControlCenter } from "./controlcenter.js";
import { wireHubEvents } from "./notify.js";

const ROUTES = [
  ["dashboard", "Home", "home", createDashboard],
  ["rooms", "Rooms", "rooms", createRooms],
  ["music", "Music", "media", createMusic],
  ["call", "Calls", "media", createCall],
  ["cameras", "Cameras", "film", createCameras],
  ["devices", "Devices", "devices", createDevices],
  ["scenes", "Scenes", "scenes", createScenes],
  ["automations", "Automations", "clock", createAutomations],
  ["energy", "Energy", "energy", createEnergy],
  ["studio", "Light Studio", "studio", createStudio],
  ["settings", "Settings", "settings", createSettings],
];

const SUBS = {
  rooms: "Drag devices between rooms",
  music: "Now playing and multi-room speakers",
  call: "In-app Home Call between wall screens and contacts",
  cameras: "Cameras, locks and alarm",
  devices: "Everything this hub knows about",
  scenes: "One tap moods for your home",
  automations: "Time, sun, presence and device rules",
  energy: "Power use and what it costs",
  studio: "Animate your lights in order",
  settings: "Appearance, wall screen and integrations",
};

const views = {};
let activeRoute = null;
let viewEl, titleEl, subEl, timeEl, dateEl, bannerEl, navEls = {};

function build() {
  const app = document.getElementById("app");
  const nav = h("nav", { class: "sidebar" },
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("bulb", 20)), "Lights Studio"));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const searchBtn = h("button", { class: "nav-item", title: "Search and commands", onClick: () => palette() },
    icon("search", 18), "Search", h("kbd", null, isMac ? "⌘K" : "Ctrl K"));
  nav.append(searchBtn);
  for (const [id, name, ic] of ROUTES) {
    const badge = h("span", { class: "badge", style: { display: "none" } });
    const b = h("button", { class: "nav-item", onClick: () => go(id) }, icon(ic, 20), name, badge);
    b._badge = badge;
    navEls[id] = b;
    nav.append(b);
  }
  const connDot = h("span", { class: "dot on" });
  const connText = h("span", null, "Connected");
  nav.append(h("div", { class: "spacer" }),
    h("button", { class: "nav-item", onClick: () => enterKiosk(), title: "Screen mode (⇧⌘F)" }, icon("fullscreen", 20), "Screen mode"),
    h("div", { class: "conn" }, connDot, connText));
  nav._conn = { connDot, connText };

  titleEl = h("h1");
  subEl = h("div", { class: "sub" });
  timeEl = h("div", { class: "time" });
  dateEl = h("div", { class: "date" });
  const exit = btn("Exit screen mode", { cls: "kiosk-only", icon: "close", size: 16 }, () => exitKiosk());
  const themeBtn = h("button", { class: "btn icon ghost", title: "Toggle theme", onClick: toggleTheme }, icon("sun", 20));
  const addBtn = btn("Add device", { cls: "primary nav-only", icon: "plus", size: 16 }, () => openAddDevice("scan"));
  addBtn.dataset.role = "top-add";
  const top = h("div", { class: "topbar" },
    h("div", null, titleEl, subEl), h("div", { class: "grow" }), exit, addBtn, themeBtn,
    h("div", { class: "clock" }, timeEl, dateEl));
  app._addBtn = addBtn;
  bannerEl = h("div", { style: { padding: "0 24px" } });
  viewEl = h("div", { class: "view" });
  app.append(nav, h("main", null, top, bannerEl, viewEl));
  app._nav = nav;
  app._themeBtn = themeBtn;
}

function go(route) {
  if (!views[route]) {
    const r = ROUTES.find((x) => x[0] === route) || ROUTES[0];
    views[route] = r[3]();
  }
  closeOverlay("palette");
  const prev = activeRoute;
  activeRoute = route;
  state.ui.route = route;
  document.body.dataset.route = route;
  location.hash = "#/" + route;
  if (prev && prev !== route && views[prev]?.leave) views[prev].leave();
  viewEl.replaceChildren(views[route].el);
  viewEl.scrollTop = 0;
  if (views[route]?.enter) views[route].enter();
  render();
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Good night" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
}

function tickClock() {
  const d = new Date();
  setText(timeEl, d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  setText(dateEl, d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
  if (activeRoute === "dashboard") setText(titleEl, greeting());
}

function periodToTheme(period) {
  return period === "day" || period === "dawn" ? "light" : "dark";
}

function currentTheme() {
  const pref = localStorage.getItem("theme") || state.settings.theme || "auto";
  if (pref === "auto") {
    const period = (state.weather && state.weather.period) || document.documentElement.dataset.period || "night";
    return periodToTheme(period);
  }
  return pref === "light" ? "light" : "dark";
}

function themePreference() {
  return localStorage.getItem("theme") || state.settings.theme || "auto";
}

function toggleTheme() {
  const order = ["auto", "dark", "light"];
  const cur = themePreference();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem("theme", next);
  state.settings.theme = next;
  call("settings_set", { theme: next }).catch(() => {});
  notify();
}

function render() {
  if (!state.ready) return;
  const theme = currentTheme();
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta && meta.setAttribute("content", theme === "dark" ? "#121418" : "#eef1f5");
  }
  const pref = themePreference();
  document.getElementById("app")._themeBtn.replaceChildren(icon(pref === "auto" ? "clock" : theme === "dark" ? "sun" : "moon", 20));
  document.getElementById("app")._themeBtn.title = pref === "auto" ? "Theme: Auto (time of day)" : pref === "dark" ? "Theme: Dark" : "Theme: Light";
  const s = stats();
  for (const [id, b] of Object.entries(navEls)) {
    setClass(b, "active", id === activeRoute);
    if (id === "devices") { b._badge.style.display = state.candidates.length ? "" : "none"; setText(b._badge, state.candidates.length); }
  }
  const nav = document.getElementById("app")._nav;
  setClass(nav._conn.connDot, "on", state.connected);
  setClass(nav._conn.connDot, "bad", !state.connected);
  setText(nav._conn.connText, state.connected ? (isTauri ? "Hub running" : "Connected to hub") : "Reconnecting…");
  if (activeRoute === "dashboard") {
    setText(titleEl, greeting());
    setText(subEl, s.total ? `${s.on} of ${s.lights} lights on · ${s.online}/${s.total} devices online` : "Let's find your devices");
  } else {
    const r = ROUTES.find((x) => x[0] === activeRoute);
    setText(titleEl, r ? r[1] : "");
    setText(subEl, SUBS[activeRoute] || "");
  }
  // Devices page owns Add — hide topbar duplicate
  const addBtn = document.getElementById("app")._addBtn;
  if (addBtn) addBtn.style.display = activeRoute === "devices" || state.ui.kiosk ? "none" : "";
  // connection banner
  if (!state.connected) {
    if (!bannerEl.firstChild) bannerEl.append(h("div", { class: "banner bad" }, icon("wifi", 20), "Lost connection to the hub. Reconnecting…"));
  } else if (bannerEl.firstChild) bannerEl.replaceChildren();
  views[activeRoute] && views[activeRoute].update(state);
  refreshDetail();
  if (screensaverOn()) refreshScreensaver();
}

function palette() {
  if (document.querySelector(".palette")) return closeOverlay();
  if (!state.ready) return;
  openPalette({ routes: ROUTES, go, kiosk: toggleKiosk, theme: toggleTheme });
}

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette(); }
  else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); palette(); }
});

// ---------- screen mode + screensaver ----------
let dimTimer = null;

export async function enterKiosk() {
  state.ui.kiosk = true;
  document.body.classList.add("kiosk");
  closeOverlay();
  hideScreensaver();
  go("dashboard");
  setFullscreen(true).catch(() => {});
  armIdle();
}

export async function exitKiosk() {
  state.ui.kiosk = false;
  document.body.classList.remove("kiosk");
  hideScreensaver();
  clearTimeout(dimTimer);
  setFullscreen(false).catch(() => {});
  notify();
}

export function toggleKiosk() {
  state.ui.kiosk ? exitKiosk() : enterKiosk();
}

export function startScreensaver() {
  if (!state.ui.kiosk) enterKiosk().then(() => showScreensaver(() => armIdle()));
  else showScreensaver(() => armIdle());
}

function idleMs() {
  const secs = state.settings.screensaver_secs;
  return Math.max(15, Number(secs) || 60) * 1000;
}

function armIdle() {
  clearTimeout(dimTimer);
  if (!state.ui.kiosk || state.settings.idle_dim === false) return;
  if (screensaverOn()) return;
  dimTimer = setTimeout(() => showScreensaver(() => armIdle()), idleMs());
}

["pointerdown", "keydown", "touchstart", "pointermove"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    // Ignore tiny pointer moves while screensaver is off (don't reset constantly on mouse jitter)
    if (ev === "pointermove" && !screensaverOn()) return;
    if (screensaverOn()) {
      // screensaver.js handles its own dismiss on pointerdown inside the overlay
      if (e.target && e.target.closest && e.target.closest("#screensaver")) return;
      hideScreensaver();
    }
    armIdle();
  }, true));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (screensaverOn()) {
      e.preventDefault();
      hideScreensaver();
      armIdle();
      return;
    }
    if (isControlOpen()) {
      e.preventDefault();
      closeControlCenter();
      return;
    }
    if (state.ui.kiosk && !document.getElementById("overlay").children.length) exitKiosk();
  }
});

// ---------- PIN ----------
function askPin() {
  if (document.getElementById("overlay").querySelector(".modal")) return;
  const pin = h("input", { type: "password", placeholder: "PIN", autofocus: true });
  const go2 = () => { setPin(pin.value.trim()); location.reload(); };
  pin.addEventListener("keydown", (e) => e.key === "Enter" && go2());
  modal("This hub is protected", h("label", { class: "field" }, "Enter the PIN set on the Mac app", pin), [(c) => btn("Unlock", { cls: "primary" }, go2)]);
  setTimeout(() => pin.focus(), 50);
}

// ---------- start ----------
async function start() {
  build();
  if (new URLSearchParams(location.search).has("kiosk")) {
    state.ui.kiosk = true;
    document.body.classList.add("kiosk");
  }
  const initial = (location.hash || "").replace("#/", "");
  go(ROUTES.some((r) => r[0] === initial) ? initial : "dashboard");
  window.addEventListener("hashchange", () => {
    const r = (location.hash || "").replace("#/", "");
    if (r && r !== activeRoute && ROUTES.some((x) => x[0] === r)) go(r);
  });
  subscribeStore(render);
  setInterval(tickClock, 1000);
  tickClock();

  const hubEv = wireHubEvents({
    answerHome: (p) => {
      hideScreensaver();
      if (!views.call) views.call = createCall();
      views.call.answer && views.call.answer(p.from);
      go("call");
    },
    declineHome: (p) => {
      if (!views.call) views.call = createCall();
      views.call.decline && views.call.decline(p.from);
    },
    answerDoorbell: () => { hideScreensaver(); go("cameras"); },
    webrtc: (p) => {
      if (!views.call) views.call = createCall();
      views.call.onSignal && views.call.onSignal(p);
    },
  });

  subscribe({
    snapshot: (s) => { setSnapshot(s); state.connected = true; },
    live: (d) => applyLive(d),
    scanning: (v) => { state.scanning = !!v; notify(); },
    status: (c) => { state.connected = c; notify(); },
    auth: askPin,
    menu: (m) => (m === "discover" ? openAddDevice("scan") : m === "kiosk" ? toggleKiosk() : null),
    ...hubEv,
  });

  try {
    const snap = await call("state");
    setSnapshot(snap);
  } catch (e) {
    if (e instanceof AuthError) askPin();
    else toast(e.message, "err");
  }
  refreshWeather(true);
  initControlCenter();
  registerWall();
  startHeartbeat();
  import("./permissions.js").then((m) => m.maybeAskLocationOnce()).catch(() => {});
  import("./views/setup.js").then((m) => {
    setTimeout(() => m.maybeOpenSetup(), 900);
  }).catch(() => {});
  // Safety net: resync every 20 s (skipped while hidden) and instantly when the window wakes up.
  const resync = async () => {
    try { setSnapshot(await call("state")); state.connected = true; } catch (e) { if (!(e instanceof AuthError)) state.connected = false; notify(); }
  };
  setInterval(() => { if (!document.hidden) resync(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resync(); });
  window.addEventListener("online", resync);
  window.addEventListener("focus", resync);
}

start();
