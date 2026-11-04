// Wall notification toasts + incoming call / doorbell overlays.
import { h, icon, btn } from "./dom.js";
import { call } from "./api.js";
import { notify } from "./store.js";
import { clientId } from "./wall.js";

let bannerRoot = null;
let ringRoot = null;
let onRingAnswer = null;

function ensureBanner() {
  if (bannerRoot) return bannerRoot;
  bannerRoot = h("div", { id: "wall-banners", class: "wall-banners" });
  document.body.append(bannerRoot);
  return bannerRoot;
}

export function wallNotify(ev) {
  if (ev.from && ev.from === clientId()) return;
  const title = ev.title || "Notice";
  const body = ev.body || "";
  const kind = ev.kind || "info";
  // Call events use the full-screen ring UI — skip stacked banners.
  if (kind === "call") return;
  const box = ensureBanner();
  // Replace prior notice of same kind to avoid overlap piles
  for (const old of [...box.querySelectorAll(`.wall-banner.${kind}`)]) old.remove();
  const el = h("div", { class: `wall-banner ${kind}` },
    h("div", { class: "grow" }, h("b", null, title), body ? h("div", { class: "muted" }, body) : null),
    h("button", { class: "btn icon ghost", type: "button", title: "Dismiss" }, icon("close", 16)));
  el.querySelector("button").addEventListener("click", () => el.remove());
  box.append(el);
  setTimeout(() => el.remove(), kind === "doorbell" ? 12000 : 5000);
}

export function showRing(ev, { onAnswer, onDecline } = {}) {
  if (ev.from && ev.from === clientId()) return;
  // Don't ring ourselves while already placing an outbound call to everyone
  if (document.body.dataset.outboundCall === "1") return;
  hideRing();
  onRingAnswer = onAnswer || null;
  ringRoot = h("div", { id: "wall-ring", class: "wall-ring", role: "dialog", "aria-label": "Incoming call" },
    h("div", { class: "wall-ring-card" },
      h("div", { class: "wall-ring-pulse" }),
      h("div", { class: "eyebrow" }, ev.kind === "doorbell" ? "Doorbell" : "Incoming call"),
      h("h2", null, ev.name || "Someone"),
      h("p", { class: "muted" }, ev.body || (ev.kind === "doorbell" ? "Someone is at the door" : "Home Call · Lights Studio")),
      h("div", { class: "wall-ring-actions" },
        btn("Decline", { cls: "danger", icon: "close", size: 18 }, () => {
          onDecline && onDecline(ev);
          hideRing();
        }),
        btn(ev.kind === "doorbell" ? "View" : "Answer", { cls: "primary", icon: "check", size: 18 }, () => {
          onAnswer && onAnswer(ev);
          hideRing();
        }))));
  document.body.append(ringRoot);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ev.kind === "doorbell" ? 880 : 520;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 180);
  } catch (_) {}
}

export function hideRing() {
  if (ringRoot) {
    ringRoot.remove();
    ringRoot = null;
  }
  onRingAnswer = null;
}

export function wireHubEvents(handlers = {}) {
  return {
    wall_notify: (p) => {
      wallNotify(p);
      handlers.wall_notify && handlers.wall_notify(p);
    },
    wall_ring: (p) => {
      if (p?.from && p.from === clientId()) return;
      if (p?.to && p.to !== clientId() && !p.all) return;
      showRing({ ...p, kind: "call" }, {
        onAnswer: () => handlers.answerHome && handlers.answerHome(p),
        onDecline: () => handlers.declineHome && handlers.declineHome(p),
      });
    },
    doorbell: (p) => {
      showRing({ ...p, kind: "doorbell", body: "Live view & talk-down" }, {
        onAnswer: () => {
          if (handlers.answerDoorbell) handlers.answerDoorbell(p);
          else {
            location.hash = "#/cameras";
            notify();
          }
        },
      });
    },
    presence: () => notify(),
    webrtc: (p) => handlers.webrtc && handlers.webrtc(p),
    home_call: (p) => handlers.home_call && handlers.home_call(p),
    call_started: (p) => {
      if (p?.app === "home") return;
      wallNotify({ title: "Opened", body: p.name || p.app, kind: "info" });
    },
  };
}

export async function pushNotify(title, body, kind = "info") {
  try {
    await call("wall_notify", { title, body, kind });
  } catch (_) {
    wallNotify({ title, body, kind });
  }
}
