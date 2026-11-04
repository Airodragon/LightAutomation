// Request camera, mic, and location with a clear pre-prompt, then the OS dialog.
import { h, btn, modal, toast } from "./dom.js";
import { call, isTauri, openUrl } from "./api.js";
import { state, notify } from "./store.js";

function openPrivacy(pane) {
  // macOS System Settings deep links
  const urls = {
    camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    location: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
  };
  const url = urls[pane] || urls.camera;
  if (isTauri) openUrl(url);
  else window.open(url, "_blank");
}

function askModal({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    modal(title, h("p", { class: "muted", style: { fontSize: "13.5px", lineHeight: "1.45" } }, body), [
      (close) => btn("Not now", {}, () => { close(); resolve(false); }),
      (close) => btn(confirmLabel || "Continue", { cls: "primary" }, () => { close(); resolve(true); }),
    ]);
  });
}

/** Trigger the OS camera + microphone permission dialogs. */
export async function requestAv({ video = true, audio = true, explain = true } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This device cannot use camera or microphone", "err");
    return null;
  }
  if (explain) {
    const ok = await askModal({
      title: "Camera & microphone",
      body: "Home Call and intercom need access to your camera and microphone. macOS will ask next — choose Allow so wall screens can see and hear each other.",
      confirmLabel: "Allow access",
    });
    if (!ok) return null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: !!audio,
      video: video
        ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
    });
    toast("Camera & microphone ready", "ok");
    return stream;
  } catch (e) {
    const name = e && e.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      modal(
        "Permission blocked",
        h("div", null,
          h("p", { class: "muted", style: { fontSize: "13.5px", marginBottom: "10px" } },
            "macOS blocked camera or microphone for Lights Studio. Open System Settings → Privacy & Security, enable Camera and Microphone for Lights Studio, then try again."),
          h("div", { class: "row" },
            btn("Open Camera settings", { cls: "small" }, () => openPrivacy("camera")),
            btn("Open Microphone settings", { cls: "small" }, () => openPrivacy("microphone")))),
        [(close) => btn("OK", { cls: "primary" }, close)],
      );
    } else if (name === "NotFoundError") {
      toast("No camera or microphone found", "err");
    } else {
      toast(e.message || "Could not access camera/mic", "err");
    }
    return null;
  }
}

/** Ask for location, save lat/lon on the hub, refresh weather. */
export async function requestLocation({ explain = true, force = false } = {}) {
  if (!navigator.geolocation) {
    toast("Location is not available here", "err");
    return null;
  }
  const hasSaved = state.settings.lat != null && state.settings.lon != null;
  if (hasSaved && !force) return { lat: state.settings.lat, lon: state.settings.lon };

  if (explain) {
    const ok = await askModal({
      title: "Use your location",
      body: "Lights Studio uses your current location for accurate weather on the Home screen. macOS will ask next — choose Allow While Using the App.",
      confirmLabel: "Allow location",
    });
    if (!ok) return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        try {
          await call("settings_set", { lat, lon });
          state.settings.lat = lat;
          state.settings.lon = lon;
          const { refreshWeather } = await import("./store.js");
          await refreshWeather(true);
          notify();
          toast("Location updated for weather", "ok");
        } catch (_) {}
        resolve({ lat, lon });
      },
      (err) => {
        if (err.code === 1) {
          modal(
            "Location blocked",
            h("div", null,
              h("p", { class: "muted", style: { fontSize: "13.5px", marginBottom: "10px" } },
                "Location permission was denied. Enable it in System Settings → Privacy & Security → Location Services for Lights Studio, or enter coordinates in Settings."),
              btn("Open Location settings", { cls: "small" }, () => openPrivacy("location"))),
            [(close) => btn("OK", { cls: "primary" }, close)],
          );
        } else {
          toast("Could not read location — you can set it in Settings", "err");
        }
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60_000 },
    );
  });
}

/** Soft prompt once per install if we have no saved coords. */
export async function maybeAskLocationOnce() {
  if (localStorage.getItem("loc-asked") === "1") return;
  if (state.settings.lat != null && state.settings.lon != null) {
    localStorage.setItem("loc-asked", "1");
    return;
  }
  localStorage.setItem("loc-asked", "1");
  // Small delay so the UI is ready
  setTimeout(() => requestLocation({ explain: true }), 1200);
}
