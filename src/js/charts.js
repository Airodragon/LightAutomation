// Dependency-free SVG bar chart.

const NS = "http://www.w3.org/2000/svg";

export function fmtEnergy(wh) {
  if (wh >= 1000) return (wh / 1000).toFixed(2) + " kWh";
  return Math.round(wh) + " Wh";
}

/**
 * values: number[]; labels: string[] (same length); opts: { height, unit(fn), highlightLast, every }
 */
export function barChart(host, values, labels, opts = {}) {
  const W = 640;
  const H = opts.height || 160;
  const padB = 22;
  const n = values.length || 1;
  const max = Math.max(...values, opts.min || 1);
  const gap = 4;
  const bw = (W - gap * (n - 1)) / n;
  const fmt = opts.fmt || ((v) => v.toFixed(1));
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + padB}`);
  svg.style.width = "100%";
  for (let g = 1; g <= 3; g++) {
    const y = H - (H * g) / 3;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("x2", W);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "grid-line");
    svg.append(line);
  }
  values.forEach((v, i) => {
    const bh = Math.max(v > 0 ? 3 : 0, (v / max) * (H - 6));
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", i * (bw + gap));
    rect.setAttribute("y", H - bh);
    rect.setAttribute("width", bw);
    rect.setAttribute("height", bh);
    rect.setAttribute("rx", Math.min(5, bw / 2));
    rect.setAttribute("class", "bar" + (v === 0 ? " dim" : ""));
    const t = document.createElementNS(NS, "title");
    t.textContent = `${labels[i]}: ${fmt(v)}`;
    rect.append(t);
    svg.append(rect);
    const every = opts.every || Math.ceil(n / 8);
    const lastDrawn = Math.floor((n - 1) / every) * every;
    if (i % every === 0 ? !(i === lastDrawn && false) : i === n - 1 && n - 1 - lastDrawn >= Math.ceil(every * 0.6)) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", i * (bw + gap) + bw / 2);
      tx.setAttribute("y", H + 15);
      tx.setAttribute("text-anchor", "middle");
      tx.textContent = labels[i];
      svg.append(tx);
    }
  });
  host.replaceChildren(svg);
}
