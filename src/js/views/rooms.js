import { h, icon, reconcile, setText, setClass, btn, promptBox, confirmBox } from "../dom.js";
import { state, L, notify } from "../store.js";
import { run, setGroup } from "../actions.js";
import { miniRow, updateMini, toggle } from "../components.js";
import { makeSortable } from "../sortable.js";
import { reorderSubset } from "./dashboard.js";
import { roomMetaFor } from "../roommeta.js";
import { openRoomCustomize } from "./setup.js";

export function onDrop({ container, keys, key }) {
  const room = container.dataset.room || "";
  const d = state.devices.find((x) => x.id === key);
  if (d && room !== "__virtual__" && d.room !== room) {
    d.room = room;
    notify();
    run("device_update", { id: key, room }).catch(() => {});
  }
  reorderSubset(keys);
}

function makeRoom(name) {
  const tg = toggle(true);
  const title = h("h3");
  const count = h("div", { class: "muted", style: { fontSize: "12px" } });
  const body = h("div", { class: "room-body" });
  const real = name !== "";
  const head = h("div", { class: "room-head" },
    h("div", { class: "grow" }, title, count),
    real ? h("button", { class: "btn icon ghost small", title: "Customize", onClick: () => openRoomCustomize(el._name) }, icon("sparkles", 15)) : null,
    real ? h("button", { class: "btn icon ghost small", title: "Rename", onClick: () => promptBox("Rename room", "Room name", el._name, "Rename", (v) => run("room_rename", { from: el._name, to: v })) }, icon("edit", 15)) : null,
    real ? h("button", { class: "btn icon ghost small", title: "Delete room", onClick: () => confirmBox("Delete room?", `Devices in ${el._name} will become unassigned.`, "Delete", () => run("room_delete", { name: el._name })) }, icon("trash", 15)) : null,
    tg);
  const el = h("div", { class: "room" }, head, body);
  body.dataset.room = name;
  makeSortable(body, { item: ".mini", group: "rooms", onDrop });
  tg.addEventListener("click", () => {
    const on = !el._anyOn;
    if (el._devs.length) setGroup(real ? `room:${el._name}` : "all", on);
  });
  el._r = { title, count, tg, body };
  el._devs = [];
  el._name = name;
  return el;
}

export function createRooms() {
  const wrap = h("div", { class: "rooms" });
  const add = h("button", { class: "room", style: { placeItems: "center", minHeight: "120px", color: "var(--muted)", cursor: "pointer", borderStyle: "dashed" } },
    icon("plus", 24), h("div", { style: { fontWeight: "700" } }, "Add room"));
  add.addEventListener("click", () => promptBox("New room", "Room name", "", "Add", (v) => run("room_add", { name: v })));
  const el = h("section", null, wrap);

  function update() {
    const names = [...state.rooms];
    const unassigned = state.devices.filter((d) => !d.room);
    if (unassigned.length) names.push("");
    reconcile(wrap, names, (n) => n || "__none__", makeRoom, (room, name) => {
      const devs = state.devices.filter((d) => (d.room || "") === name);
      room._devs = devs;
      room._name = name;
      room._r.body.dataset.room = name;
      room._anyOn = devs.some((d) => L(d.id).on && L(d.id).online);
      setText(room._r.title, name || "No room");
      setText(room._r.count, `${devs.length} device${devs.length === 1 ? "" : "s"} · ${devs.filter((d) => L(d.id).on).length} on`);
      setClass(room._r.tg, "on", room._anyOn);
      room._r.tg.style.display = devs.some((d) => d.caps.includes("onoff")) ? "" : "none";
      if (name) {
        const meta = roomMetaFor(name, state.settings);
        room.dataset.tint = meta.tint;
        setClass(room, "tinted", true);
      } else {
        room.dataset.tint = "";
        setClass(room, "tinted", false);
      }
      reconcile(room._r.body, devs, (d) => d.id, miniRow, updateMini);
    });
    // keep the add tile last
    if (wrap.lastElementChild !== add) wrap.append(add);
  }
  return { el, update };
}
