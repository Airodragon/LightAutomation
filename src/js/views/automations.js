import { h, icon, reconcile, setText, setClass, btn, modal, confirmBox, toast } from "../dom.js";
import { state } from "../store.js";
import { run } from "../actions.js";
import { toggle } from "../components.js";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function daysText(days) {
  if (!days.length || days.length === 7) return "Every day";
  const s = [...days].sort();
  if (s.join() === "0,1,2,3,4") return "Weekdays";
  if (s.join() === "5,6") return "Weekends";
  return s.map((d) => DAY_NAMES[d]).join(", ");
}

function targetText(t) {
  if (t === "all") return "all devices";
  if (t === "lights") return "all lights";
  if (t === "plugs") return "all plugs";
  if (t.startsWith("room:")) return t.slice(5);
  if (t.startsWith("device:")) return (state.devices.find((d) => d.id === t.slice(7)) || {}).name || "a device";
  return t;
}

function triggerText(s) {
  const t = s.trigger || "time";
  if (t === "time") return `${s.time} · ${daysText(s.days || [])}`;
  if (t === "sunrise") return "At sunrise";
  if (t === "sunset") return "At sunset";
  if (t === "presence") return `When presence → ${s.presence_mode || "home"}`;
  if (t === "device") {
    const d = state.devices.find((x) => x.id === s.trigger_device);
    return `When ${d ? d.name : "device"} is ${s.trigger_state || "?"}`;
  }
  return t;
}

function actionText(s) {
  switch (s.action) {
    case "scene": return `Apply scene ${(state.scenes.find((x) => x.id === s.scene_id) || {}).name || "?"}`;
    case "on": return `Turn on ${targetText(s.target)}`;
    case "off": return `Turn off ${targetText(s.target)}`;
    case "wake": return `Gentle wake-up for ${targetText(s.target)}`;
    case "effect": return `Run effect ${s.effect ? s.effect.effect : ""}`;
    case "presence": return `Set presence ${s.presence_mode || "home"}`;
    default: return s.action;
  }
}

function make() {
  const tg = toggle();
  const time = h("div", { style: { fontSize: "15px", fontWeight: "600", minWidth: "78px" } });
  const name = h("div", { class: "t" });
  const sub = h("div", { class: "s" });
  const el = h("div", { class: "item" },
    time, h("div", { class: "grow" }, name, sub),
    btn("", { cls: "small ghost icon", icon: "play", size: 15, title: "Run now" }, () => run("schedule_run", { id: el._s.id }, "Ran")),
    btn("", { cls: "small ghost icon", icon: "edit", size: 15, title: "Edit" }, () => openEditor(el._s)),
    btn("", { cls: "small ghost icon danger", icon: "trash", size: 15, title: "Delete" }, () => confirmBox("Delete automation?", el._s.name, "Delete", () => run("schedule_delete", { id: el._s.id }))),
    tg);
  tg.addEventListener("click", () => run("schedule_toggle", { id: el._s.id }));
  el._r = { tg, time, name, sub };
  return el;
}

function update(el, s) {
  el._s = s;
  const r = el._r;
  setText(r.time, (s.trigger || "time") === "time" ? s.time : (s.trigger || "").slice(0, 8));
  setText(r.name, s.name);
  setText(r.sub, `${triggerText(s)} · ${actionText(s)}`);
  setClass(r.tg, "on", s.enabled);
  el.style.opacity = s.enabled ? "" : ".55";
}

export function openEditor(existing) {
  const s = existing ? JSON.parse(JSON.stringify(existing)) : {
    name: "", time: "07:00", days: [], action: "scene", scene_id: (state.scenes[0] || {}).id || "",
    target: "lights", enabled: true, trigger: "time", presence_mode: "home",
    trigger_device: "", trigger_state: "on",
    effect: { effect: "rainbow", duration: 4, scope: "all" },
  };
  if (!s.trigger) s.trigger = "time";

  const name = h("input", { type: "text", value: s.name, placeholder: "e.g. Morning light" });
  const trigger = h("select", null,
    h("option", { value: "time" }, "At a clock time"),
    h("option", { value: "sunrise" }, "At sunrise"),
    h("option", { value: "sunset" }, "At sunset"),
    h("option", { value: "presence" }, "When presence changes"),
    h("option", { value: "device" }, "When a device changes"));
  trigger.value = s.trigger;
  const time = h("input", { type: "time", value: s.time });
  const daysRow = h("div", { class: "days" });
  const drawDays = () => daysRow.replaceChildren(...DAYS.map((d, i) => {
    const b = h("button", { class: s.days.includes(i) ? "active" : "", title: DAY_NAMES[i] }, d);
    b.addEventListener("click", () => { s.days = s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i]; drawDays(); });
    return b;
  }));
  drawDays();
  const presence = h("select", null,
    h("option", { value: "home" }, "Home"),
    h("option", { value: "away" }, "Away"),
    h("option", { value: "night" }, "Night"),
    h("option", { value: "guest" }, "Guest"));
  presence.value = s.presence_mode || "home";
  const triggerDev = h("select", null,
    h("option", { value: "" }, "Select device"),
    ...state.devices.map((d) => h("option", { value: d.id }, d.name)));
  triggerDev.value = s.trigger_device || "";
  const triggerState = h("select", null,
    h("option", { value: "on" }, "Turns on / opens"),
    h("option", { value: "off" }, "Turns off / closes"),
    h("option", { value: "online" }, "Comes online"),
    h("option", { value: "offline" }, "Goes offline"),
    h("option", { value: "locked" }, "Locks"),
    h("option", { value: "unlocked" }, "Unlocks"),
    h("option", { value: "ringing" }, "Doorbell / motion (on edge)"));
  triggerState.value = s.trigger_state || "on";

  const action = h("select", null,
    h("option", { value: "scene" }, "Apply a scene"),
    h("option", { value: "on" }, "Turn on"),
    h("option", { value: "off" }, "Turn off"),
    h("option", { value: "wake" }, "Gentle wake-up (dim to bright)"),
    h("option", { value: "effect" }, "Run an effect"),
    h("option", { value: "presence" }, "Set presence mode"));
  action.value = s.action;
  const scene = h("select", null, ...state.scenes.map((x) => h("option", { value: x.id }, x.name)));
  scene.value = s.scene_id;
  const target = h("select", null,
    h("option", { value: "all" }, "All devices"), h("option", { value: "lights" }, "All lights"), h("option", { value: "plugs" }, "All plugs"),
    ...state.rooms.map((r) => h("option", { value: "room:" + r }, "Room: " + r)),
    ...state.devices.map((d) => h("option", { value: "device:" + d.id }, d.name)));
  target.value = s.target;
  const fx = h("select", null, ...state.effects.map((e) => h("option", { value: e.id }, e.name)));
  fx.value = (s.effect && s.effect.effect) || "rainbow";

  const timeField = h("label", { class: "field" }, "Time", time);
  const daysField = h("div", { class: "field" }, "Repeat (none selected = every day)", daysRow);
  const presenceField = h("label", { class: "field" }, "Presence mode", presence);
  const deviceField = h("label", { class: "field" }, "Device", triggerDev);
  const stateField = h("label", { class: "field" }, "Becomes", triggerState);
  const sceneField = h("label", { class: "field" }, "Scene", scene);
  const targetField = h("label", { class: "field" }, "Target", target);
  const fxField = h("label", { class: "field" }, "Effect", fx);
  const actionPresenceField = h("label", { class: "field" }, "Set presence to", presence);

  const sync = () => {
    const t = trigger.value;
    const a = action.value;
    timeField.style.display = t === "time" ? "" : "none";
    daysField.style.display = t === "time" ? "" : "none";
    presenceField.style.display = t === "presence" ? "" : "none";
    deviceField.style.display = t === "device" ? "" : "none";
    stateField.style.display = t === "device" ? "" : "none";
    sceneField.style.display = a === "scene" ? "" : "none";
    targetField.style.display = ["on", "off", "wake"].includes(a) ? "" : "none";
    fxField.style.display = a === "effect" ? "" : "none";
    actionPresenceField.style.display = a === "presence" ? "" : "none";
  };
  trigger.addEventListener("change", sync);
  action.addEventListener("change", sync);
  sync();

  const body = h("div", { class: "form" },
    h("label", { class: "field" }, "Name", name),
    h("label", { class: "field" }, "When", trigger),
    timeField, daysField, presenceField, deviceField, stateField,
    h("label", { class: "field" }, "Action", action), sceneField, targetField, fxField, actionPresenceField);
  modal(existing ? "Edit automation" : "New automation", body, [
    (c) => btn("Cancel", {}, () => c()),
    (c) => btn("Save", { cls: "primary" }, async () => {
      if (trigger.value === "time" && !time.value) return toast("Pick a time", "err");
      const out = {
        ...s,
        name: name.value.trim() || "Automation",
        time: time.value || "07:00",
        trigger: trigger.value,
        action: action.value,
        scene_id: scene.value,
        target: target.value,
        presence_mode: presence.value,
        trigger_device: triggerDev.value,
        trigger_state: triggerState.value,
      };
      if (out.action === "effect") out.effect = { ...(s.effect || {}), effect: fx.value, scope: "all" };
      try { await run("schedule_save", out, "Saved"); c(); } catch (_) {}
    }),
  ]);
}

export function createAutomations() {
  const list = h("div", { class: "list" });
  const empty = h("div", { class: "empty" }, h("h3", null, "No automations yet"), h("p", null, "Wake at sunrise, set Away when you leave, or ring the wall when the doorbell fires."));
  const el = h("section", null,
    h("div", { class: "row", style: { marginBottom: "16px" } },
      h("div", { class: "grow muted" }, "Triggers: clock, sunrise/sunset, presence, or device state."),
      btn("New automation", { cls: "primary", icon: "plus", size: 16 }, () => openEditor(null))),
    list, empty);
  return {
    el,
    update() {
      reconcile(list, state.schedules, (s) => s.id, make, update);
      empty.style.display = state.schedules.length ? "none" : "";
    },
  };
}
