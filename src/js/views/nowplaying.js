// Now Playing — system media (Spotify, Chrome, Music…), HA / Cast speakers, Music.app AirPlay.
import { h, icon, setText, setClass, setAttr, btn, modal, reconcile } from "../dom.js";
import { state, L, refreshMusic, notify } from "../store.js";
import { run, setDevice } from "../actions.js";
import { slider, setSlider } from "../components.js";
import { isTauri, call } from "../api.js";

function speakers() {
  return state.devices.filter((d) => d.kind === "media" || d.caps.includes("media") || d.caps.includes("cast"));
}

/** Prefer Mac system Now Playing, then HA/Cast with real metadata, then Music.app. */
export function activeMedia() {
  const m = state.music;
  if (m && m.available && (m.title || m.playing || m.kind === "call")) {
    const isCall = m.kind === "call" || /facetime|whatsapp|zoom/i.test(m.app || "");
    return {
      source: m.source === "music" ? "music" : "system",
      id: null,
      title: m.title || (isCall ? `${m.app || "Phone"} call` : "Now playing"),
      artist: [m.artist, m.album].filter(Boolean).join(" · ") || m.app || "",
      app: m.app || (m.source === "music" ? "Music" : "Mac"),
      image: m.image || "",
      playing: !!m.playing || isCall,
      volume: m.volume ?? 0.5,
      kind: isCall ? "call" : "media",
    };
  }
  const withMeta = speakers().find((d) => {
    const l = L(d.id);
    return l.online && l.media_title && (l.value === "playing" || l.on);
  });
  if (withMeta) {
    const l = L(withMeta.id);
    return {
      source: "device",
      id: withMeta.id,
      title: l.media_title,
      artist: l.media_artist || l.media_app || withMeta.room || "",
      app: l.media_app || withMeta.name,
      image: l.media_image || "",
      playing: l.value === "playing" || !!l.on,
      volume: l.volume ?? 0.5,
    };
  }
  const castOn = speakers().find((d) => {
    const l = L(d.id);
    return l.online && (l.value === "playing" || (l.on && l.media_app));
  });
  if (castOn) {
    const l = L(castOn.id);
    return {
      source: "device",
      id: castOn.id,
      title: l.media_app || castOn.name,
      artist: castOn.room || castOn.driver || "Speaker",
      app: castOn.name,
      image: "",
      playing: l.value === "playing" || !!l.on,
      volume: l.volume ?? 0.5,
    };
  }
  return null;
}

export function openOutputsPicker() {
  const selected = new Set(state.settings.cast_outputs || []);
  const airplaySel = new Set();
  const list = h("div", { class: "list" });
  const airplayBox = h("div", { class: "list", style: { marginTop: "10px" } });
  const body = h("div", null,
    h("p", { class: "muted", style: { marginBottom: "10px", fontSize: "12.5px" } },
      "Pick speakers on your Wi‑Fi. Chromecast and Home Assistant players work here; AirPlay multi-room uses Music.app on this Mac."),
    h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Speakers"),
    list, airplayBox);

  function paintDevices() {
    reconcile(list, speakers(), (d) => d.id,
      () => {
        const row = h("button", { class: "item", type: "button" },
          h("div", { class: "ico" }, icon("media", 16)),
          h("div", { class: "grow" }, h("div", { class: "t" }), h("div", { class: "s" })),
          h("span", { class: "pill" }));
        row.addEventListener("click", () => {
          if (selected.has(row._id)) selected.delete(row._id);
          else selected.add(row._id);
          paintDevices();
        });
        return row;
      },
      (row, d) => {
        row._id = d.id;
        setText(row.querySelector(".t"), d.name);
        setText(row.querySelector(".s"), `${d.room || "No room"} · ${d.driver}`);
        const on = selected.has(d.id);
        setText(row.querySelector(".pill"), on ? "On" : "Off");
        setClass(row.querySelector(".pill"), "ok", on);
        row.style.outline = on ? "1px solid var(--accent)" : "";
      });
    if (!speakers().length) list.replaceChildren(h("p", { class: "muted" }, "No speakers yet. Add a Chromecast from Scan, or import media players from Home Assistant."));
  }

  async function paintAirplay() {
    if (!isTauri) {
      airplayBox.replaceChildren(h("p", { class: "muted", style: { fontSize: "12.5px" } }, "AirPlay multi-room is available in the Mac app."));
      return;
    }
    try {
      const devices = await call("music_airplay_list");
      airplayBox.replaceChildren(h("div", { class: "eyebrow", style: { margin: "8px 0 6px" } }, "AirPlay (Music.app)"));
      for (const d of devices || []) {
        if ((d.kind || "").toLowerCase() === "computer") continue;
        if (d.selected) airplaySel.add(d.name);
        const row = h("button", { class: "item", type: "button" },
          h("div", { class: "ico" }, icon("wifi", 16)),
          h("div", { class: "grow" }, h("div", { class: "t" }, d.name), h("div", { class: "s" }, "AirPlay")),
          h("span", { class: "pill" }, airplaySel.has(d.name) ? "On" : "Off"));
        setClass(row.querySelector(".pill"), "ok", airplaySel.has(d.name));
        row.addEventListener("click", () => {
          if (airplaySel.has(d.name)) airplaySel.delete(d.name);
          else airplaySel.add(d.name);
          paintAirplay();
        });
        airplayBox.append(row);
      }
    } catch (_) {
      airplayBox.replaceChildren(h("p", { class: "muted" }, "Open Music.app once to enable AirPlay routing."));
    }
  }

  paintDevices();
  paintAirplay();

  modal("Outputs", body, [
    (close) => btn("Cancel", {}, () => close()),
    (close) => btn("Apply", { cls: "primary" }, async () => {
      try {
        await run("outputs_set", {
          ids: [...selected],
          airplay: [...airplaySel],
        });
        state.settings.cast_outputs = [...selected];
        notify();
        close();
      } catch (_) {}
    }),
  ]);
}

export function createNowPlaying(opts = {}) {
  const compact = !!opts.compact;
  const art = h("div", { class: "np-art" }, icon("media", 22));
  const title = h("div", { class: "np-title" });
  const artist = h("div", { class: "np-artist" });
  const app = h("div", { class: "np-app" });
  const playBtn = h("button", { class: "btn icon", title: "Play / Pause", "aria-label": "Play or pause" }, icon("play", 18));
  const prevBtn = h("button", { class: "btn icon", title: "Previous", "aria-label": "Previous track" }, "‹");
  const nextBtn = h("button", { class: "btn icon", title: "Next", "aria-label": "Next track" }, "›");
  const vol = slider({ min: 0, max: 100, onInput: (v) => onVolume(v / 100) });
  const outBtn = btn("Outputs", { cls: "small", icon: "wifi", size: 14 }, () => openOutputsPicker());
  const emptyOut = btn("Outputs", { cls: "small", icon: "wifi", size: 14 }, () => openOutputsPicker());
  const empty = h("div", { class: "np-empty muted" }, "Nothing playing · ", emptyOut);

  const el = h("div", { class: "panel nowplaying" + (compact ? " compact" : "") },
    art,
    h("div", { class: "np-meta grow" }, title, artist, app),
    h("div", { class: "np-controls" }, prevBtn, playBtn, nextBtn),
    h("div", { class: "np-vol" }, icon("energy", 14), vol),
    outBtn,
    empty);

  let current = null;

  function onVolume(v) {
    if (!current) return;
    if (current.source === "music" || current.source === "system") run("music_volume", { volume: v }).catch(() => {});
    else if (current.id) setDevice(current.id, { volume: v });
  }

  async function transport(action) {
    if (!current) return openOutputsPicker();
    if (current.source === "music" || current.source === "system") {
      await run("music_transport", { action: action === "play" || action === "pause" ? "playpause" : action }).catch(() => {});
      refreshMusic();
    } else if (current.id) {
      if (action === "play" || action === "pause") {
        setDevice(current.id, { media: L(current.id).value === "playing" ? "pause" : "play" });
      } else {
        setDevice(current.id, { media: action });
      }
    }
  }

  playBtn.addEventListener("click", () => transport(current && current.playing ? "pause" : "play"));
  prevBtn.addEventListener("click", () => transport("prev"));
  nextBtn.addEventListener("click", () => transport("next"));

  let lastMusic = 0;
  function update() {
    // Poll faster while a call may be active
    const interval = (state.music && state.music.kind === "call") ? 1500 : 2500;
    if (isTauri && performance.now() - lastMusic > interval) {
      lastMusic = performance.now();
      refreshMusic();
    }
    current = activeMedia();
    const show = !!current;
    empty.style.display = show ? "none" : "";
    art.style.display = title.style.display = artist.style.display = playBtn.style.display =
      prevBtn.style.display = nextBtn.style.display = show ? "" : "none";
    app.style.display = show ? "" : "none";
    el.querySelector(".np-vol").style.display = show ? "" : "none";
    outBtn.style.display = show ? "" : "none";
    setClass(el, "playing", !!(current && current.playing));
    if (!show) {
      setText(title, "");
      setText(app, "");
      return;
    }
    setText(title, current.title || "Now playing");
    setText(artist, current.artist || "");
    setText(app, current.app || "");
    playBtn.replaceChildren(icon(current.playing ? "stop" : "play", 18));
    setAttr(playBtn, "title", current.playing ? "Pause" : "Play");
    setSlider(vol, Math.round((current.volume ?? 0.5) * 100));
    if (current.image) {
      art.style.backgroundImage = `url(${JSON.stringify(current.image)})`;
      art.replaceChildren();
    } else {
      art.style.backgroundImage = "";
      art.replaceChildren(icon("media", 22));
    }
  }

  return { el, update, openOutputsPicker };
}
