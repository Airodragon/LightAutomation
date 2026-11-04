import { h, icon, reconcile, setText, btn, promptBox, confirmBox, toast } from "../dom.js";
import { state } from "../store.js";
import { run, applyScene } from "../actions.js";

const ICONS = ["sparkles", "sofa", "film", "moon", "sun", "target", "star", "bulb"];

function make() {
  const ic = h("div", { class: "si", style: { width: "46px", height: "46px" } });
  const name = h("div", { class: "sn" });
  const desc = h("div", { class: "sd" });
  const actions = h("div", { class: "row", style: { gap: "6px", marginTop: "10px" } });
  const el = h("div", { class: "card", style: { display: "grid", gap: "8px" } },
    h("div", { class: "row" }, ic, h("div", { class: "grow" }, name, desc)),
    h("div", { class: "row" }, btn("Apply", { cls: "primary small", icon: "play", size: 14 }, () => applyScene(el._sc)), actions));
  el._r = { ic, name, desc, actions };
  return el;
}

function update(el, sc) {
  el._sc = sc;
  const r = el._r;
  if (el.dataset.icon !== sc.icon) { el.dataset.icon = sc.icon; r.ic.replaceChildren(icon(sc.icon || "sparkles", 22)); }
  setText(r.name, sc.name);
  setText(r.desc, sc.builtin ? (sc.all_off ? "Turns everything off" : "Built-in · applies to all lights") : `${sc.items.length} devices saved`);
  const sig = sc.builtin ? "b" : "c";
  if (r.actions.dataset.sig !== sig) {
    r.actions.dataset.sig = sig;
    r.actions.replaceChildren();
    r.actions.append(btn("Rename", { cls: "small ghost", icon: "edit", size: 14 }, () => promptBox("Rename scene", "Scene name", el._sc.name, "Save", (v) => run("scene_rename", { id: el._sc.id, name: v }))));
    if (!sc.builtin) {
      r.actions.append(
        btn("Update", { cls: "small ghost", icon: "refresh", size: 14, title: "Overwrite with the current state of your devices" }, () =>
          run("scene_save", { id: el._sc.id, name: el._sc.name, capture: true }, "Scene updated")),
        btn("", { cls: "small ghost danger icon", icon: "trash", size: 14 }, () => confirmBox("Delete scene?", `${el._sc.name} will be deleted.`, "Delete", () => run("scene_delete", { id: el._sc.id }))));
    }
  }
}

export function createScenes() {
  const grid = h("div", { class: "grid wide" });
  const el = h("section", null,
    h("div", { class: "row", style: { marginBottom: "16px" } },
      h("div", { class: "grow muted" }, "Set your lights and plugs the way you like, then save the moment as a scene."),
      btn("New scene from current state", { cls: "primary", icon: "plus", size: 16 }, () =>
        promptBox("Save scene", "Scene name", "", "Save", (v) => run("scene_save", { name: v, capture: true }, "Scene saved")))),
    grid);
  return {
    el,
    update() {
      reconcile(grid, state.scenes, (s) => s.id, make, update);
    },
  };
}
