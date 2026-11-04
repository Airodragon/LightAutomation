// Pointer-event drag & drop reordering (works with mouse, touch and pen; no HTML5 DnD).
// Containers that share a `group` let items move between them.

const groups = new Map(); // group -> Set<container>
const NO_DRAG = "input, button:not(.handle), select, textarea, a, .toggle, .no-drag";

/**
 * makeSortable(container, {
 *   item: ".dev",           // selector for draggable children
 *   handle: ".handle",      // optional: only start from this
 *   group: "devices",       // optional: allow cross-container drops
 *   onDrop(info)            // info = { container, keys, key, from }
 *   onClick(el, ev)         // optional: fired for clicks that were not drags
 * })
 */
export function makeSortable(container, opts) {
  if (container._sortable) {
    container._sortable.opts = opts;
    return;
  }
  container._sortable = { opts };
  if (opts.group) {
    if (!groups.has(opts.group)) groups.set(opts.group, new Set());
    groups.get(opts.group).add(container);
  }

  container.addEventListener("pointerdown", (e) => {
    const o = container._sortable.opts;
    if (e.button !== undefined && e.button !== 0) return;
    const el = e.target.closest(o.item);
    if (!el || !container.contains(el)) return;
    if (o.handle) {
      if (!e.target.closest(o.handle)) return;
    } else if (e.target.closest(NO_DRAG)) return;

    const start = { x: e.clientX, y: e.clientY };
    const touch = e.pointerType === "touch";
    let dragging = false;
    let timer = null;
    let ghost, placeholder, offX = 0, offY = 0, curContainer = container;
    const from = container;

    const begin = () => {
      dragging = true;
      const r = el.getBoundingClientRect();
      offX = start.x - r.left;
      offY = start.y - r.top;
      ghost = el.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = r.width + "px";
      ghost.style.height = r.height + "px";
      ghost.style.left = r.left + "px";
      ghost.style.top = r.top + "px";
      document.body.append(ghost);
      el.classList.add("dragging-placeholder", "placeholder");
      placeholder = el;
      document.body.classList.add("sorting");
      for (const c of containersOf(o)) c.dataset.sorting = "1";
      if (navigator.vibrate && touch) navigator.vibrate(12);
    };

    const containersOf = (o) => (o.group ? groups.get(o.group) : new Set([container]));

    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragging) {
        const dist = Math.hypot(dx, dy);
        if (touch) {
          if (dist > 9) cleanup(); // scrolling, not dragging
        } else if (dist > 5) begin();
        return;
      }
      ev.preventDefault();
      ghost.style.left = ev.clientX - offX + "px";
      ghost.style.top = ev.clientY - offY + "px";
      reposition(ev.clientX, ev.clientY);
    };

    const reposition = (x, y) => {
      const o = container._sortable.opts;
      // find target container under the pointer
      let target = null;
      for (const c of containersOf(o)) {
        const r = c.getBoundingClientRect();
        if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) {
          target = c;
          break;
        }
      }
      if (!target) return;
      const sel = target._sortable.opts.item;
      const siblings = Array.from(target.children).filter((c) => c.matches(sel) && c !== placeholder);
      // FLIP: remember positions
      const before = new Map(siblings.map((s) => [s, s.getBoundingClientRect()]));
      let ref = null;
      for (const s of siblings) {
        const r = s.getBoundingClientRect();
        const below = y > r.bottom;
        const rightOf = y >= r.top && y <= r.bottom && x > r.left + r.width / 2;
        if (below || rightOf) continue;
        ref = s;
        break;
      }
      const same = placeholder.parentElement === target && placeholder.nextElementSibling === (ref || null);
      if (same) return;
      target.insertBefore(placeholder, ref);
      curContainer = target;
      for (const s of siblings) {
        const a = before.get(s);
        const b = s.getBoundingClientRect();
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        if (dx || dy) {
          s.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 160, easing: "ease-out" });
        }
      }
    };

    const up = () => {
      const was = dragging;
      const key = el.dataset.key;
      const o = container._sortable.opts;
      const target = curContainer;
      if (was) {
        const t = target._sortable.opts;
        const keys = Array.from(target.children)
          .filter((c) => c.matches(t.item) && c.dataset.key !== undefined)
          .map((c) => c.dataset.key);
        cleanup();
        (t.onDrop || o.onDrop) && (t.onDrop || o.onDrop)({ container: target, keys, key, from });
        suppressClick();
      } else {
        cleanup();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", prevent);
      if (dragging) {
        ghost && ghost.remove();
        placeholder && placeholder.classList.remove("dragging-placeholder", "placeholder");
        document.body.classList.remove("sorting");
        for (const c of containersOf(container._sortable.opts)) delete c.dataset.sorting;
      }
      dragging = false;
    };
    const cancel = () => cleanup();
    const prevent = (ev) => dragging && ev.cancelable && ev.preventDefault();

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", prevent, { passive: false });
    if (touch) timer = setTimeout(begin, 280);
  });
}

function suppressClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 120);
}
