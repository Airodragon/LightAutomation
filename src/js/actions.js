// User actions: optimistic local update first, then the hub command. Errors become toasts.
import { call } from "./api.js";
import { state, patchLive, setSnapshot, L, notify } from "./store.js";
import { toast, throttleLatest } from "./dom.js";

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const rgbToHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

let lastErr = 0;
export function fail(e) {
  const now = Date.now();
  if (now - lastErr < 1500) return;
  lastErr = now;
  toast(e.message || String(e), "err");
}

/** Run a command, then merge the returned snapshot (structural commands return one). */
export async function run(cmd, args = {}, okMsg) {
  try {
    const r = await call(cmd, args);
    if (r && r.devices && r.rooms) setSnapshot(r);
    if (okMsg) toast(okMsg, "ok");
    return r;
  } catch (e) {
    fail(e);
    throw e;
  }
}

const pending = new Map();

function optimistic(cmd) {
  const p = {};
  if (cmd.on !== undefined) p.on = cmd.on;
  if (cmd.media !== undefined) {
    if (["arm_away", "arm_home", "arm_night", "arm"].includes(cmd.media)) p.on = true;
    if (cmd.media === "disarm" || cmd.media === "disarm_alarm") p.on = false;
    p.value = cmd.media;
  }
  if (cmd.brightness !== undefined) {
    if (cmd.brightness <= 0) p.on = false;
    else { p.brightness = cmd.brightness; p.on = true; }
  }
  if (cmd.color) { p.rgb = hexToRgb(cmd.color); p.temp = null; p.scene_id = null; p.on = true; }
  if (cmd.rgb) { p.rgb = cmd.rgb; p.temp = null; p.scene_id = null; p.on = true; }
  if (cmd.temp) { p.temp = cmd.temp; p.rgb = null; p.scene_id = null; p.on = true; }
  if (cmd.scene_id) { p.scene_id = cmd.scene_id; p.on = true; }
  if (cmd.target !== undefined) p.target = cmd.target;
  return p;
}

/** Control one device. Rapid calls (slider drags) coalesce: newest value wins, one request in flight. */
export function setDevice(id, cmd) {
  patchLive(id, optimistic(cmd));
  pending.set(id, { ...(pending.get(id) || {}), ...cmd });
  throttleLatest(
    "set:" + id,
    async () => {
      const c = pending.get(id);
      pending.delete(id);
      if (!c) return;
      try {
        await call("set", { id, ...c });
      } catch (e) {
        fail(e);
      }
    },
    80
  );
}

export function toggleDevice(id) {
  setDevice(id, { on: !L(id).on });
}

export async function setGroup(target, on) {
  for (const d of state.devices) {
    const hit =
      target === "all" ? ["light", "plug", "switch"].includes(d.kind)
      : target === "lights" ? d.kind === "light"
      : target.startsWith("room:") ? d.room === target.slice(5) && d.caps.includes("onoff")
      : false;
    if (hit) patchLive(d.id, { on });
  }
  try {
    await call("target_set", { target, on });
  } catch (e) {
    fail(e);
  }
}

export async function applyScene(sc) {
  try {
    await call("scene_apply", { id: sc.id });
    toast(`${sc.name} applied`, "ok");
  } catch (e) {
    fail(e);
  }
}

export function colorName(l) {
  if (l.scene_id) return null;
  if (l.rgb) return "Colour";
  if (l.temp) return l.temp <= 3000 ? "Warm white" : l.temp >= 5000 ? "Daylight" : "Neutral white";
  return "";
}

export function describe(d, l) {
  if (!l.seen && !l.online) return "Connecting…";
  if (!l.online) return "Offline";
  if (d.kind === "sensor") return `${l.value ?? "–"} ${l.unit ?? ""}`.trim();
  if (d.kind === "climate") return l.current != null ? `${l.current}° → ${l.target ?? "–"}°` : (l.value || "");
  if (d.kind === "media") {
    if (l.media_title) return [l.media_title, l.media_artist].filter(Boolean).join(" · ");
    const st = l.value ? l.value[0].toUpperCase() + l.value.slice(1) : l.on ? "On" : "Off";
    if (l.volume != null && l.on) return `${st} · ${Math.round(l.volume * 100)}%`;
    return st;
  }
  if (d.kind === "plug" || d.kind === "switch") {
    if (!l.on) return "Off";
    return l.watts != null ? `On · ${fmtW(l.watts)}` : "On";
  }
  if (!l.on) return "Off";
  const sc = l.scene_id ? (state.wiz_scenes.find((s) => s.id === l.scene_id) || {}).name : null;
  const parts = [];
  if (l.brightness != null) parts.push(`${l.brightness}%`);
  const m = sc || colorName(l);
  if (m) parts.push(m);
  return parts.join(" · ") || "On";
}

export function fmtW(w) {
  if (w == null) return "–";
  return w >= 100 ? `${Math.round(w)} W` : `${w.toFixed(1)} W`;
}

export { notify };
