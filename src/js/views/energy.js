import { h, icon, reconcile, setText, btn, confirmBox, toast } from "../dom.js";
import { state, refreshEnergy } from "../store.js";
import { run, fmtW } from "../actions.js";
import { barChart, fmtEnergy } from "../charts.js";
import { call } from "../api.js";

function statCard(label) {
  const v = h("div", { class: "sv" });
  const s = h("div", { class: "ss" });
  return { el: h("div", { class: "stat" }, h("div", { class: "sl" }, label), v, s), v, s };
}

export function createEnergy() {
  const now = statCard("Right now");
  const today = statCard("Today");
  const week = statCard("Last 7 days");
  const month = statCard("Last 30 days");
  const stats = h("div", { class: "stats" }, now.el, today.el, week.el, month.el);
  const daily = h("div", { class: "chart" });
  const hourly = h("div", { class: "chart" });
  const devList = h("div", { class: "list" });
  const hint = h("div", { class: "banner", style: { display: "none" } }, icon("plug", 20),
    h("div", null, h("b", null, "No energy data yet"), h("div", { class: "muted", style: { fontSize: "12.5px" } }, "Only smart plugs with power metering report watts. WiZ plugs made after October 2021 do; older ones can only switch. Home Assistant power sensors work too.")));
  const rate = h("input", { type: "number", step: "0.01", min: "0", style: { maxWidth: "110px" } });
  const cur = h("input", { type: "text", style: { maxWidth: "70px" } });
  const saveRate = () => run("settings_set", { energy_rate: +rate.value || 0, currency: cur.value || "$" }).then(refreshEnergy).catch(() => {});
  rate.addEventListener("change", saveRate);
  cur.addEventListener("change", saveRate);

  const el = h("section", { class: "stack" },
    hint, stats,
    h("div", { class: "card" }, h("div", { class: "row", style: { marginBottom: "6px" } }, h("h3", { style: { margin: 0 }, class: "grow" }, "Last 30 days"), h("span", { class: "muted", style: { fontSize: "12px" } }, "kWh per day")), daily),
    h("div", { class: "card" }, h("div", { class: "row", style: { marginBottom: "6px" } }, h("h3", { style: { margin: 0 }, class: "grow" }, "Today by hour")), hourly),
    h("div", { class: "card" }, h("h3", null, "By device (30 days)"), devList),
    h("div", { class: "card row wrap" },
      h("div", { class: "grow" }, h("b", null, "Electricity price"), h("div", { class: "muted", style: { fontSize: "12px" } }, "Used for cost estimates")),
      cur, rate, h("span", { class: "muted" }, "per kWh"),
      btn("Reset history", { cls: "danger small" }, () => confirmBox("Reset energy history?", "All recorded energy data will be erased.", "Reset", async () => { await call("energy_reset"); await refreshEnergy(); toast("History reset"); }))));

  let lastFetch = 0;
  function update() {
    if (performance.now() - lastFetch > 5000) { lastFetch = performance.now(); refreshEnergy(); }
    const e = state.energy;
    if (document.activeElement !== rate) rate.value = state.settings.energy_rate ?? 0.15;
    if (document.activeElement !== cur) cur.value = state.settings.currency || "$";
    if (!e) return;
    const c = e.currency;
    setText(now.v, fmtW(e.live_watts));
    setText(now.s, "metered devices");
    setText(today.v, fmtEnergy(e.wh_today));
    setText(today.s, `${c}${e.cost_today.toFixed(2)}`);
    setText(week.v, fmtEnergy(e.wh_week));
    setText(week.s, `${c}${e.cost_week.toFixed(2)}`);
    setText(month.v, fmtEnergy(e.wh_month));
    setText(month.s, `${c}${e.cost_month.toFixed(2)}`);
    hint.style.display = e.wh_month === 0 && e.devices.length === 0 ? "" : "none";
    const dk = e.series.map((x) => x.wh.toFixed(2)).join(",");
    if (daily.dataset.k !== dk) {
      daily.dataset.k = dk;
      barChart(daily, e.series.map((x) => x.wh / 1000), e.series.map((x) => x.date.slice(5)), { fmt: (v) => v.toFixed(3) + " kWh", min: 0.01 });
    }
    const hk = e.hours.map((x) => x.toFixed(2)).join(",");
    if (hourly.dataset.k !== hk) {
      hourly.dataset.k = hk;
      barChart(hourly, e.hours.map((x) => x / 1000), e.hours.map((_, i) => String(i).padStart(2, "0")), { fmt: (v) => v.toFixed(3) + " kWh", every: 3, min: 0.01, height: 110 });
    }
    const maxWh = Math.max(1, ...e.devices.map((d) => d.wh_30d));
    reconcile(devList, e.devices, (d) => d.id,
      () => {
        const t = h("div", { class: "t" }), s = h("div", { class: "s" }), bar = h("i"), w = h("div", { class: "mono", style: { fontWeight: "700" } });
        const row = h("div", { class: "item" }, h("div", { class: "grow" }, t, h("div", { class: "hbar", style: { marginTop: "6px" } }, bar), s), w);
        row._r = { t, s, bar, w };
        return row;
      },
      (row, d) => {
        setText(row._r.t, d.name);
        setText(row._r.s, `Today ${fmtEnergy(d.wh_today)} · 30 days ${fmtEnergy(d.wh_30d)} · ${c}${(d.wh_30d / 1000 * e.rate).toFixed(2)}`);
        row._r.bar.style.width = (d.wh_30d / maxWh) * 100 + "%";
        setText(row._r.w, d.watts != null ? fmtW(d.watts) : "–");
      });
  }
  return { el, update };
}
