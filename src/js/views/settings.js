import { h, icon, setText, setClass, btn, toast, confirmBox } from "../dom.js";
import { state, notify } from "../store.js";
import { run } from "../actions.js";
import { isTauri, call, setPin, getPin, openUrl } from "../api.js";
import { toggle } from "../components.js";
import { openAddDevice } from "./devices.js";

function row(title, desc, control) {
  return h("div", { class: "row", style: { padding: "12px 0", borderTop: "1px solid var(--border)" } },
    h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, title), desc ? h("div", { class: "muted", style: { fontSize: "12.5px" } }, desc) : null), control);
}

export function createSettings() {
  // appearance
  const themeSeg = h("div", { class: "seg" });
  [["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]].forEach(([t, label]) => {
    const b = h("button", null, label);
    b.dataset.t = t;
    b.addEventListener("click", () => { localStorage.setItem("theme", t); run("settings_set", { theme: t }).catch(() => {}); state.settings.theme = t; notify(); });
    themeSeg.append(b);
  });
  const latIn = h("input", { type: "number", step: "0.0001", placeholder: "Latitude", style: { maxWidth: "120px" } });
  const lonIn = h("input", { type: "number", step: "0.0001", placeholder: "Longitude", style: { maxWidth: "120px" } });
  const saveLoc = () => run("settings_set", { lat: latIn.value === "" ? null : +latIn.value, lon: lonIn.value === "" ? null : +lonIn.value }, "Location saved").catch(() => {});
  latIn.addEventListener("change", saveLoc);
  lonIn.addEventListener("change", saveLoc);
  const unitSeg = h("div", { class: "seg" });
  ["C", "F"].forEach((u) => {
    const b = h("button", null, `°${u}`);
    b.dataset.u = u;
    b.addEventListener("click", () => run("settings_set", { weather_units: u }).catch(() => {}));
    unitSeg.append(b);
  });
  const dimTg = toggle();
  dimTg.addEventListener("click", () => { state.settings.idle_dim = !state.settings.idle_dim; notify(); run("settings_set", { idle_dim: state.settings.idle_dim }).catch(() => {}); });
  const delaySeg = h("div", { class: "seg" });
  [[30, "30s"], [60, "1 min"], [120, "2 min"], [300, "5 min"]].forEach(([secs, label]) => {
    const b = h("button", null, label);
    b.dataset.s = String(secs);
    b.addEventListener("click", () => {
      state.settings.screensaver_secs = secs;
      notify();
      run("settings_set", { screensaver_secs: secs }).catch(() => {});
    });
    delaySeg.append(b);
  });

  // web
  const webTg = toggle();
  webTg.addEventListener("click", () => run("settings_set", { web_enabled: !state.settings.web_enabled }).catch(() => {}));
  const port = h("input", { type: "number", min: 1024, max: 65535, style: { maxWidth: "100px" } });
  port.addEventListener("change", () => run("settings_set", { web_port: +port.value }, "Port updated").catch(() => {}));
  const pin = h("input", { type: "password", placeholder: "PIN (optional)", style: { maxWidth: "150px" } });
  pin.addEventListener("change", () => run("settings_set", { web_pin: pin.value }, pin.value ? "PIN set" : "PIN removed").catch(() => {}));
  const urls = h("div", { class: "stack", style: { gap: "8px", marginTop: "8px" } });
  const webErr = h("div", { class: "banner bad", style: { display: "none" } });
  const webBox = h("div", { class: "card" },
    h("h3", null, "Wall screen & other devices"),
    h("p", { class: "muted", style: { fontSize: "12.5px", marginBottom: "6px" } }, "Turn this on and open the address below on a tablet, phone or any browser on the same Wi-Fi. It shows the same controls and stays in sync with this app. Keep this Mac awake (or run the hub service) for the screen to work."),
    row("Enable web access", null, webTg),
    row("Port", null, port),
    row("PIN", "Asks for this PIN before the screen can control anything. Leave empty for no PIN.", pin),
    webErr, urls);
  if (!isTauri) {
    webBox.replaceChildren(h("h3", null, "Wall screen & other devices"), h("p", { class: "muted" }, "Web access is configured from the Mac app. You are using it right now."));
  }

  // HA
  const haStatus = h("div", { class: "muted" });
  const haBtns = h("div", { class: "row" });
  const haBox = h("div", { class: "card" }, h("h3", null, "Home Assistant"), haStatus, h("div", { style: { height: "10px" } }), haBtns);

  const enterKiosk = () => import("../app.js").then((m) => m.enterKiosk());
  const startScreensaver = () => import("../app.js").then((m) => m.startScreensaver());
  const wallName = h("input", { type: "text", placeholder: "Kitchen", style: { maxWidth: "220px" } });
  wallName.addEventListener("change", async () => {
    const { setClientName, registerWall } = await import("../wall.js");
    setClientName(wallName.value);
    registerWall();
    toast("Wall screen renamed");
  });

  const el = h("section", { class: "stack", style: { maxWidth: "760px" } },
    h("div", { class: "card" },
      h("h3", null, "Appearance"),
      row("Theme", "Auto follows sunrise and sunset for this location.", themeSeg),
      row("Weather location", "Use device location for accurate weather, or enter coordinates.",
        h("div", { class: "row", style: { flexWrap: "wrap" } },
          btn("Use my location", { cls: "primary small", icon: "target", size: 14 }, async () => {
            const { requestLocation } = await import("../permissions.js");
            await requestLocation({ explain: true, force: true });
          }),
          latIn, lonIn)),
      row("Temperature", null, unitSeg),
      row("Screensaver", "Ambient clock and weather after idle in screen mode. Touch or the bottom handle to wake.", dimTg),
      row("Screensaver delay", null, delaySeg),
      row("Screen mode", "Hides the sidebar and makes controls larger. Press Esc to leave.",
        h("div", { class: "row" },
          btn("Enter screen mode", { icon: "fullscreen", size: 16 }, () => enterKiosk()),
          btn("Preview screensaver", { cls: "small" }, () => startScreensaver()))),
      row("This wall screen", "Name used for Home Call / intercom.", wallName)),
    webBox,
    haBox,
    h("div", { class: "card" },
      h("h3", null, "Devices"),
      row("Find devices", "Scan for WiZ and other devices on this network.", btn("Open scanner", { icon: "search", size: 16 }, () => openAddDevice("scan"))),
      row("Remove offline devices", "Clears devices that stopped answering.", btn("Remove offline", { cls: "danger" }, () => confirmBox("Remove offline devices?", "Every device that is not responding will be removed.", "Remove", () => run("prune_offline", {}, "Done")))),
      isTauri ? null : row("Hub PIN", "Saved in this browser.", btn("Forget PIN", {}, () => { setPin(""); toast("PIN forgotten"); }))));

  function renderHa() {
    const c = state.settings.ha_connected;
    const sig = c + "|" + state.settings.ha_url;
    if (haBox.dataset.sig === sig) return;
    haBox.dataset.sig = sig;
    haStatus.textContent = c ? `Connected to ${state.settings.ha_url}` : "Not connected. Connect to control Hue, Zigbee, HomeKit, Matter, TVs and thermostats through this hub.";
    haBtns.replaceChildren();
    if (c) {
      haBtns.append(btn("Import entities", { cls: "primary", icon: "plus", size: 16 }, () => openAddDevice("ha")),
        btn("Disconnect", { cls: "danger" }, () => run("ha_disconnect", {}, "Disconnected")));
    } else if (isTauri) {
      haBtns.append(btn("Connect", { cls: "primary", icon: "link", size: 16 }, () => openAddDevice("ha")));
    }
  }

  function update() {
    const s = state.settings;
    themeSeg.querySelectorAll("button").forEach((b) => setClass(b, "active", b.dataset.t === (localStorage.getItem("theme") || s.theme || "auto")));
    unitSeg.querySelectorAll("button").forEach((b) => setClass(b, "active", b.dataset.u === (s.weather_units || "C")));
    if (document.activeElement !== latIn) latIn.value = s.lat ?? "";
    if (document.activeElement !== lonIn) lonIn.value = s.lon ?? "";
    if (document.activeElement !== wallName) {
      import("../wall.js").then((m) => { if (document.activeElement !== wallName) wallName.value = m.clientName(); }).catch(() => {});
    }
    setClass(dimTg, "on", s.idle_dim !== false);
    delaySeg.querySelectorAll("button").forEach((b) => setClass(b, "active", +b.dataset.s === (s.screensaver_secs || 60)));
    renderHa();
    if (!isTauri) return;
    setClass(webTg, "on", !!s.web_enabled);
    if (document.activeElement !== port) port.value = s.web_port;
    pin.placeholder = s.web_pin_set ? "PIN is set" : "PIN (optional)";
    const w = state.web || {};
    webErr.style.display = w.error ? "" : "none";
    setText(webErr, w.error || "");
    const sig = (w.urls || []).join(",") + w.running;
    if (urls.dataset.sig !== sig) {
      urls.dataset.sig = sig;
      urls.replaceChildren(...(w.running ? (w.urls.length ? w.urls : [`http://localhost:${w.port}`]).map((u) =>
        h("div", { class: "item" }, icon("wifi", 18), h("div", { class: "grow mono", style: { fontWeight: "700", userSelect: "text" } }, u),
          btn("Copy", { cls: "small", icon: "copy", size: 14 }, () => { navigator.clipboard && navigator.clipboard.writeText(u); toast("Copied", "ok"); }),
          btn("Open", { cls: "small" }, () => openUrl(u)))) : []));
    }
  }
  return { el, update };
}
