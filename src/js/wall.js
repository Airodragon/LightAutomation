// Wall client enrollment + presence helpers.
import { call, isTauri } from "./api.js";
import { state, notify } from "./store.js";
import { toast } from "./dom.js";

const ID_KEY = "wall-client-id";
const NAME_KEY = "wall-client-name";

export function clientId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = `wall-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

export function clientName() {
  return localStorage.getItem(NAME_KEY) || (isTauri ? "Mac hub" : "Wall screen");
}

export function setClientName(name) {
  localStorage.setItem(NAME_KEY, name.trim() || "Wall screen");
}

export async function registerWall(extra = {}) {
  try {
    const hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const r = await call("wall_register", {
      id: clientId(),
      name: clientName(),
      room: state.ui.wallRoom || "",
      has_cam: hasCam,
      has_mic: hasCam,
      ...extra,
    });
    state.ui.wallId = r.id || clientId();
    notify();
    return r;
  } catch (_) {
    return null;
  }
}

export function startHeartbeat() {
  const beat = () => call("wall_heartbeat", { id: clientId() }).catch(() => {});
  beat();
  return setInterval(beat, 30000);
}

export async function setPresence(mode) {
  try {
    await call("presence_set", { mode });
    state.settings.presence_mode = mode;
    notify();
    toast(`Home · ${mode[0].toUpperCase()}${mode.slice(1)}`);
  } catch (e) {
    toast(e.message || "Could not set presence", "err");
  }
}

export function presenceMode() {
  return state.settings.presence_mode || "home";
}

/** Other wall screens seen in the last ~2 minutes (excludes this client). */
export function onlinePeers(maxAgeMs = 120000) {
  const now = Date.now();
  const me = clientId();
  return (state.settings.wall_clients || []).filter((c) => {
    if (!c || c.id === me) return false;
    const seen = Number(c.last_seen) || 0;
    // last_seen may be ms epoch from hub; treat missing as stale
    if (!seen) return false;
    return now - seen < maxAgeMs;
  });
}

export const PRESENCE = [
  { id: "home", label: "Home" },
  { id: "away", label: "Away" },
  { id: "night", label: "Night" },
  { id: "guest", label: "Guest" },
];
