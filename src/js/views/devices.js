import { h, icon, kindIcon, reconcile, setText, setClass, btn, modal, confirmBox, toast } from "../dom.js";
import { state, L, subscribeStore } from "../store.js";
import { run, describe, fail } from "../actions.js";
import { call } from "../api.js";
import { makeSortable } from "../sortable.js";
import { openDetail } from "./detail.js";
import { reorderSubset } from "./dashboard.js";
import { toggle } from "../components.js";
import { toggleDevice } from "../actions.js";

const DRIVER = { wiz: "WiZ", ha: "Home Assistant", net: "Network", cast: "Chromecast" };

export function createDevices() {
  let q = "";
  let kind = "all";
  const search = h("input", { type: "search", placeholder: "Search devices…", style: { maxWidth: "280px" } });
  search.addEventListener("input", () => { q = search.value.toLowerCase(); update(); });
  const seg = h("div", { class: "seg" });
  const kinds = [["all", "All"], ["light", "Lights"], ["plug", "Plugs"], ["media", "Speakers"], ["other", "Other"]];
  kinds.forEach(([id, name]) => {
    const b = h("button", null, name);
    b.addEventListener("click", () => { kind = id; update(); });
    b.dataset.k = id;
    seg.append(b);
  });
  const list = h("div", { class: "list" });
  makeSortable(list, { item: ".item", handle: ".handle", group: "devlist", onDrop: ({ keys }) => reorderSubset(keys) });
  const empty = h("div", { class: "empty" }, h("h3", null, "Nothing here"), h("p", null, "Add devices to get started."));

  const menu = h("div", { class: "devices-menu" },
    h("button", { type: "button" }, "Scan network"),
    h("button", { type: "button" }, "Remove offline"));
  menu.children[0].addEventListener("click", () => { menu.classList.remove("on"); openAddDevice("scan"); });
  menu.children[1].addEventListener("click", () => {
    menu.classList.remove("on");
    const n = state.devices.filter((d) => !L(d.id).online).length;
    if (!n) return toast("Every device is online");
    confirmBox("Remove offline devices?", `${n} device${n > 1 ? "s are" : " is"} not responding and will be removed.`, "Remove", () => run("prune_offline", {}, "Removed offline devices"));
  });
  const moreBtn = btn("More", { cls: "ghost small", icon: "chevron", size: 14 }, () => menu.classList.toggle("on"));
  const more = h("div", { class: "devices-more" }, moreBtn, menu);
  document.addEventListener("pointerdown", (e) => {
    if (!more.contains(e.target)) menu.classList.remove("on");
  });

  const el = h("section", null,
    h("div", { class: "devices-toolbar" },
      search, seg, h("div", { class: "grow" }),
      more,
      btn("Add device", { cls: "primary", icon: "plus", size: 16 }, () => openAddDevice("scan"))),
    list, empty);

  function update() {
    seg.querySelectorAll("button").forEach((b) => setClass(b, "active", b.dataset.k === kind));
    const items = state.devices.filter((d) => {
      if (kind === "light" && d.kind !== "light") return false;
      if (kind === "plug" && d.kind !== "plug" && d.kind !== "switch") return false;
      if (kind === "media" && d.kind !== "media") return false;
      if (kind === "other" && ["light", "plug", "switch", "media"].includes(d.kind)) return false;
      if (q && !`${d.name} ${d.room} ${d.ip} ${d.kind}`.toLowerCase().includes(q)) return false;
      return true;
    });
    reconcile(list, items, (d) => d.id, makeRow, updateRow);
    empty.style.display = items.length ? "none" : "";
  }
  return { el, update };
}

function makeRow() {
  const r = {};
  r.ic = h("div", { class: "ico" });
  r.t = h("div", { class: "t" });
  r.s = h("div", { class: "s" });
  r.pill = h("span", { class: "pill" });
  r.tg = toggle(true);
  r.fav = h("button", { class: "fav", title: "Favourite" }, icon("star", 18));
  const row = h("div", { class: "item", style: { cursor: "pointer" } },
    h("span", { class: "handle", title: "Drag to reorder" }, icon("grip", 18)),
    r.ic, h("div", { class: "grow" }, r.t, r.s), r.pill, r.fav, r.tg);
  row._r = r;
  r.tg.addEventListener("click", (e) => { e.stopPropagation(); toggleDevice(row._id); });
  r.fav.addEventListener("click", (e) => { e.stopPropagation(); run("device_update", { id: row._id, favorite: !row._fav }); });
  row.addEventListener("click", (e) => {
    if (e.target.closest(".handle, .toggle, .fav")) return;
    openDetail(row._id);
  });
  return row;
}

function updateRow(row, d) {
  const r = row._r;
  const l = L(d.id);
  row._id = d.id;
  row._fav = d.favorite;
  if (row._kind !== d.kind) { row._kind = d.kind; r.ic.replaceChildren(icon(kindIcon(d.kind), 20)); }
  setText(r.t, d.name);
  setText(r.s, [d.room || "No room", d.ip ? d.ip + (d.port ? ":" + d.port : "") : null, DRIVER[d.driver] || d.driver].filter(Boolean).join(" · "));
  setText(r.pill, !l.online ? (l.seen ? "Offline" : "Connecting") : describe(d, l));
  setClass(r.pill, "ok", !!l.online);
  setClass(r.pill, "bad", !l.online && !!l.seen);
  setClass(r.fav, "on", d.favorite);
  setClass(r.tg, "on", !!l.on);
  r.tg.style.display = d.caps.includes("onoff") ? "" : "none";
}

// ---------- add device modal ----------

export function openAddDevice(tab = "scan") {
  let current = tab;
  const body = h("div", { class: "stack" });
  const seg = h("div", { class: "seg" });
  const area = h("div", { class: "stack", style: { minHeight: "220px" } });
  body.append(seg, area);
  let haEntities = null;
  let haBusy = false;
  const selected = new Set();

  const tabs = [["scan", "Scan network"], ["ip", "By IP"], ["ha", "Home Assistant"]];
  function render() {
    seg.replaceChildren(...tabs.map(([id, name]) => {
      const b = h("button", { class: id === current ? "active" : "" }, name);
      b.addEventListener("click", () => { current = id; render(); });
      return b;
    }));
    area.replaceChildren(current === "scan" ? scanPane() : current === "ip" ? ipPane() : haPane());
  }

  function scanPane() {
    const pane = h("div", { class: "stack" });
    const scanning = state.scanning;
    pane.append(h("div", { class: "row" },
      h("div", { class: "grow muted", style: { fontSize: "12.5px" } }, "WiZ lights and plugs are added automatically. Everything else that answers on your network is listed below."),
      btn(scanning ? "Scanning…" : "Scan", { cls: "primary", icon: "refresh", size: 16 }, async () => {
        state.scanning = true; render();
        try { await call("discover", { deep: true }); } catch (e) { fail(e); }
        state.scanning = false; render();
      })));
    if (state.candidates.length === 0) {
      pane.append(h("div", { class: "empty" }, scanning ? "Looking around your network…" : "No other devices found yet. Press Scan."));
    } else {
      const lst = h("div", { class: "list" });
      for (const c of state.candidates) {
        lst.append(h("div", { class: "item" },
          h("div", { class: "ico" }, icon(kindIcon(c.kind === "media" ? "media" : "other"), 18)),
          h("div", { class: "grow" }, h("div", { class: "t" }, c.name), h("div", { class: "s" }, [c.ip, ...(c.hints || [])].join(" · "))),
          h("button", { class: "btn small ghost", title: "Hide", onClick: () => run("candidate_dismiss", { ip: c.ip }) }, icon("close", 14)),
          btn("Add", { cls: "small primary" }, async () => {
            await run("candidate_add", { ip: c.ip, name: c.name, kind: c.kind }, `${c.name} added`).catch(() => {});
          })));
      }
      pane.append(lst);
    }
    return pane;
  }

  function ipPane() {
    const ip = h("input", { type: "text", placeholder: "192.168.1.50" });
    const port = h("input", { type: "number", placeholder: "default" });
    const name = h("input", { type: "text", placeholder: "Optional name" });
    const go = async () => {
      if (!ip.value.trim()) return;
      try {
        await run("device_add_ip", { ip: ip.value.trim(), port: port.value ? +port.value : 0, name: name.value });
        toast("Device added", "ok");
        ip.value = ""; name.value = "";
      } catch (_) {}
    };
    [ip, port, name].forEach((i) => i.addEventListener("keydown", (e) => e.key === "Enter" && go()));
    return h("div", { class: "form" },
      h("p", { class: "muted", style: { fontSize: "12.5px" } }, "If the device speaks the WiZ protocol it is added as a light or plug. Anything else is tracked as a network device."),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 120px", gap: "10px" } },
        h("label", { class: "field" }, "IP address", ip), h("label", { class: "field" }, "Port", port)),
      h("label", { class: "field" }, "Name", name),
      h("div", { class: "row" }, h("div", { class: "grow" }), btn("Add device", { cls: "primary" }, go)));
  }

  function haPane() {
    const connected = state.settings.ha_connected;
    if (!connected) {
      const url = h("input", { type: "text", placeholder: "http://homeassistant.local:8123", value: state.settings.ha_url || "" });
      const token = h("input", { type: "password", placeholder: "Long-lived access token" });
      return h("div", { class: "form" },
        h("p", { class: "muted", style: { fontSize: "12.5px" } }, "Home Assistant lets this hub control Hue, Zigbee, Matter, HomeKit, TVs, thermostats and more. In Home Assistant open your profile and create a long-lived access token."),
        h("label", { class: "field" }, "Home Assistant URL", url),
        h("label", { class: "field" }, "Access token", token),
        h("div", { class: "row" }, h("div", { class: "grow" }), btn("Connect", { cls: "primary", icon: "link", size: 16 }, async () => {
          try {
            const r = await call("ha_connect", { url: url.value.trim(), token: token.value.trim() });
            toast(`Connected · ${r.entities} entities available`, "ok");
            haEntities = null;
            render();
          } catch (e) { fail(e); }
        })));
    }
    const pane = h("div", { class: "stack" });
    if (!haEntities && !haBusy) {
      haBusy = true;
      call("ha_entities").then((l) => { haEntities = l; haBusy = false; render(); }).catch((e) => { haBusy = false; haEntities = []; fail(e); render(); });
    }
    if (!haEntities) return h("div", { class: "empty" }, "Loading entities from Home Assistant…");
    if (!haEntities.length) return h("div", { class: "empty" }, "Nothing to import.");
    const lst = h("div", { class: "list", style: { maxHeight: "320px", overflowY: "auto" } });
    for (const e of haEntities) {
      const cb = h("input", { type: "checkbox", disabled: e.added, checked: e.added || selected.has(e.entity_id), style: { width: "18px", height: "18px" } });
      cb.addEventListener("change", () => (cb.checked ? selected.add(e.entity_id) : selected.delete(e.entity_id)));
      lst.append(h("label", { class: "item", style: { cursor: "pointer" } }, cb,
        h("div", { class: "ico" }, icon(kindIcon(e.kind), 18)),
        h("div", { class: "grow" }, h("div", { class: "t" }, e.name), h("div", { class: "s" }, `${e.entity_id} · ${e.state ?? ""}`)),
        e.added ? h("span", { class: "pill ok" }, "Added") : null));
    }
    pane.append(lst, h("div", { class: "row" }, h("div", { class: "grow" }), btn("Import selected", { cls: "primary" }, async () => {
      if (!selected.size) return toast("Select something first");
      try {
        const r = await call("ha_import", { entities: [...selected] });
        toast(`${r.added} imported`, "ok");
        selected.clear(); haEntities = null; render();
      } catch (e) { fail(e); }
    })));
    return pane;
  }

  const close = modal("Add device", body, [(c) => btn("Done", { cls: "primary" }, () => c())]);
  render();
  // keep the candidate list fresh while open
  let lastSig = "";
  const off = subscribeStore(() => {
    if (!body.isConnected) { off(); return; }
    const sig = state.scanning + "|" + state.candidates.map((c) => c.ip).join(",") + "|" + state.settings.ha_connected;
    if (sig !== lastSig) {
      lastSig = sig;
      if (current === "scan" || current === "ha") render();
    }
  });
  return close;
}
