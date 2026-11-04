// Mesh WebRTC for Home Call / intercom between wall clients.
import { call } from "./api.js";
import { clientId, clientName } from "./wall.js";

const pcs = new Map(); // peerId -> RTCPeerConnection
let localStream = null;
let onRemote = null;
let onHangup = null;
let onRing = null;
let pendingTargets = new Set(); // peers we invited / expect accept from

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function setCallHandlers({ remote, hangup, ring } = {}) {
  onRemote = remote || null;
  onHangup = hangup || null;
  onRing = ring || null;
}

export async function ensureMedia(video = true, { explain = true } = {}) {
  if (localStream) {
    const needVideo = video && !localStream.getVideoTracks().length;
    if (!needVideo) return localStream;
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  const { requestAv } = await import("./permissions.js");
  const stream = await requestAv({ video, audio: true, explain });
  if (!stream) throw new Error("Camera/mic permission needed");
  localStream = stream;
  return localStream;
}

export function localMedia() {
  return localStream;
}

export function hasMedia() {
  return !!localStream;
}

async function signal(payload) {
  await call("webrtc_signal", { from: clientId(), name: clientName(), ...payload });
}

function pcFor(peerId) {
  if (pcs.has(peerId)) return pcs.get(peerId);
  const pc = new RTCPeerConnection(ICE);
  pcs.set(peerId, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      signal({ type: "candidate", to: peerId, candidate: e.candidate.toJSON() }).catch(() => {});
    }
  };
  pc.ontrack = (e) => {
    onRemote && onRemote(peerId, e.streams[0] || new MediaStream(e.track ? [e.track] : []));
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      pcs.delete(peerId);
    }
  };
  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  }
  return pc;
}

async function sendOffer(peerId) {
  const pc = pcFor(peerId);
  if (pc.signalingState !== "stable") return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await signal({ type: "offer", to: peerId, sdp: pc.localDescription });
}

/** Ring one peer (offer after they accept). */
export async function invite(peerId, { video = true } = {}) {
  if (!peerId) throw new Error("No wall screen to call");
  await ensureMedia(video);
  pendingTargets.add(peerId);
  await signal({ type: "invite", to: peerId, name: clientName() });
}

/** Ring every peer id in the list. */
export async function inviteAll(peerIds = [], video = true) {
  const ids = [...new Set(peerIds.filter((id) => id && id !== clientId()))];
  if (!ids.length) throw new Error("No other wall screens online");
  await ensureMedia(video);
  for (const id of ids) pendingTargets.add(id);
  await signal({ type: "invite", to: null, all: true, name: clientName() });
}

export async function handleSignal(msg) {
  if (!msg || msg.from === clientId()) return null;
  if (msg.to && msg.to !== clientId() && !msg.all) return null;

  if (msg.type === "invite" || msg.type === "ring") {
    onRing && onRing({ from: msg.from, name: msg.name || "Someone" });
    return { ringing: true, from: msg.from, name: msg.name };
  }

  // Callee accepted — caller creates the offer now
  if (msg.type === "accept") {
    pendingTargets.add(msg.from);
    await ensureMedia(true);
    await sendOffer(msg.from);
    return { offering: true, from: msg.from };
  }

  if (msg.type === "offer") {
    await ensureMedia(true);
    const pc = pcFor(msg.from);
    if (pc.signalingState !== "stable" && pc.remoteDescription) return null;
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal({ type: "answer", to: msg.from, sdp: pc.localDescription });
    return { connected: true, from: msg.from };
  }

  if (msg.type === "answer") {
    const pc = pcs.get(msg.from) || pcFor(msg.from);
    if (msg.sdp) await pc.setRemoteDescription(msg.sdp);
    return { connected: true, from: msg.from };
  }

  if (msg.type === "candidate" && msg.candidate) {
    const pc = pcs.get(msg.from);
    if (pc) await pc.addIceCandidate(msg.candidate).catch(() => {});
  }

  if (msg.type === "hangup" || msg.type === "decline") {
    hangupPeer(msg.from);
    pendingTargets.delete(msg.from);
    onHangup && onHangup(msg.from);
  }
  return null;
}

/** User tapped Answer on an incoming ring. */
export async function answer(from, video = true) {
  if (!from) return;
  await ensureMedia(video);
  await signal({ type: "accept", to: from, name: clientName() });
}

export async function decline(from) {
  if (!from) return;
  await signal({ type: "decline", to: from, name: clientName() });
}

export function hangupPeer(peerId) {
  const pc = pcs.get(peerId);
  if (pc) {
    pc.close();
    pcs.delete(peerId);
  }
  pendingTargets.delete(peerId);
}

export async function hangupAll() {
  for (const id of [...pcs.keys(), ...pendingTargets]) {
    signal({ type: "hangup", to: id }).catch(() => {});
    hangupPeer(id);
  }
  pendingTargets.clear();
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

export function toggleMute(muted) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
}

export function toggleVideo(off) {
  if (!localStream) return;
  localStream.getVideoTracks().forEach((t) => { t.enabled = !off; });
}
