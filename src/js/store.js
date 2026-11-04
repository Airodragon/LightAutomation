// Client state. Server snapshots replace structure; "live" deltas patch device state.
import { call } from "./api.js";

const LOCAL_HOLD_MS = 1300;

export const state = {
  ready: false,
  connected: true,
  devices: [],
  live: {},
  rooms: [],
  scenes: [],
  schedules: [],
  settings: {},
  effect: null,
  web: {},
  scanning: false,
  candidates: [],
  wiz_scenes: [],
  effects: [],
  energy: null,
  weather: null,
  music: null,
  ui: {
    route: "dashboard",
    room: "all",
    detail: null,
    kiosk: false,
  },
};

const listeners = new Set();
let queued = false;

export function subscribeStore(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  if (queued) return;
  queued = true;
  const flush = () => {
    if (!queued) return;
    queued = false;
    listeners.forEach((fn) => fn(state));
  };
  requestAnimationFrame(flush);
  // rAF is paused in hidden tabs; keep state fresh anyway
  setTimeout(flush, 120);
}

const holds = new Map(); // id -> timestamp until which server live updates are ignored

export function setSnapshot(s) {
  const keep = ["ready", "connected", "ui", "energy", "weather", "music"];
  // keep locally held optimistic values across the snapshot
  const now = performance.now();
  const held = {};
  for (const [id, until] of holds) {
    if (until < now) holds.delete(id);
    else if (state.live[id]) held[id] = state.live[id];
  }
  for (const k of Object.keys(s)) if (!keep.includes(k)) state[k] = s[k];
  Object.assign(state.live, held);
  state.ready = true;
  notify();
}

export function applyLive(delta) {
  const now = performance.now();
  for (const [id, l] of Object.entries(delta)) {
    const until = holds.get(id);
    if (until && until > now) {
      // the user is interacting: take only fields that don't fight the UI
      const cur = state.live[id] || {};
      state.live[id] = { ...cur, rssi: l.rssi, watts: l.watts, online: l.online };
    } else {
      state.live[id] = l;
    }
  }
  notify();
}

/** Optimistic local change, shielded from stale server events for a moment. */
export function patchLive(id, patch) {
  state.live[id] = { ...(state.live[id] || {}), ...patch };
  holds.set(id, performance.now() + LOCAL_HOLD_MS);
  notify();
}

export function getDevice(id) {
  return state.devices.find((d) => d.id === id);
}

export function reorderLocal(ids) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  state.devices = [...state.devices].sort(
    (a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e6 + a.order) - (rank.has(b.id) ? rank.get(b.id) : 1e6 + b.order)
  );
  state.devices.forEach((d, i) => (d.order = i));
  notify();
}

export async function refreshEnergy() {
  try {
    state.energy = await call("energy");
    notify();
  } catch (_) {}
}

export async function refreshWeather(force = false) {
  if (!force && state.weather && Date.now() - (state.weather.fetched_at || 0) < 9 * 60 * 1000) return;
  try {
    state.weather = await call("weather");
    notify();
  } catch (_) {}
}

export async function refreshMusic() {
  try {
    state.music = await call("music_now_playing");
    notify();
  } catch (_) {
    // Web clients / Music unavailable — fall back to HA/Cast media devices
  }
}

// ---------- derived helpers ----------

export const L = (id) => state.live[id] || {};

export function isOn(id) {
  const l = L(id);
  return !!l.on;
}

export function glowColor(d, l) {
  if (l.rgb) return `rgb(${l.rgb[0]},${l.rgb[1]},${l.rgb[2]})`;
  if (l.temp) return kelvinToCss(l.temp);
  return null;
}

export function kelvinToCss(k) {
  const t = Math.min(6500, Math.max(2200, k));
  const f = (t - 2200) / (6500 - 2200);
  const r = 255;
  const g = Math.round(170 + f * 70);
  const b = Math.round(90 + f * 165);
  return `rgb(${r},${g},${b})`;
}

export function stats() {
  const lights = state.devices.filter((d) => d.kind === "light");
  const onCount = lights.filter((d) => L(d.id).on).length;
  const online = state.devices.filter((d) => L(d.id).online).length;
  const watts = state.devices.reduce((s, d) => s + (L(d.id).online ? L(d.id).watts || 0 : 0), 0);
  return { lights: lights.length, on: onCount, online, total: state.devices.length, watts };
}
