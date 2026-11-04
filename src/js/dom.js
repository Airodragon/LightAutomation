// Tiny DOM toolkit: hyperscript, keyed reconcile, icons, toast, modal, drawer.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && k !== "list") {
        try { el[k] = v; } catch (_) { el.setAttribute(k, v); }
      } else el.setAttribute(k, v === true ? "" : v);
    }
  }
  if (tag === "button" && props && props.title && !props["aria-label"]) el.setAttribute("aria-label", props.title);
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function setText(el, text) {
  if (el.textContent !== String(text)) el.textContent = text;
}
export function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}
export function setStyle(el, prop, val) {
  if (el.style.getPropertyValue(prop) !== val) el.style.setProperty(prop, val);
}
export function setAttr(el, name, val) {
  if (val === null || val === undefined || val === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(val)) el.setAttribute(name, val);
}

/**
 * Keyed list patching: reuse elements, update in place, reorder with minimal moves.
 * Never rebuilds elements that already exist, so focus, drags and animations survive.
 */
export function reconcile(parent, items, keyOf, make, update) {
  if (parent.dataset.sorting) return; // a drag is in progress: do not fight it
  const existing = new Map();
  for (const ch of Array.from(parent.children)) {
    if (ch.dataset && ch.dataset.key !== undefined) existing.set(ch.dataset.key, ch);
  }
  const wanted = new Set();
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = String(keyOf(item));
    wanted.add(key);
    let el = existing.get(key);
    if (!el) {
      el = make(item);
      el.dataset.key = key;
    }
    update(el, item);
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      parent.insertBefore(el, cursor);
    }
  }
  for (const [k, el] of existing) if (!wanted.has(k)) el.remove();
}

// ---------- icons (24px stroke set) ----------
const P = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  rooms: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  devices: '<rect x="4" y="3" width="16" height="12" rx="2"/><path d="M8 21h8M12 15v6"/>',
  scenes: '<path d="M12 3l2.2 5.2L20 9l-4.2 3.8L17 18.5 12 15.6 7 18.5l1.2-5.7L4 9l5.8-.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  energy: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  studio: '<path d="M4 20c4-1 5-5 7-9l4-7 5 3-7 6c-2 3-3 7-9 7z"/><path d="M14 4l6 4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  switch: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>',
  sensor: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  climate: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>',
  media: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M10 8l5 2-5 2z"/>',
  cover: '<path d="M4 4h16v4H4zM6 8v12M18 8v12M10 8v8M14 8v8"/>',
  other: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  sofa: '<path d="M4 11V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3"/><path d="M2 14a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v5H2z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  home2: '<path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/>',
};

export function icon(name, size = 20, cls = "") {
  const span = document.createElement("span");
  span.style.display = "inline-grid";
  span.className = cls;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.other}</svg>`;
  return span;
}

export const kindIcon = (kind) => ({ light: "bulb", plug: "plug", switch: "switch", sensor: "sensor", climate: "climate", media: "media", cover: "cover", camera: "film", lock: "cover", alarm: "power" }[kind] || "other");

// ---------- toast ----------
export function toast(msg, kind = "") {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast ${kind}` }, msg);
  box.append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, kind === "err" ? 4200 : 2200);
}

// ---------- overlays ----------
const overlay = () => document.getElementById("overlay");

export function closeOverlay(kind) {
  const o = overlay();
  Array.from(o.children).forEach((c) => {
    if (!kind || c.dataset.kind === kind) c.remove();
  });
  document.removeEventListener("keydown", escHandler);
}

function escHandler(e) {
  if (e.key === "Escape") {
    const o = overlay();
    const last = o.lastElementChild;
    if (last) last.dispatchEvent(new CustomEvent("dismiss"));
  }
}

function mount(kind, el, onClose) {
  closeOverlay(kind === "drawer" ? "drawer" : null);
  const scrim = h("div", { class: "scrim", "data-kind": kind });
  const close = () => {
    scrim.remove();
    el.dispatchEvent(new CustomEvent("remove-focus"));
    el.remove();
    onClose && onClose();
  };
  scrim.addEventListener("click", close);
  el.dataset.kind = kind;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  const prevFocus = document.activeElement;
  el.addEventListener("dismiss", close);
  el.addEventListener("remove-focus", () => prevFocus && prevFocus.isConnected && prevFocus.focus && prevFocus.focus());
  overlay().append(scrim, el);
  setTimeout(() => {
    const f = el.querySelector("input:not([type=hidden]), select, textarea, button.primary") || el.querySelector("button");
    f && f.focus({ preventScroll: true });
  }, 30);
  document.addEventListener("keydown", escHandler);
  return close;
}

export function modal(title, body, actions = []) {
  let close;
  const el = h("div", { class: "modal" }, h("h2", null, title), body, h("div", { class: "actions" }, ...actions.map((a) => a(() => close()))));
  close = mount("modal", el);
  return close;
}

export function overlayPanel(el, onClose) {
  return mount("palette", el, onClose);
}

export function drawer(el, onClose) {
  el.classList.add("drawer");
  return mount("drawer", el, onClose);
}

export function btn(label, opts = {}, onClick) {
  return h("button", { class: `btn ${opts.cls || ""}`, onClick, title: opts.title }, opts.icon ? icon(opts.icon, opts.size || 18) : null, label);
}

export function confirmBox(title, message, okLabel, onOk, danger = true) {
  modal(title, h("p", { class: "muted" }, message), [
    (close) => btn("Cancel", {}, () => close()),
    (close) => btn(okLabel, { cls: danger ? "primary danger" : "primary" }, () => { close(); onOk(); }),
  ]);
}

export function promptBox(title, label, value, okLabel, onOk) {
  const input = h("input", { type: "text", value: value || "", placeholder: label });
  const go = (close) => {
    const v = input.value.trim();
    if (v) { close(); onOk(v); }
  };
  let closeFn;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(closeFn); });
  closeFn = modal(title, h("label", { class: "field" }, label, input), [
    (close) => btn("Cancel", {}, () => close()),
    (close) => { closeFn = close; return btn(okLabel, { cls: "primary" }, () => go(close)); },
  ]);
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

export const throttleLatest = (() => {
  // Per key: send at most one request in flight, always the newest value last.
  const slots = new Map();
  return (key, fn, minGap = 70) => {
    let s = slots.get(key);
    if (!s) slots.set(key, (s = { busy: false, pending: null, last: 0 }));
    s.pending = fn;
    const run = async () => {
      if (s.busy || !s.pending) return;
      const wait = s.last + minGap - performance.now();
      if (wait > 0) return setTimeout(run, wait);
      const f = s.pending;
      s.pending = null;
      s.busy = true;
      try { await f(); } catch (_) {}
      s.busy = false;
      s.last = performance.now();
      if (s.pending) run();
    };
    run();
  };
})();
