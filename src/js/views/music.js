// Music route: Now Playing + multi-room speaker grid.
import { h, icon, setText, setClass, btn, reconcile } from "../dom.js";
import { state, L, notify } from "../store.js";
import { run, setDevice } from "../actions.js";
import { createNowPlaying, openOutputsPicker } from "./nowplaying.js";
import { toggle, slider, setSlider } from "../components.js";
import { isTauri } from "../api.js";
import { openAddDevice } from "./devices.js";

function speakers() {
  return state.devices.filter((d) => d.kind === "media" || d.caps.includes("media") || d.caps.includes("cast"));
}

export function createMusic() {
  const np = createNowPlaying();
  const grid = h("div", { class: "speaker-grid" });
  const empty = h("div", { class: "empty" },
    h("h3", null, "No speakers yet"),
    h("p", null, "Scan for Chromecast devices, or import media players from Home Assistant. AirPlay multi-room uses Music.app on this Mac."),
    h("div", { class: "row", style: { justifyContent: "center", marginTop: "12px" } },
      btn("Scan network", { cls: "primary", icon: "search", size: 16 }, () => openAddDevice("scan")),
      isTauri ? btn("AirPlay outputs", { icon: "wifi", size: 16 }, () => openOutputsPicker()) : null));

  const hint = h("div", { class: "banner" },
    icon("media", 18),
    h("div", { class: "grow" },
      h("b", null, "Multi-room audio"),
      h("span", { class: "muted" }, "  Select speakers below, then Apply group. AirPlay requires Music.app on this Mac.")));

  const apply = btn("Apply group", { cls: "primary small" }, () => {
    const ids = [...grid.querySelectorAll(".speaker.on")].map((el) => el._id).filter(Boolean);
    run("outputs_set", { ids, airplay: state.ui._airplay || [] }).then(() => {
      state.settings.cast_outputs = ids;
      notify();
    }).catch(() => {});
  });

  const el = h("section", { class: "stack" },
    np.el,
    hint,
    h("div", { class: "section-title" }, h("h2", null, "Speakers"), h("div", { class: "grow" }), apply,
      btn("Outputs…", { cls: "small", icon: "wifi", size: 14 }, () => openOutputsPicker())),
    grid, empty);

  function make() {
    const tg = toggle(true);
    const vol = slider({ min: 0, max: 100, onInput: (v) => setDevice(card._id, { volume: v / 100 }) });
    const name = h("div", { class: "t" });
    const sub = h("div", { class: "s" });
    const card = h("div", { class: "speaker panel" },
      h("div", { class: "row" }, h("div", { class: "ico" }, icon("media", 18)), h("div", { class: "grow" }, name, sub), tg),
      h("div", { class: "slider-wrap", style: { marginTop: "10px" } }, vol));
    card._r = { tg, vol, name, sub };
    tg.addEventListener("click", () => {
      const on = !card.classList.contains("on");
      setClass(card, "on", on);
      // membership only — Apply group commits
    });
    return card;
  }

  function updateCard(card, d) {
    const l = L(d.id);
    card._id = d.id;
    const r = card._r;
    setText(r.name, d.name);
    setText(r.sub, [d.room || "No room", l.media_title || l.value || d.driver].filter(Boolean).join(" · "));
    const selected = (state.settings.cast_outputs || []).includes(d.id);
    setClass(card, "on", selected);
    setClass(r.tg, "on", selected);
    r.vol.parentElement.style.display = d.caps.includes("volume") && l.online ? "" : "none";
    if (l.volume != null) setSlider(r.vol, Math.round(l.volume * 100));
  }

  function update() {
    np.update();
    const list = speakers();
    empty.style.display = list.length ? "none" : "";
    grid.style.display = list.length ? "" : "none";
    reconcile(grid, list, (d) => d.id, make, updateCard);
  }

  return { el, update };
}
