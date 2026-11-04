import { h, icon, reconcile, setText, setClass, btn, modal, toast, closeOverlay } from "../dom.js";
import { state } from "../store.js";
import { call as hubCall } from "../api.js";
import { clientId, clientName, setClientName, onlinePeers } from "../wall.js";
import * as rtc from "../webrtc.js";
import { emptyBlock, illustNoPeer } from "../illustrations.js";

const EXTERNAL = [
  { id: "facetime", name: "FaceTime" },
  { id: "whatsapp", name: "WhatsApp" },
  { id: "instagram", name: "Instagram" },
  { id: "telegram", name: "Telegram" },
  { id: "messages", name: "Messages" },
  { id: "phone", name: "Phone" },
  { id: "zoom", name: "Zoom" },
  { id: "meet", name: "Meet" },
];

export function createCall() {
  const remoteVideo = h("video", { class: "call-video remote", autoplay: true, playsinline: true });
  const localVideo = h("video", { class: "call-video local solo", autoplay: true, muted: true, playsinline: true });
  const empty = h("div", { class: "call-stage-empty" },
    h("div", { class: "call-empty-title" }, "Home Call"),
    h("p", { class: "muted" }, "Video stays in Lights Studio. Enable the camera, then call a wall screen."));
  const peerLabel = h("div", { class: "call-peer-label", style: { display: "none" } });
  const stage = h("div", { class: "call-stage" }, remoteVideo, localVideo, empty, peerLabel);

  const status = h("div", { class: "call-status muted" });
  const controls = h("div", { class: "call-controls", style: { display: "none" } });
  const clients = h("div", { class: "list call-wall-list" });
  const favorites = h("div", { class: "call-favs" });
  const contacts = h("div", { class: "list" });

  const allowBtn = btn("Allow camera & mic", { cls: "primary small", icon: "media", size: 14 }, () => enableCam());
  const allCallBtn = btn("All-call", { cls: "small", icon: "wifi", size: 14 }, () => startAllCall());
  const camReady = h("span", { class: "pill ok call-ready-pill", style: { display: "none" } }, "Camera ready");

  const stageCol = h("div", { class: "call-stage-col stack" },
    h("div", { class: "section-title" },
      h("h2", null, "Calls"),
      h("div", { class: "grow" }),
      camReady,
      allowBtn,
      allCallBtn),
    stage,
    status,
    controls);

  const sideCol = h("div", { class: "call-side" },
    h("div", { class: "section-title", style: { marginTop: 0 } }, h("h2", null, "Wall screens")),
    clients,
    h("div", { class: "section-title" }, h("h2", null, "People"), h("div", { class: "grow" }),
      btn("Add contact", { cls: "small", icon: "plus", size: 14 }, () => editContact(null))),
    h("p", { class: "muted call-hint" },
      "People you add are quick-dial shortcuts that ring your wall screens. FaceTime and WhatsApp can’t run inside this app — use External only if you need them."),
    h("div", { class: "eyebrow" }, "Favorites"),
    favorites,
    h("div", { class: "eyebrow", style: { marginTop: "10px" } }, "All contacts"),
    contacts,
    h("div", { class: "row call-footer-actions" },
      btn("Rename this screen", { cls: "small" }, () => renameScreen()),
      btn("FaceTime…", { cls: "small ghost" }, () => openExternal("facetime", null)),
      btn("WhatsApp…", { cls: "small ghost" }, () => openExternal("whatsapp", null))));

  const el = h("section", { class: "stack call-page" },
    h("div", { class: "call-layout" }, stageCol, sideCol));

  let muted = false;
  let videoOff = false;
  let inCall = false;
  let peerName = "";

  function setPermUi(ready) {
    allowBtn.style.display = ready ? "none" : "";
    camReady.style.display = ready ? "" : "none";
  }

  function setStageMode({ preview = false, connected = false, calling = false, name = "" } = {}) {
    if (name) peerName = name;
    empty.style.display = (preview || connected || calling) ? "none" : "";
    setClass(localVideo, "solo", !connected);
    setClass(localVideo, "on", !!(preview || connected || calling));
    setClass(remoteVideo, "on", !!connected);
    setClass(stage, "live", !!(connected || calling || preview));
    setClass(stage, "connected", !!connected);
    controls.style.display = (preview || connected || calling) ? "" : "none";
    let label = "";
    if (calling && peerName) label = `Calling ${peerName}…`;
    else if (connected && peerName) label = peerName;
    else if (preview && !calling && !connected) label = "Preview";
    setText(peerLabel, label);
    peerLabel.style.display = label ? "" : "none";
  }

  const muteBtn = btn("Mute", { cls: "small", icon: "mic", size: 14 }, () => {
    muted = !muted;
    rtc.toggleMute(muted);
    muteBtn.replaceChildren(icon(muted ? "mic-off" : "mic", 14), muted ? "Unmute" : "Mute");
    setText(status, muted ? "Muted" : inCall ? "On call" : "Ready");
  });
  const camBtn = btn("Camera", { cls: "small", icon: "film", size: 14 }, () => {
    videoOff = !videoOff;
    rtc.toggleVideo(videoOff);
    setText(status, videoOff ? "Camera off" : "Camera on");
  });
  const endBtn = btn("End", { cls: "small danger", icon: "close", size: 14 }, () => endCall());
  controls.replaceChildren(muteBtn, camBtn, endBtn);

  rtc.setCallHandlers({
    remote: (_id, stream) => {
      remoteVideo.srcObject = stream;
      inCall = true;
      document.body.dataset.outboundCall = "";
      setStageMode({ connected: true, name: peerName || "Connected" });
      setText(status, "Connected");
    },
    hangup: () => {
      setText(status, "Call ended");
      document.body.dataset.outboundCall = "";
      if (localVideo.srcObject) setStageMode({ preview: true });
      else setStageMode({});
    },
  });

  async function enableCam() {
    try {
      const s = await rtc.ensureMedia(true, { explain: true });
      localVideo.srcObject = s;
      setPermUi(true);
      setStageMode({ preview: true });
      setText(status, "Camera ready — pick a wall screen to call");
      return true;
    } catch (_) {
      setPermUi(false);
      return false;
    }
  }

  async function attachLocal() {
    if (localVideo.srcObject || rtc.hasMedia()) {
      if (!localVideo.srcObject && rtc.hasMedia()) localVideo.srcObject = rtc.localMedia();
      setPermUi(true);
      return true;
    }
    return enableCam();
  }

  async function startHomeCall({ targetId = null, all = false, name = "Home Call" } = {}) {
    const peers = onlinePeers();
    if (!peers.length && !targetId) {
      toast("No other wall screens online. Open Lights Studio on a tablet or phone first.", "err");
      setText(status, "Need another screen online to place a call");
      return;
    }
    if (!(await attachLocal())) return;

    const targets = targetId ? [targetId] : peers.map((p) => p.id);
    inCall = true;
    document.body.dataset.outboundCall = "1";
    setStageMode({ calling: true, name });
    setText(status, targetId
      ? `Ringing ${name}…`
      : `Ringing ${targets.length} wall screen${targets.length === 1 ? "" : "s"}…`);

    try {
      if (targetId) await rtc.invite(targetId, { video: true });
      else await rtc.inviteAll(targets, true);
      await hubCall("call_start", {
        app: "home",
        name,
        from: clientId(),
        target_client: targetId,
        all: !!all || !targetId,
      });
    } catch (e) {
      document.body.dataset.outboundCall = "";
      inCall = false;
      toast(e.message || "Could not start call", "err");
      setText(status, e.message || "Call failed");
      setStageMode({ preview: true });
    }
  }

  async function startAllCall() {
    await startHomeCall({ all: true, name: "All rooms" });
  }

  async function callClient(c) {
    await startHomeCall({ targetId: c.id, name: c.name });
  }

  async function callContact(c) {
    // Contacts are shortcuts that ring every online wall (household intercom).
    await startHomeCall({ all: true, name: c.name });
  }

  async function endCall() {
    document.body.dataset.outboundCall = "";
    await rtc.hangupAll();
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
    inCall = false;
    peerName = "";
    setPermUi(false);
    setStageMode({});
    setText(status, "");
    muteBtn.replaceChildren(icon("mic", 14), "Mute");
    muted = false;
    videoOff = false;
  }

  function openExternal(app, contact) {
    modal(
      `Open ${EXTERNAL.find((a) => a.id === app)?.name || app}?`,
      h("p", { class: "muted", style: { fontSize: "13.5px", lineHeight: "1.45" } },
        "That app can’t run inside Lights Studio. Prefer Home Call to stay on this screen."),
      [
        (close) => btn("Cancel", {}, close),
        (close) => btn("Stay here", { cls: "primary" }, async () => {
          close();
          await startHomeCall({ all: true, name: contact?.name || "Home Call" });
        }),
        (close) => btn("Open app", { cls: "small" }, async () => {
          close();
          try {
            await hubCall("call_start", {
              app,
              handle: contact?.handle || "",
              name: contact?.name || app,
            });
          } catch (e) {
            toast(e.message || "Could not open app", "err");
          }
        }),
      ],
    );
  }

  function renameScreen() {
    const input = h("input", { type: "text", value: clientName(), placeholder: "Kitchen", autofocus: true });
    modal("Name this wall screen", h("label", { class: "field" }, "Shown on intercom", input), [
      (close) => btn("Cancel", {}, close),
      (close) => btn("Save", { cls: "primary" }, async () => {
        setClientName(input.value);
        await import("../wall.js").then((m) => m.registerWall());
        close();
        update();
      }),
    ]);
  }

  function editContact(existing) {
    const c = existing ? { ...existing } : { name: "", app: "home", handle: "", favorite: true };
    const name = h("input", { type: "text", value: c.name, placeholder: "Sakshi" });
    const handle = h("input", { type: "text", value: c.handle || "", placeholder: "Optional note" });
    const fav = h("label", { class: "row" }, h("input", { type: "checkbox", checked: c.favorite !== false }), " Favorite");
    modal(existing ? "Edit contact" : "Add contact", h("div", { class: "stack" },
      h("p", { class: "muted", style: { fontSize: "12.5px" } }, "Tapping Call rings your online wall screens inside Lights Studio."),
      h("label", { class: "field" }, "Name", name),
      h("label", { class: "field" }, "Note (optional)", handle),
      fav), [
      (close) => btn("Cancel", {}, close),
      ...(existing ? [(close) => btn("Delete", { cls: "danger" }, async () => {
        await hubCall("contact_delete", { id: existing.id });
        close();
      })] : []),
      (close) => btn("Save", { cls: "primary" }, async () => {
        await hubCall("contact_upsert", {
          id: existing?.id || "",
          name: name.value.trim(),
          app: "home",
          handle: handle.value.trim(),
          favorite: fav.querySelector("input").checked,
        });
        close();
      }),
    ]);
  }

  function update() {
    if (rtc.hasMedia() || localVideo.srcObject) setPermUi(true);

    const walls = onlinePeers();
    reconcile(clients, walls, (c) => c.id,
      () => {
        const b = h("button", { class: "item", type: "button" },
          h("div", { class: "ico" }, icon("devices", 16)),
          h("div", { class: "grow" }, h("div", { class: "t" }), h("div", { class: "s" })),
          h("span", { class: "pill ok" }, "Call"));
        b.addEventListener("click", () => callClient(b._c));
        return b;
      },
      (b, c) => {
        b._c = c;
        setText(b.querySelector(".t"), c.name);
        setText(b.querySelector(".s"), c.room || "Online now");
      });
    if (!walls.length) {
      clients.replaceChildren(emptyBlock({
        title: "No other screens online",
        body: "Open Lights Studio on an iPad or phone (Settings → Wall screen URL), then call from here.",
        illust: illustNoPeer(56),
      }));
    }

    const list = state.settings.contacts || [];
    const favs = list.filter((c) => c.favorite);
    reconcile(favorites, favs, (c) => c.id,
      () => {
        const b = h("button", { class: "cc-tile call-person", type: "button" },
          h("div", { class: "t" }), h("div", { class: "s" }, "Ring walls"));
        b.addEventListener("click", () => callContact(b._c));
        return b;
      },
      (b, c) => {
        b._c = c;
        setText(b.querySelector(".t"), c.name);
      });
    if (!favs.length) {
      favorites.replaceChildren(h("p", { class: "muted" }, "Add a favorite for one-tap Home Call."));
    }

    reconcile(contacts, list, (c) => c.id,
      () => {
        const row = h("div", { class: "item" },
          h("div", { class: "grow" }, h("div", { class: "t" }), h("div", { class: "s" })),
          btn("Call", { cls: "small primary" }, () => callContact(row._c)),
          btn("External…", { cls: "small ghost" }, () => {
            modal("Open externally", h("div", { class: "call-providers" },
              ...EXTERNAL.map((a) => {
                const b = h("button", { class: "cc-tile", type: "button" }, a.name);
                b.addEventListener("click", () => {
                  closeOverlay();
                  openExternal(a.id, row._c);
                });
                return b;
              })), [(close) => btn("Cancel", {}, close)]);
          }),
          btn("", { cls: "small ghost icon", icon: "edit", size: 14, title: "Edit" }, () => editContact(row._c)));
        return row;
      },
      (row, c) => {
        row._c = c;
        setText(row.querySelector(".t"), c.name);
        setText(row.querySelector(".s"), "Home Call");
      });
  }

  createCall._answer = async (from) => {
    if (!(await attachLocal())) return;
    await rtc.answer(from, true);
    inCall = true;
    setStageMode({ calling: true, name: "Connecting…" });
    setText(status, "Connecting…");
    location.hash = "#/call";
  };
  createCall._decline = async (from) => {
    await rtc.decline(from);
  };
  createCall._onSignal = (msg) => rtc.handleSignal(msg);

  return {
    el,
    update,
    answer: createCall._answer,
    decline: createCall._decline,
    onSignal: createCall._onSignal,
  };
}
