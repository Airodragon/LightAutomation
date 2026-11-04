import { h, icon, reconcile, setText, setClass, btn, modal } from "../dom.js";
import { state, L, notify } from "../store.js";
import { run, setDevice } from "../actions.js";
import { openAddDevice } from "./devices.js";

function cameras() {
  return state.devices.filter((d) => d.kind === "camera" || d.caps.includes("camera"));
}

function locks() {
  return state.devices.filter((d) => d.kind === "lock" || d.caps.includes("lock"));
}

function alarms() {
  return state.devices.filter((d) => d.kind === "alarm" || d.caps.includes("alarm"));
}

function sensors() {
  return state.devices.filter((d) => d.caps.includes("binary") || (d.kind === "sensor" && ["door", "window", "motion", "occupancy", "opening"].includes(L(d.id).unit)));
}

function streamUrl(d) {
  const l = L(d.id);
  if (l.media_image) {
    // HA entity_picture is often relative
    if (l.media_image.startsWith("http")) return l.media_image;
    const base = (state.settings.ha_url || "").replace(/\/$/, "");
    return base ? `${base}${l.media_image}` : l.media_image;
  }
  if (d.note && d.note.startsWith("http")) return d.note; // go2rtc / MJPEG override
  return "";
}

export function createCameras() {
  const grid = h("div", { class: "cam-grid" });
  const security = h("div", { class: "security-strip" });
  const empty = h("div", { class: "empty" },
    h("h3", null, "No cameras yet"),
    h("p", null, "Import camera, lock, and alarm entities from Home Assistant. Paste a go2rtc or MJPEG URL in a camera’s note for a direct stream."),
    btn("Open devices", { cls: "primary", icon: "devices", size: 16 }, () => openAddDevice("ha")));

  const el = h("section", { class: "stack" },
    h("div", { class: "section-title" }, h("h2", null, "Security"), h("div", { class: "grow" }),
      btn("Ring doorbell", { cls: "small", icon: "sparkles", size: 14 }, () => run("doorbell_ring", {}))),
    security,
    h("div", { class: "section-title" }, h("h2", null, "Cameras")),
    grid, empty);

  function makeCam() {
    const img = h("div", { class: "cam-frame" }, icon("film", 28));
    const name = h("div", { class: "t" });
    const sub = h("div", { class: "s" });
    const card = h("button", { class: "cam-card panel", type: "button" }, img, h("div", { class: "cam-meta" }, name, sub));
    card._r = { img, name, sub };
    card.addEventListener("click", () => openLive(card._d));
    return card;
  }

  function updateCam(card, d) {
    card._d = d;
    const l = L(d.id);
    setText(card._r.name, d.name);
    setText(card._r.sub, l.value || (l.online ? "Live" : "Offline"));
    setClass(card, "offline", !l.online);
    const url = streamUrl(d);
    if (url && card._r.img.dataset.url !== url) {
      card._r.img.dataset.url = url;
      card._r.img.style.backgroundImage = `url(${JSON.stringify(url)})`;
      card._r.img.replaceChildren();
    } else if (!url) {
      card._r.img.dataset.url = "";
      card._r.img.style.backgroundImage = "";
      card._r.img.replaceChildren(icon("film", 28));
    }
  }

  function openLive(d) {
    if (!d) return;
    const url = streamUrl(d);
    const frame = h("div", { class: "cam-live" });
    if (url) {
      frame.style.backgroundImage = `url(${JSON.stringify(url)})`;
      // Also try img for refresh
      const img = h("img", { src: url, alt: d.name });
      img.onerror = () => img.remove();
      frame.append(img);
    } else {
      frame.append(h("p", { class: "muted" }, "No stream URL. Set HA camera entity_picture or put an MJPEG/go2rtc URL in the device note."));
    }
    const actions = [];
    const doorLocks = locks();
    modal(d.name, frame, [
      (close) => btn("Close", {}, close),
      ...(doorLocks.length ? [(close) => btn("Unlock door", { cls: "primary" }, () => {
        setDevice(doorLocks[0].id, { on: false });
        close();
      })] : []),
      (close) => btn("Talk (Home Call)", { cls: "small" }, () => {
        location.hash = "#/call";
        close();
      }),
    ]);
  }

  function update() {
    const cams = cameras();
    empty.style.display = cams.length ? "none" : "";
    reconcile(grid, cams, (d) => d.id, makeCam, updateCam);

    // Security strip
    security.replaceChildren();
    for (const a of alarms()) {
      const l = L(a.id);
      const armed = !!l.on;
      const armBtn = btn(armed ? "Disarm" : "Arm away", { cls: "small primary" }, () => {
        setDevice(a.id, { media: armed ? "disarm" : "arm_away" });
      });
      security.append(
        h("div", { class: "panel security-card" },
          h("div", { class: "row" },
            icon("power", 18),
            h("div", { class: "grow" }, h("div", { class: "t" }, a.name), h("div", { class: "s" }, l.value || "—")),
            armBtn)));
    }
    for (const lk of locks()) {
      const l = L(lk.id);
      const locked = l.on === true || l.value === "locked";
      const lockBtn = btn(locked ? "Unlock" : "Lock", { cls: "small" }, () => setDevice(lk.id, { on: !locked }));
      security.append(
        h("div", { class: "panel security-card" },
          h("div", { class: "row" },
            icon("cover", 18),
            h("div", { class: "grow" }, h("div", { class: "t" }, lk.name), h("div", { class: "s" }, l.value || (locked ? "Locked" : "Unlocked"))),
            lockBtn)));
    }
    const sens = sensors().slice(0, 8);
    if (sens.length) {
      const strip = h("div", { class: "sensor-pills" });
      for (const s of sens) {
        const l = L(s.id);
        const open = l.on === true || l.value === "on";
        strip.append(h("span", { class: "pill" + (open ? " warn" : " ok") }, `${s.name}: ${l.value || (open ? "open" : "ok")}`));
      }
      security.append(strip);
    }
    if (!security.firstChild) {
      security.append(h("p", { class: "muted" }, "Import alarm_control_panel, lock, and door/window sensors from Home Assistant for a security strip."));
    }
  }

  return { el, update };
}
