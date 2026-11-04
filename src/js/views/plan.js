// Floor plan: 2.5D overview with tinted rooms and kind-specific device glyphs.
import { h } from "../dom.js";
import { state, L, glowColor } from "../store.js";
import { toggleDevice } from "../actions.js";
import { roomMetaFor, templateCells } from "../roommeta.js";

const CW = 230;
const CH = 170;
const PAD = 14;
const PLAN_W = 1000;
const PLAN_H = 600;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TINT_FILL = {
  sage: "rgba(79, 209, 165, 0.14)",
  dusk: "rgba(140, 110, 210, 0.16)",
  sky: "rgba(90, 170, 230, 0.15)",
  warm: "rgba(240, 180, 90, 0.14)",
  slate: "rgba(120, 135, 155, 0.12)",
};

// ---------- furniture (stroke-only line art, local room coordinates) ----------

function furniture(name, w, h) {
  const r = (x, y, ww, hh, rx = 3, cls = "") => `<rect class="furn ${cls}" x="${x}" y="${y}" width="${ww}" height="${hh}" rx="${rx}"/>`;
  const c = (x, y, rr, cls = "") => `<circle class="furn ${cls}" cx="${x}" cy="${y}" r="${rr}"/>`;
  const l = (x1, y1, x2, y2) => `<line class="furn" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const plant = (x, y) => c(x, y, 9) + c(x, y, 4);
  if (/bed|sleep|guest|kid/i.test(name)) {
    const bx = w * 0.26, bw = w * 0.48, by = h - 92;
    return r(bx, by, bw, 72, 6) + r(bx + 8, by + 7, bw * 0.38, 14, 5) + r(bx + bw - 8 - bw * 0.38, by + 7, bw * 0.38, 14, 5) +
      l(bx, by + 36, bx + bw, by + 36) + r(bx - 22, by + 4, 16, 16, 3) + r(bx + bw + 6, by + 4, 16, 16, 3) + plant(w - 22, h - 22);
  }
  if (/kitchen|pantry/i.test(name)) {
    return r(14, h - 34, w - 28, 20, 3) + r(w * 0.2, h - 31, 28, 14, 4) + c(w * 0.62, h - 24, 4) + c(w * 0.62 + 14, h - 24, 4) +
      c(w * 0.62 + 28, h - 24, 4) + r(w * 0.25, h - 82, w * 0.5, 22, 4) + c(w * 0.3, h - 52, 5) + c(w * 0.7, h - 52, 5);
  }
  if (/bath|toilet|wash|wc/i.test(name)) {
    return r(14, h - 56, w * 0.5, 38, 14) + r(w - 56, h - 48, 36, 24, 6) + c(w - 38, h - 36, 6) + `<ellipse class="furn" cx="${w - 30}" cy="${h - 84}" rx="10" ry="13"/>`;
  }
  if (/office|study|work|desk/i.test(name)) {
    return r(w * 0.2, h - 52, w * 0.6, 24, 3) + r(w * 0.4, h - 62, w * 0.2, 9, 2) + c(w * 0.5, h - 18, 9) + plant(w - 22, h - 80);
  }
  if (/din/i.test(name)) {
    const cx = w / 2, cy = h - 58;
    return c(cx, cy, 22) + c(cx - 36, cy, 7) + c(cx + 36, cy, 7) + c(cx, cy - 34, 7) + c(cx, cy + 34, 7);
  }
  if (/living|lounge|tv|family|hall/i.test(name)) {
    const sx = w * 0.18, sw = w * 0.64;
    return r(sx, h - 56, sw, 28, 8) + r(sx, h - 66, sw, 12, 6) + l(sx + sw / 3, h - 56, sx + sw / 3, h - 28) + l(sx + (sw * 2) / 3, h - 56, sx + (sw * 2) / 3, h - 28) +
      r(w * 0.36, h - 104, w * 0.28, 18, 5) + plant(w - 22, h - 22);
  }
  return r(w * 0.34, h - 62, w * 0.32, 22, 5) + plant(w - 22, h - 22);
}

function gridLayout(rooms) {
  const n = rooms.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const W = cols * CW;
  const out = [];
  for (let ri = 0; ri < rows; ri++) {
    const inRow = rooms.slice(ri * cols, ri * cols + cols);
    const w = W / inRow.length;
    inRow.forEach((room, ci) => out.push({ room, x: PAD + ci * w, y: PAD + ri * CH, w, h: CH }));
  }
  return { cells: out, width: W + PAD * 2, height: rows * CH + PAD * 2 };
}

function layout(rooms) {
  const tpl = templateCells(state.settings.home_layout_id || "", rooms.length);
  if (!tpl) return gridLayout(rooms);
  // Scale template (1000×600) into viewBox with padding; grow height if strip overflowed
  let maxY = 0;
  const cells = tpl.map((c, i) => {
    const room = rooms[i];
    if (!room) return null;
    maxY = Math.max(maxY, c.y + c.h);
    return { room, x: c.x, y: c.y, w: c.w, h: c.h };
  }).filter(Boolean);
  const height = Math.max(PLAN_H, maxY + 40);
  return { cells, width: PLAN_W, height };
}

function colorOf(d) {
  const l = L(d.id);
  return glowColor(d, l) || (d.kind === "light" ? "#ffd27a" : "#4fd1a5");
}

function deviceKind(d) {
  const n = `${d.kind} ${d.name}`;
  if (/fan/i.test(n) || d.kind === "fan") return "fan";
  if (d.kind === "climate" || /ac|air.?cond|hvac|thermostat/i.test(n)) return "climate";
  if (d.kind === "light") return "light";
  if (d.kind === "plug" || d.kind === "switch") return "plug";
  if (d.kind === "media") return "media";
  if (d.kind === "camera" || d.caps.includes("camera")) return "camera";
  if (d.kind === "lock" || d.caps.includes("lock")) return "lock";
  return "other";
}

function glyph(kind, x, y, on) {
  const o = on ? "1" : "0.55";
  if (kind === "light") {
    return `<circle class="lamp-ring" cx="${x}" cy="${y}" r="8"/><circle class="lamp-dot" cx="${x}" cy="${y}" r="4.5"/>`;
  }
  if (kind === "climate") {
    return `<circle class="lamp-ring" cx="${x}" cy="${y}" r="9"/><path class="lamp-dot" d="M${x} ${y - 6} V${y + 6} M${x - 5.5} ${y - 3} L${x + 5.5} ${y + 3} M${x + 5.5} ${y - 3} L${x - 5.5} ${y + 3}" fill="none" stroke="currentColor" stroke-width="1.4" opacity="${o}"/>`;
  }
  if (kind === "fan") {
    return `<circle class="lamp-ring" cx="${x}" cy="${y}" r="9"/><circle class="lamp-dot" cx="${x}" cy="${y}" r="2.2"/><path class="furn" d="M${x} ${y - 7} Q${x + 6} ${y - 2} ${x} ${y} Q${x - 6} ${y - 2} ${x} ${y - 7}" opacity="${o}"/><path class="furn" d="M${x + 6} ${y + 3} Q${x} ${y + 7} ${x} ${y} Q${x + 7} ${y - 1} ${x + 6} ${y + 3}" opacity="${o}"/>`;
  }
  if (kind === "media") {
    return `<rect class="lamp-ring" x="${x - 8}" y="${y - 6}" width="16" height="12" rx="3"/><path class="furn" d="M${x - 2} ${y - 2} L${x + 4} ${y} L${x - 2} ${y + 2} Z"/>`;
  }
  if (kind === "camera") {
    return `<rect class="lamp-ring" x="${x - 8}" y="${y - 5}" width="12" height="10" rx="2"/><path class="furn" d="M${x + 4} ${y - 2} L${x + 9} ${y - 5} V${y + 5} L${x + 4} ${y + 2}"/><circle class="lamp-dot" cx="${x - 2}" cy="${y}" r="2"/>`;
  }
  if (kind === "lock") {
    return `<rect class="lamp-ring" x="${x - 5}" y="${y - 2}" width="10" height="8" rx="2"/><path class="furn" d="M${x - 3} ${y - 2} V${y - 5} A3 3 0 0 1 ${x + 3} ${y - 5} V${y - 2}"/>`;
  }
  // plug / other
  return `<rect class="lamp-ring" x="${x - 7}" y="${y - 7}" width="14" height="14" rx="4"/><rect class="lamp-dot" x="${x - 3.5}" y="${y - 3.5}" width="7" height="7" rx="2"/>`;
}

function build(rooms, selected) {
  const { cells, width, height } = layout(rooms);
  let body = "";
  cells.forEach(({ room, x, y, w, h: hh }, idx) => {
    const lit = room.devices.filter((d) => L(d.id).on && L(d.id).online && deviceKind(d) === "light");
    const on = room.devices.filter((d) => L(d.id).on && L(d.id).online).length;
    const id = `pc${idx}`;
    const meta = roomMetaFor(room.name, state.settings);
    const fill = TINT_FILL[meta.tint] || TINT_FILL.slate;
    let g = `<g class="proom${selected === room.key ? " sel" : ""}" data-tint="${esc(meta.tint)}" transform="translate(${x} ${y})" style="animation-delay:${idx * 40}ms">`;
    g += `<defs><clipPath id="${id}"><rect width="${w}" height="${hh}" rx="10"/></clipPath></defs>`;
    g += `<rect class="room-bg" width="${w}" height="${hh}" rx="10" fill="${fill}"/>`;
    // light wash from every lit lamp
    g += `<g clip-path="url(#${id})" class="room-lit">`;
    const perRow = Math.max(1, Math.floor((w - 40) / 38));
    const total = room.devices.length;
    const pos = (i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, total - row * perRow);
      return { x: (w - inRow * 38) / 2 + 19 + (i % perRow) * 38, y: Math.min(hh - 28, 52 + row * 30) };
    };
    room.devices.forEach((d, i) => {
      const l = L(d.id);
      if (deviceKind(d) === "light" && l.on && l.online) {
        const p = pos(i);
        g += `<circle cx="${p.x}" cy="${p.y}" r="${Math.min(w, hh) * 0.45}" fill="${colorOf(d)}" opacity="${0.07 + ((l.brightness ?? 60) / 100) * 0.13}" style="filter:blur(12px)"/>`;
      }
    });
    g += `</g>`;
    if (hh > 100 && w > 120) g += `<g transform="translate(0 0)" opacity="0.85">${furniture(room.name, w, hh)}</g>`;
    room.devices.forEach((d, i) => {
      const l = L(d.id);
      const p = pos(i);
      const kind = deviceKind(d);
      const isOn = !!l.on && !!l.online;
      const cls = `lamp lamp-${kind}${isOn ? " on" : ""}${l.online ? "" : " off-line"}`;
      const label = `${d.name}: ${!l.online ? "offline" : isOn ? "on" : "off"}. Press to toggle.`;
      g += `<g class="${cls}" style="--c:${colorOf(d)};cursor:pointer;color:var(--c)" data-dev="${esc(d.id)}" role="button" tabindex="0" aria-label="${esc(label)}">`;
      g += `<title>${esc(d.name)}</title><circle r="13" cx="${p.x}" cy="${p.y}" fill="transparent"/>`;
      g += glyph(kind, p.x, p.y, isOn);
      g += `</g>`;
    });
    g += `<text class="rname" x="12" y="22">${esc(room.name)}</text>`;
    g += `<text class="rsub" x="${w - 12}" y="22" text-anchor="end">${room.devices.length} device${room.devices.length === 1 ? "" : "s"}${on ? " · " + on + " on" : ""}${lit.length ? " · lit" : ""}</text>`;
    g += `<g data-room="${esc(room.key)}" role="button" tabindex="0" aria-label="Show ${esc(room.name)}"><rect class="room-hit" width="${w}" height="${hh}" style="pointer-events:none"/></g>`;
    g += `<rect class="room-ring" width="${w}" height="${hh}" rx="10"/>`;
    g += `</g>`;
    body += g;
  });
  return `<svg class="plan-svg plan-enter" viewBox="0 0 ${width} ${height}" role="group" aria-label="Floor plan of your home">` +
    `<rect class="wall" x="${PAD - 3}" y="${PAD - 3}" width="${width - PAD * 2 + 6}" height="${height - PAD * 2 + 6}" rx="12"/>` + body + `</svg>`;
}

export function createPlan(onRoom) {
  const host = h("div", { class: "plan-host" });
  const el = h("div", { class: "panel plan-card" },
    h("div", { class: "panel-head" }, h("h3", null, "Floor plan"), h("div", { class: "grow" }),
      h("span", { class: "eyebrow" }, "Tap a device to toggle · tap a room to focus")),
    host);
  let sig = "";

  host.addEventListener("click", (e) => {
    const lamp = e.target.closest("[data-dev]");
    if (lamp) return toggleDevice(lamp.dataset.dev);
    const rect = e.target.closest("svg") && e.target.closest(".proom");
    if (rect) {
      const g = rect.querySelector("[data-room]");
      g && onRoom(g.dataset.room);
    }
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const lamp = e.target.closest && e.target.closest("[data-dev]");
    const room = e.target.closest && e.target.closest("[data-room]");
    if (lamp) { e.preventDefault(); toggleDevice(lamp.dataset.dev); }
    else if (room) { e.preventDefault(); onRoom(room.dataset.room); }
  });

  function update(rooms, selected) {
    const layoutId = state.settings.home_layout_id || "";
    const metaSig = JSON.stringify(state.settings.room_meta || {});
    const s = JSON.stringify([selected, layoutId, metaSig, rooms.map((r) => [r.key, r.name, r.devices.map((d) => { const l = L(d.id); return [d.id, d.name, d.kind, !!l.on, !!l.online, l.brightness, colorOf(d)]; })])]);
    if (s === sig) return;
    sig = s;
    host.innerHTML = build(rooms, selected);
  }
  return { el, update };
}
