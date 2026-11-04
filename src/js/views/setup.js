// First-run (and Settings re-entry) home arrangement wizard.
import { h, icon, setText, btn, modal, toast } from "../dom.js";
import { state, notify } from "../store.js";
import { run } from "../actions.js";
import { LAYOUTS, TINTS, defaultTint, defaultIcon, allRoomMeta } from "../roommeta.js";

function shouldOfferSetup() {
  if (state.settings.home_setup_done) return false;
  // Offer when rooms are empty or still the hub defaults and few/no devices assigned.
  const rooms = state.rooms || [];
  if (rooms.length === 0) return true;
  const defaults = ["Living Room", "Bedroom", "Kitchen"];
  const looksDefault = rooms.length <= 3 && rooms.every((r) => defaults.includes(r));
  return looksDefault;
}

export function maybeOpenSetup() {
  if (localStorage.getItem("setup-skip") === "1") return;
  if (!state.ready) return;
  if (!shouldOfferSetup()) return;
  if (document.querySelector(".setup-wizard")) return;
  openHomeSetup();
}

export function openHomeSetup() {
  let count = Math.min(8, Math.max(2, state.rooms.length || 3));
  let layoutId = state.settings.home_layout_id || "1bhk";
  if (!LAYOUTS.some((l) => l.id === layoutId)) layoutId = "1bhk";
  let names = LAYOUTS.find((l) => l.id === layoutId).rooms(count);
  let step = 1;

  const body = h("div", { class: "setup-body" });
  const actions = h("div", { class: "setup-actions" });

  const el = h("div", { class: "modal setup-wizard", role: "dialog", "aria-label": "Arrange your home" },
    h("div", { class: "setup-brand" }, icon("home", 22), h("div", null,
      h("div", { class: "setup-title" }, "Arrange your home"),
      h("div", { class: "muted setup-sub" }, "Pick a layout, name the rooms, then customize anytime."))),
    body, actions);

  function paint() {
    body.replaceChildren();
    actions.replaceChildren();

    if (step === 1) {
      const countLabel = h("div", { class: "setup-count" }, String(count));
      const dec = btn("−", { cls: "icon" }, () => {
        count = Math.max(2, count - 1);
        names = LAYOUTS.find((l) => l.id === layoutId).rooms(count);
        setText(countLabel, String(count));
      });
      const inc = btn("+", { cls: "icon" }, () => {
        count = Math.min(8, count + 1);
        names = LAYOUTS.find((l) => l.id === layoutId).rooms(count);
        setText(countLabel, String(count));
      });
      body.append(
        h("p", { class: "setup-step-label" }, "How many rooms?"),
        h("div", { class: "setup-stepper" }, dec, countLabel, inc),
        h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "8px" } }, "Include living spaces, bedrooms, kitchen, and baths."));
      actions.append(
        btn("Skip for now", { cls: "ghost" }, () => { localStorage.setItem("setup-skip", "1"); close(); }),
        btn("Next", { cls: "primary" }, () => { step = 2; paint(); }));
    } else if (step === 2) {
      const grid = h("div", { class: "setup-layouts" });
      for (const L of LAYOUTS) {
        const card = h("button", { class: "setup-layout" + (L.id === layoutId ? " on" : ""), type: "button" },
          h("div", { class: "t" }, L.name),
          h("div", { class: "s" }, L.desc),
          h("div", { class: "setup-layout-preview" }, ...previewDots(L.id)));
        card.addEventListener("click", () => {
          layoutId = L.id;
          names = L.rooms(count);
          paint();
        });
        grid.append(card);
      }
      body.append(h("p", { class: "setup-step-label" }, "Choose a pre-layout"), grid);
      actions.append(
        btn("Back", { cls: "ghost" }, () => { step = 1; paint(); }),
        btn("Next", { cls: "primary" }, () => { step = 3; paint(); }));
    } else {
      const list = h("div", { class: "setup-names" });
      names.forEach((n, i) => {
        const tint = defaultTint(n);
        const input = h("input", { type: "text", value: n });
        input.addEventListener("input", () => { names[i] = input.value; });
        list.append(h("div", { class: "setup-name-row" },
          h("span", { class: `setup-tint-swatch tint-${tint}`, title: tint }),
          input));
      });
      body.append(
        h("p", { class: "setup-step-label" }, "Name your rooms"),
        h("p", { class: "muted", style: { fontSize: "12.5px", marginBottom: "10px" } }, "You can change tints and icons later from Rooms."),
        list);
      actions.append(
        btn("Back", { cls: "ghost" }, () => { step = 2; paint(); }),
        btn("Apply layout", { cls: "primary" }, () => apply()));
    }
  }

  async function apply() {
    const cleaned = names.map((n) => n.trim()).filter(Boolean);
    if (cleaned.length < 2) {
      toast("Need at least two rooms", "err");
      return;
    }
    // Unique names
    const seen = new Set();
    const unique = cleaned.map((n) => {
      let name = n;
      let k = 2;
      while (seen.has(name)) name = `${n} ${k++}`;
      seen.add(name);
      return name;
    });
    const meta = {};
    for (const name of unique) {
      meta[name] = { tint: defaultTint(name), icon: defaultIcon(name) };
    }
    try {
      await run("rooms_apply", { names: unique, layout: layoutId, room_meta: meta }, "Home arranged");
      localStorage.removeItem("setup-skip");
      close();
      notify();
    } catch (_) {}
  }

  function close() {
    el.remove();
    document.querySelector(".setup-scrim")?.remove();
  }

  const scrim = h("div", { class: "scrim setup-scrim" });
  scrim.addEventListener("click", () => {}); // require explicit skip/apply
  document.getElementById("overlay").append(scrim, el);
  paint();
}

function previewDots(layoutId) {
  const map = {
    studio: ["a", "b", "c"],
    "1bhk": ["a", "a", "b", "b"],
    "2bhk": ["a", "b", "b", "c", "c"],
    open: ["a", "b", "b", "c"],
  };
  return (map[layoutId] || ["a", "b"]).map((c) => h("i", { class: `pv ${c}` }));
}

/** Small modal to edit tint/icon for one room. */
export function openRoomCustomize(roomName) {
  const cur = allRoomMeta([roomName], state.settings)[roomName];
  let tint = cur.tint;
  let iconName = cur.icon;
  const swatches = h("div", { class: "setup-tints" });
  const icons = h("div", { class: "setup-icons" });
  const ICON_OPTS = ["sofa", "moon", "sparkles", "devices", "climate", "rooms", "bulb", "media"];

  function paintSwatches() {
    swatches.replaceChildren(...TINTS.map((t) => {
      const b = h("button", { class: `setup-tint-swatch tint-${t.id}` + (t.id === tint ? " on" : ""), type: "button", title: t.label });
      b.addEventListener("click", () => { tint = t.id; paintSwatches(); });
      return b;
    }));
  }
  function paintIcons() {
    icons.replaceChildren(...ICON_OPTS.map((id) => {
      const b = h("button", { class: "setup-icon-btn" + (id === iconName ? " on" : ""), type: "button", title: id }, icon(id, 18));
      b.addEventListener("click", () => { iconName = id; paintIcons(); });
      return b;
    }));
  }
  paintSwatches();
  paintIcons();

  modal(`Customize ${roomName}`, h("div", { class: "stack" },
    h("div", { class: "eyebrow" }, "Background tint"),
    swatches,
    h("div", { class: "eyebrow", style: { marginTop: "8px" } }, "Icon"),
    icons), [
    (close) => btn("Cancel", {}, close),
    (close) => btn("Save", { cls: "primary" }, async () => {
      const meta = { ...(state.settings.room_meta || {}) };
      meta[roomName] = { tint, icon: iconName };
      await run("settings_set", { room_meta: meta }, "Room updated").catch(() => {});
      close();
    }),
  ]);
}
