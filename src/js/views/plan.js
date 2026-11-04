// Floor plan: an architectural overview of the home built from your rooms and devices.
// Lights glow in their real colour; click a lamp to toggle it, click a room to focus it.
import { h } from "../dom.js";
import { state, L, glowColor } from "../store.js";
import { toggleDevice } from "../actions.js";

const CW = 230;
const CH = 170;
const PAD = 14;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

// ---------- layout ----------

function layout(rooms) {
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

function colorOf(d) {
  const l = L(d.id);
  return glowColor(d, l) || (d.kind === "light" ? "#ffd27a" : "#4fd1a5");
}

function build(rooms, selected) {
  const { cells, width, height } = layout(rooms);
  let body = "";
  cells.forEach(({ room, x, y, w, h: hh }, idx) => {
    const lit = room.devices.filter((d) => L(d.id).on && L(d.id).online && d.kind === "light");
    const on = room.devices.filter((d) => L(d.id).on && L(d.id).online).length;
    const id = `pc${idx}`;
    let g = `<g class="proom${selected === room.key ? " sel" : ""}" transform="translate(${x} ${y})">`;
    g += `<defs><clipPath id="${id}"><rect width="${w}" height="${hh}" rx="2"/></clipPath></defs>`;
    g += `<rect class="room-bg" width="${w}" height="${hh}"/>`;
    // light wash from every lit lamp
    g += `<g clip-path="url(#${id})" class="room-lit">`;
    const perRow = Math.max(1, Math.floor((w - 40) / 38));
    const total = room.devices.length;
    const pos = (i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, total - row * perRow);
      return { x: (w - inRow * 38) / 2 + 19 + (i % perRow) * 38, y: 52 + row * 30 };
    };
    room.devices.forEach((d, i) => {
      const l = L(d.id);
      if (d.kind === "light" && l.on && l.online) {
        const p = pos(i);
        g += `<circle cx="${p.x}" cy="${p.y}" r="${Math.min(w, hh) * 0.5}" fill="${colorOf(d)}" opacity="${0.07 + ((l.brightness ?? 60) / 100) * 0.13}" style="filter:blur(12px)"/>`;
      }
    });
    g += `</g>`;
    g += `<g transform="translate(0 0)">${furniture(room.name, w, hh)}</g>`;
    // devices
    room.devices.forEach((d, i) => {
      const l = L(d.id);
      const p = pos(i);
      const isOn = !!l.on && !!l.online;
      const cls = `lamp${isOn ? " on" : ""}${l.online ? "" : " off-line"}`;
      const label = `${d.name}: ${!l.online ? "offline" : isOn ? "on" : "off"}. Press to toggle.`;
      g += `<g class="${cls}" style="--c:${colorOf(d)};cursor:pointer" data-dev="${esc(d.id)}" role="button" tabindex="0" aria-label="${esc(label)}">`;
      g += `<title>${esc(d.name)}</title><circle r="13" cx="${p.x}" cy="${p.y}" fill="transparent"/>`;
      g += d.kind === "light"
        ? `<circle class="lamp-ring" cx="${p.x}" cy="${p.y}" r="8"/><circle class="lamp-dot" cx="${p.x}" cy="${p.y}" r="4.5"/>`
        : `<rect class="lamp-ring" x="${p.x - 7}" y="${p.y - 7}" width="14" height="14" rx="4"/><rect class="lamp-dot" x="${p.x - 3.5}" y="${p.y - 3.5}" width="7" height="7" rx="2"/>`;
      g += `</g>`;
    });
    g += `<text class="rname" x="12" y="22">${esc(room.name)}</text>`;
    g += `<text class="rsub" x="${w - 12}" y="22" text-anchor="end">${room.devices.length} device${room.devices.length === 1 ? "" : "s"}${on ? " · " + on + " on" : ""}</text>`;
    g += `<g data-room="${esc(room.key)}" role="button" tabindex="0" aria-label="Show ${esc(room.name)}"><rect class="room-hit" width="${w}" height="${hh}" style="pointer-events:none"/></g>`;
    g += `<rect class="room-ring" width="${w}" height="${hh}"/>`;
    g += `</g>`;
    body += g;
  });
  return `<svg class="plan-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="Floor plan of your home">` +
    `<rect class="wall" x="${PAD - 3}" y="${PAD - 3}" width="${width - PAD * 2 + 6}" height="${height - PAD * 2 + 6}" rx="8"/>` + body + `</svg>`;
}

export function createPlan(onRoom) {
  const host = h("div");
  const el = h("div", { class: "panel plan-card" },
    h("div", { class: "panel-head" }, h("h3", null, "Floor plan"), h("div", { class: "grow" }),
      h("span", { class: "eyebrow" }, "Tap a lamp to toggle · tap a room to focus")),
    host);
  let sig = "";

  // The whole room area is clickable; lamps win because they sit above it.
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
    const s = JSON.stringify([selected, rooms.map((r) => [r.key, r.name, r.devices.map((d) => { const l = L(d.id); return [d.id, d.name, d.kind, !!l.on, !!l.online, l.brightness, colorOf(d)]; })])]);
    if (s === sig) return;
    sig = s;
    host.innerHTML = build(rooms, selected);
  }
  return { el, update };
}
