// Two small SVG charts for the stats panel: a histogram of scores and a
// best-of-N curve. Observed data is solid (with a light wash under the
// histogram); predictions are dashed in the same color. Text always uses
// the page's ink colors, never the series colors.

const NS = "http://www.w3.org/2000/svg";
const M = { top: 14, right: 64, bottom: 30, left: 48 };
const HEIGHT = 240;

export const SERIES = {
  pairs: { color: "var(--series-pairs)" },
  match: { color: "var(--series-match)" },
};

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function text(parent, x, y, str, attrs = {}) {
  const t = el("text", { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

/** Round tick values between lo and hi, about `count` of them. */
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(12));
  return ticks;
}

export function formatValue(v, rank, digits = 1) {
  if (!Number.isFinite(v)) return "—";
  if (rank === "surprise") {
    const r = Math.abs(v).toFixed(digits);
    if (Number(r) === 0) return `${r}σ`; // no "−0.00σ"
    return `${v > 0 ? "+" : "−"}${r}σ`;
  }
  return `${(Math.abs(v) < 0.5 * 10 ** -(digits + 2) ? 0 : v * 100).toFixed(digits)}%`;
}

export function formatCount(n) {
  if (n < 1000) return String(n);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [u, s] of units) if (n >= u) return `${+(n / u).toFixed(n / u < 10 ? 1 : 0)}${s}`;
  return String(n);
}

/** A chart's frame: svg, plot size, tooltip, hover callback plumbing. */
function frame(container) {
  const width = Math.max(280, container.clientWidth || 600);
  let svg = container.querySelector("svg");
  if (!svg) {
    svg = el("svg", { class: "chart-svg" });
    container.append(svg);
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    container.append(tip);
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", HEIGHT);
  svg.replaceChildren();
  return {
    svg,
    tip: container.querySelector(".chart-tip"),
    w: width - M.left - M.right,
    h: HEIGHT - M.top - M.bottom,
    plot: el("g", { transform: `translate(${M.left},${M.top})` }, svg),
  };
}

function gridAndAxes(plot, w, h, yTicks, yScale, yFormat, xTicks, xScale, xFormat) {
  const g = el("g", { class: "chart-grid" }, plot);
  for (const t of yTicks) {
    const y = yScale(t);
    el("line", { x1: 0, x2: w, y1: y, y2: y }, g);
    text(g, -8, y, yFormat(t), { class: "chart-tick", "text-anchor": "end", "dominant-baseline": "middle" });
  }
  el("line", { x1: 0, x2: w, y1: h, y2: h, class: "chart-baseline" }, g);
  for (const t of xTicks) {
    const x = xScale(t);
    text(g, x, h + 18, xFormat(t), { class: "chart-tick", "text-anchor": "middle" });
  }
}

/** Shows the tooltip near (x, y) in the chart with rows [{value, label, key}]. */
function showTip(tip, container, x, y, title, rows) {
  tip.replaceChildren();
  const head = document.createElement("p");
  head.className = "chart-tip-title";
  head.textContent = title;
  tip.append(head);
  for (const r of rows) {
    const row = document.createElement("p");
    row.className = "chart-tip-row";
    const key = document.createElement("span");
    key.className = `chart-key${r.dashed ? " dashed" : ""}`;
    key.style.setProperty("--key", r.color);
    const value = document.createElement("strong");
    value.textContent = r.value;
    const label = document.createElement("span");
    label.textContent = r.label;
    row.append(key, value, label);
    tip.append(row);
  }
  tip.hidden = false;
  const cw = container.clientWidth;
  const tw = tip.offsetWidth;
  const left = x + M.left + 14 + tw > cw ? x + M.left - 14 - tw : x + M.left + 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, y + M.top - 10)}px`;
}

function hoverLayer(f, container, onMove) {
  const hit = el("rect", { x: 0, y: 0, width: f.w, height: f.h, fill: "transparent", class: "chart-hit", tabindex: 0 }, f.plot);
  const cross = el("line", { y1: 0, y2: f.h, class: "chart-cross", visibility: "hidden" }, f.plot);
  const move = (px) => {
    const x = Math.max(0, Math.min(f.w, px));
    container.dataset.hoverX = x; // survives redraws
    const res = onMove(x);
    if (!res) return;
    cross.setAttribute("x1", res.x);
    cross.setAttribute("x2", res.x);
    cross.setAttribute("visibility", "visible");
    showTip(f.tip, container, res.x, res.y ?? 0, res.title, res.rows);
  };
  const leave = () => {
    delete container.dataset.hoverX;
    cross.setAttribute("visibility", "hidden");
    f.tip.hidden = true;
  };
  hit.addEventListener("pointermove", (e) => {
    const box = hit.getBoundingClientRect();
    move(((e.clientX - box.left) / box.width) * f.w);
  });
  hit.addEventListener("pointerleave", leave);
  hit.addEventListener("focus", () => move(f.w * 0.5));
  hit.addEventListener("blur", leave);
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = Number(container.dataset.hoverX ?? f.w / 2);
    move(cur + (e.key === "ArrowLeft" ? -f.w / 40 : f.w / 40));
  });
  // Keep showing the readout where the pointer was before this redraw.
  if (container.dataset.hoverX != null) move(Number(container.dataset.hoverX));
  else f.tip.hidden = true;
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

const DISPLAY_BINS = 60;

/** Range of base bins worth showing: where predictions or data have mass. */
export function histogramWindow(scale, predicted, observed, prev) {
  let lo = scale.n;
  let hi = -1;
  const extend = (probs, cut) => {
    let total = 0;
    for (const p of probs) total += p;
    if (!total) return;
    let acc = 0;
    for (let i = 0; i < probs.length; i++) {
      acc += probs[i];
      if (acc / total > cut && i < lo) lo = i;
      if (acc / total < 1 - cut && i + 1 > hi) hi = i + 1;
    }
  };
  // The central 99.9% of each distribution: with millions of comparisons a
  // few land far out in the tails, and they would squash the picture.
  for (const p of predicted) if (p) extend(p, 0.0005);
  for (const o of observed) if (o) extend(o, 0.0005);
  if (hi < lo) return prev || { lo: 0, hi: scale.n - 1, core: null };
  // Grow-only, so the axis doesn't jitter; merge the unpadded ranges, or
  // the padding would compound on every redraw.
  if (prev?.core) {
    lo = Math.min(lo, prev.core.lo);
    hi = Math.max(hi, prev.core.hi);
  }
  const pad = Math.max(2, Math.round((hi - lo) * 0.04));
  return { lo: Math.max(0, lo - pad), hi: Math.min(scale.n - 1, hi + pad), core: { lo, hi } };
}

/** Groups base bins into display bins; returns rows with shares per series. */
export function histogramRows(scale, win, series) {
  const span = win.hi - win.lo + 1;
  const group = Math.max(1, Math.ceil(span / DISPLAY_BINS));
  const totals = series.map((s) => (s.values ? s.values.reduce((a, b) => a + b, 0) : 0));
  const rows = [];
  for (let start = win.lo; start <= win.hi; start += group) {
    const end = Math.min(win.hi, start + group - 1);
    const from = scale.lo + ((scale.hi - scale.lo) * start) / scale.n;
    const to = scale.lo + ((scale.hi - scale.lo) * (end + 1)) / scale.n;
    const shares = series.map((s, k) => {
      if (!s.values || !totals[k]) return NaN;
      let sum = 0;
      for (let i = start; i <= end; i++) sum += s.values[i];
      return sum / totals[k];
    });
    rows.push({ from, to, shares });
  }
  return rows;
}

/**
 * series: [{key, label, color, values, dashed}] - values are per base bin
 * (counts or probabilities; each series is normalized to shares).
 */
export function drawHistogram(container, { scale, rank, win, series }) {
  const f = frame(container);
  const rows = histogramRows(scale, win, series);
  const x0 = rows[0].from;
  const x1 = rows[rows.length - 1].to;
  let ymax = 0;
  for (const r of rows) for (const v of r.shares) if (v > ymax) ymax = v;
  ymax = ymax > 0 ? ymax * 1.12 : 0.05;
  const xs = (v) => ((v - x0) / (x1 - x0)) * f.w;
  const ys = (v) => f.h - (v / ymax) * f.h;
  const xTicks = rank === "surprise" ? niceTicks(x0, x1, 6).filter((t) => Number.isInteger(t)) : niceTicks(x0, x1, 6);
  gridAndAxes(
    f.plot, f.w, f.h,
    niceTicks(0, ymax, 4), ys, (t) => `${+(t * 100).toFixed(2)}%`,
    xTicks, xs, (t) => formatValue(t, rank, rank === "surprise" || Math.abs(t * 100 - Math.round(t * 100)) < 1e-9 ? 0 : 1),
  );

  for (const [k, s] of series.entries()) {
    if (!s.values) continue;
    if (s.dashed) {
      const pts = rows.map((r) => `${xs((r.from + r.to) / 2).toFixed(1)},${ys(r.shares[k] || 0).toFixed(1)}`);
      el("polyline", { points: pts.join(" "), class: "chart-line dashed", stroke: s.color }, f.plot);
    } else {
      let d = `M${xs(rows[0].from).toFixed(1)},${f.h}`;
      for (const r of rows) {
        const y = ys(r.shares[k] || 0).toFixed(1);
        d += `L${xs(r.from).toFixed(1)},${y}L${xs(r.to).toFixed(1)},${y}`;
      }
      d += `L${xs(rows[rows.length - 1].to).toFixed(1)},${f.h}`;
      el("path", { d: `${d}Z`, class: "chart-wash", fill: s.color }, f.plot);
      el("path", { d, class: "chart-line", stroke: s.color }, f.plot);
    }
  }

  hoverLayer(f, container, (px) => {
    const v = x0 + (px / f.w) * (x1 - x0);
    const r = rows.find((row) => v >= row.from && v < row.to) || rows[rows.length - 1];
    const top = Math.max(...r.shares.filter(Number.isFinite), 0);
    return {
      x: xs((r.from + r.to) / 2),
      y: ys(top),
      title: `${formatValue(r.from, rank)} to ${formatValue(r.to, rank)}`,
      rows: series
        .map((s, k) => ({ value: Number.isFinite(r.shares[k]) ? `${(r.shares[k] * 100).toFixed(2)}%` : "—", label: s.label, color: s.color, dashed: s.dashed }))
        .filter((_, k) => series[k].values),
    };
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Best of N
// ---------------------------------------------------------------------------

/** Observed value at n from a step series [[n, v], ...] (last point <= n). */
export function stepAt(points, n) {
  let v = NaN;
  for (const [pn, pv] of points) {
    if (pn > n) break;
    v = pv;
  }
  return v;
}

/** Predicted value at n by interpolating in log n. */
export function predictedAt(curve, key, n) {
  if (!curve.length) return NaN;
  if (n <= curve[0].n) return curve[0][key];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].n >= n) {
      const a = curve[i - 1];
      const b = curve[i];
      const t = (Math.log10(n) - Math.log10(a.n)) / (Math.log10(b.n) - Math.log10(a.n));
      return a[key] + t * (b[key] - a[key]);
    }
  }
  return curve[curve.length - 1][key];
}

/**
 * lines: [{label, color, points: [[n, v]], step?, dashed?}] on a log-n axis
 * from 1 to `nMax`. Solid lines get an end dot and an end label.
 */
export function drawBestOfN(container, { rank, nMax, monkeys, lines }) {
  const f = frame(container);
  const lx = (n) => Math.log10(Math.max(1, n));
  const xmax = lx(nMax);
  let ylo = Infinity;
  let yhi = -Infinity;
  for (const l of lines) {
    for (const [n, v] of l.points) {
      if (n > nMax || !Number.isFinite(v)) continue;
      ylo = Math.min(ylo, v);
      yhi = Math.max(yhi, v);
    }
  }
  if (!Number.isFinite(ylo)) {
    ylo = 0;
    yhi = 1;
  }
  const pad = (yhi - ylo) * 0.08 || 0.01;
  ylo -= pad;
  yhi += pad;
  const xs = (n) => (lx(n) / xmax) * f.w;
  const ys = (v) => f.h - ((v - ylo) / (yhi - ylo)) * f.h;
  const xTicks = [];
  for (let p = 0; p <= xmax + 1e-9; p++) xTicks.push(p);
  const step = Math.ceil(xTicks.length / 7);
  gridAndAxes(
    f.plot, f.w, f.h,
    niceTicks(ylo, yhi, 4), ys, (t) => formatValue(t, rank, 0),
    xTicks.filter((_, i) => i % step === 0), (p) => (p / xmax) * f.w, (p) => formatCount(10 ** p),
  );

  for (const l of lines) {
    if (l.hidden) continue; // only shapes the axis
    const pts = l.points.filter(([n, v]) => n <= nMax && Number.isFinite(v));
    if (!pts.length) continue;
    let d = "";
    pts.forEach(([n, v], i) => {
      const x = xs(n).toFixed(1);
      const y = ys(v).toFixed(1);
      if (i === 0) d = `M${x},${y}`;
      else if (l.step) d += `H${x}V${y}`;
      else d += `L${x},${y}`;
    });
    el("path", { d, class: `chart-line${l.dashed ? " dashed" : ""}`, stroke: l.color }, f.plot);
    if (!l.dashed) {
      const [n, v] = pts[pts.length - 1];
      el("circle", { cx: xs(n), cy: ys(v), r: 4, class: "chart-dot", fill: l.color }, f.plot);
      text(f.plot, xs(n) + 8, ys(v), formatValue(v, rank), { class: "chart-end-label", "dominant-baseline": "middle" });
    }
  }

  const shown = lines.filter((l) => !l.hidden);
  hoverLayer(f, container, (px) => {
    const n = Math.max(1, Math.round(10 ** ((px / f.w) * xmax)));
    const values = shown.map((l) => (l.valueAt ? l.valueAt(n) : stepAt(l.points, n)));
    const ok = values.filter(Number.isFinite);
    return {
      x: xs(n),
      y: ok.length ? ys(Math.max(...ok)) : 0,
      title: `After ${n.toLocaleString("en-US")} monkey${n === 1 ? "" : "s"}${n > monkeys ? " (not reached yet)" : ""}`,
      rows: shown.map((l, i) => ({ value: formatValue(values[i], rank), label: l.label, color: l.color, dashed: l.dashed })),
    };
  });
}
