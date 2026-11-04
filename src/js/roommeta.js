// Room tint/icon defaults and helpers shared by plan, rooms, setup, home.

export const TINTS = [
  { id: "sage", label: "Sage" },
  { id: "dusk", label: "Dusk" },
  { id: "sky", label: "Sky" },
  { id: "warm", label: "Warm" },
  { id: "slate", label: "Slate" },
];

export const LAYOUTS = [
  {
    id: "studio",
    name: "Studio",
    desc: "Open living + sleep nook",
    rooms: (n) => {
      const base = ["Living Room", "Kitchen", "Bath"];
      return pad(base, n, ["Bedroom", "Office", "Balcony", "Storage", "Guest"]);
    },
  },
  {
    id: "1bhk",
    name: "1 BHK",
    desc: "Living, one bedroom, kitchen",
    rooms: (n) => pad(["Living Room", "Bedroom", "Kitchen", "Bath"], n, ["Balcony", "Office", "Store", "Guest"]),
  },
  {
    id: "2bhk",
    name: "2 BHK",
    desc: "Living plus two bedrooms",
    rooms: (n) => pad(["Living Room", "Bedroom", "Bedroom 2", "Kitchen", "Bath"], n, ["Balcony", "Office", "Store"]),
  },
  {
    id: "open",
    name: "Open plan",
    desc: "Wide living/dining, side rooms",
    rooms: (n) => pad(["Living Room", "Dining", "Kitchen", "Bedroom"], n, ["Office", "Bath", "Guest", "Laundry"]),
  },
];

function pad(base, n, extra) {
  const out = base.slice(0, n);
  let i = 0;
  while (out.length < n && i < extra.length) {
    if (!out.includes(extra[i])) out.push(extra[i]);
    i++;
  }
  let k = out.length + 1;
  while (out.length < n) {
    out.push(`Room ${k++}`);
  }
  return out.slice(0, n);
}

export function defaultTint(name) {
  if (/bed|sleep|guest|kid/i.test(name)) return "dusk";
  if (/kitchen|pantry|din/i.test(name)) return "warm";
  if (/bath|toilet|wash|wc|laundry/i.test(name)) return "sky";
  if (/office|study|work/i.test(name)) return "slate";
  if (/living|lounge|tv|family|hall/i.test(name)) return "sage";
  return "slate";
}

export function defaultIcon(name) {
  if (/bed|sleep|guest|kid/i.test(name)) return "moon";
  if (/living|lounge|tv|family/i.test(name)) return "sofa";
  if (/kitchen|dining|pantry/i.test(name)) return "sparkles";
  if (/office|study|work/i.test(name)) return "devices";
  if (/bath|toilet|wash/i.test(name)) return "climate";
  return "rooms";
}

export function roomMetaFor(name, settings) {
  const raw = (settings && settings.room_meta && settings.room_meta[name]) || {};
  return {
    tint: raw.tint || defaultTint(name),
    icon: raw.icon || defaultIcon(name),
  };
}

export function allRoomMeta(rooms, settings) {
  const out = { ...(settings.room_meta || {}) };
  for (const name of rooms) {
    if (!out[name]) out[name] = { tint: defaultTint(name), icon: defaultIcon(name) };
    else {
      out[name] = {
        tint: out[name].tint || defaultTint(name),
        icon: out[name].icon || defaultIcon(name),
      };
    }
  }
  return out;
}

/** Template cell layouts: fractions of a 1000×600 plan canvas. */
export function templateCells(layoutId, count) {
  const layouts = {
    studio: [
      { x: 40, y: 40, w: 620, h: 520 },
      { x: 680, y: 40, w: 280, h: 250 },
      { x: 680, y: 310, w: 280, h: 250 },
    ],
    "1bhk": [
      { x: 40, y: 40, w: 480, h: 320 },
      { x: 540, y: 40, w: 420, h: 320 },
      { x: 40, y: 380, w: 480, h: 180 },
      { x: 540, y: 380, w: 420, h: 180 },
    ],
    "2bhk": [
      { x: 40, y: 40, w: 420, h: 280 },
      { x: 480, y: 40, w: 240, h: 280 },
      { x: 740, y: 40, w: 220, h: 280 },
      { x: 40, y: 340, w: 420, h: 220 },
      { x: 480, y: 340, w: 480, h: 220 },
    ],
    open: [
      { x: 40, y: 40, w: 700, h: 340 },
      { x: 760, y: 40, w: 200, h: 160 },
      { x: 760, y: 220, w: 200, h: 160 },
      { x: 40, y: 400, w: 920, h: 160 },
    ],
  };
  const base = layouts[layoutId] || null;
  if (!base || count < 1) return null;
  if (count <= base.length) return base.slice(0, count);
  // Extra rooms: append a bottom strip of equal cells
  const cells = base.map((c) => ({ ...c }));
  const extra = count - base.length;
  const stripY = 560;
  const stripH = 120;
  const gap = 16;
  const totalW = 920;
  const cellW = (totalW - gap * (extra - 1)) / extra;
  for (let i = 0; i < extra; i++) {
    cells.push({ x: 40 + i * (cellW + gap), y: stripY, w: cellW, h: stripH });
  }
  // Scale canvas height if we overflow
  return cells;
}
