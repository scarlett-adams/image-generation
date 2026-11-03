import { LEVELS, hexToRgb } from "./core.js";
import {
  drawBestOfN,
  drawHistogram,
  formatCount,
  formatValue,
  histogramWindow,
  predictedAt,
  stepAt,
} from "./charts.js";
import { exactOdds } from "./stats.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

const COLORS = { pairs: "var(--series-pairs)", match: "var(--series-match)", ink: "var(--muted)" };

const state = {
  data: null, // parsed grids.json
  rgb: [], // palette as [r, g, b]
  size: 16,
  rank: "similarity",
  running: false,
  latest: null, // last update from the worker
  best: null,
  theory: null, // predictions from the worker
  histWin: null, // histogram x-range (grows, resets with the theory)
  tablesAt: 0, // last time the table views were rebuilt
  pending: false, // a frame is scheduled
};

let worker = null;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function showNotice(message) {
  const el = $("notice");
  el.textContent = message;
  el.hidden = !message;
}

function setControlsEnabled(enabled) {
  $("run").disabled = !enabled;
  $("reset").disabled = !enabled;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function gridsUrl(size) {
  return size === 16 ? "grids.json" : `grids-${size}.json`;
}

async function loadGrids(size) {
  const url = gridsUrl(size);
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Couldn't reach the server to load the paintings. Check your connection and reload.");
  }
  if (res.status === 404) {
    throw new Error(
      `The ${size} × ${size} painting data (${url}) hasn't been built yet. ` +
        "It's made by scripts/build_grids.py; see the README.",
    );
  }
  if (!res.ok) throw new Error(`Loading the paintings failed (HTTP ${res.status}). Try reloading.`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${url} is damaged (not valid JSON). Rebuild it with scripts/build_grids.py.`);
  }
  if (!Array.isArray(data?.palette) || !Array.isArray(data?.works) || data.works.length === 0) {
    throw new Error(`${url} doesn't contain any paintings. Rebuild it with scripts/build_grids.py.`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

const imageCache = new WeakMap();

function drawGrid(canvas, grid, size) {
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext("2d");
  let img = imageCache.get(canvas);
  if (!img || img.width !== size) {
    img = ctx.createImageData(size, size);
    imageCache.set(canvas, img);
  }
  const px = img.data;
  for (let i = 0; i < size * size; i++) {
    const c = state.rgb[grid[i]] || [0, 0, 0];
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Shows a grid in a painting's real proportions (width / height), fitted
 * inside the square box. */
function setAspect(canvas, aspect) {
  const a = aspect > 0 ? aspect : 1;
  canvas.style.width = `${Math.min(1, a) * 100}%`;
  canvas.style.height = `${Math.min(1, 1 / a) * 100}%`;
}

function clearCanvas(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function work(i) {
  return state.data?.works[i];
}

function artistLine(w) {
  return w.artist || "Unknown artist";
}

/** "71.6% similar" or "+4.2σ above chance (70.1% similar)". */
function scoreLine(m) {
  if (state.rank === "surprise") return `${formatValue(m.z, "surprise")} for its painting (${pct(m.sim)} similar)`;
  return `${pct(m.sim)} similar`;
}

function renderGallery(u) {
  const size = state.size;
  $("tried").textContent = nf.format(u.tried);
  $("tried-label").textContent = u.tried === 1 ? "monkey tried" : "monkeys tried";
  if (u.running) {
    $("rate").textContent = `${nf.format(Math.round(u.perSecond))} grids a second, each compared with ${nf.format(state.data.works.length)} paintings`;
  } else {
    $("rate").textContent = u.tried ? "Paused." : "Press Start to set the monkey loose.";
  }

  if (u.current) {
    drawGrid($("current"), u.current.grid, size);
    const w = work(u.current.work) || { title: "?" };
    $("current-title").textContent =
      state.rank === "surprise"
        ? `${formatValue(u.current.z, "surprise")} for “${w.title}”`
        : `${pct(u.current.sim)} similar to “${w.title}”`;
    $("current-score").textContent =
      (state.rank === "surprise" ? `${pct(u.current.sim)} similar · ` : "") +
      `${pct(u.current.exact, 0)} of pixels exactly right`;
  } else {
    clearCanvas($("current"));
    $("current-title").textContent = "—";
    $("current-score").textContent = "";
  }

  const b = state.best;
  if (b && work(b.work)) {
    drawGrid($("best"), b.grid, size);
    $("best-score").textContent = scoreLine(b);
    $("best-meta").textContent = `${pct(b.exact, 0)} of pixels exactly right · found by monkey #${nf.format(b.at)}`;
    const w = work(b.work);
    drawGrid($("closest"), w.grid, size);
    setAspect($("closest"), w.aspect);
    $("closest-artist").textContent = artistLine(w);
    $("closest-title").textContent = w.title;
    $("closest-dated").textContent = w.dated ? `, ${w.dated}` : "";
    $("closest-culture").textContent = w.culture || "";
  } else {
    for (const id of ["best", "closest"]) clearCanvas($(id));
    $("best-score").textContent = "—";
    $("best-meta").textContent = "";
    $("closest-artist").textContent = "—";
    $("closest-title").textContent = "";
    $("closest-dated").textContent = "";
    $("closest-culture").textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function legend(listId, items) {
  const ul = $(listId);
  if (ul.dataset.key === items.map((i) => i.label).join("|")) return;
  ul.dataset.key = items.map((i) => i.label).join("|");
  ul.replaceChildren(
    ...items.map((i) => {
      const li = document.createElement("li");
      const key = document.createElement("span");
      key.className = `chart-key${i.dashed ? " dashed" : ""}${i.wash ? " wash" : ""}`;
      key.style.setProperty("--key", i.color);
      const label = document.createElement("span");
      label.textContent = i.label;
      li.append(key, label);
      return li;
    }),
  );
}

function table(containerId, head, rows) {
  const t = document.createElement("table");
  t.className = "data-table";
  const thead = t.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    thead.append(th);
  }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r) tr.insertCell().textContent = c;
  }
  $(containerId).replaceChildren(t);
}

function plusMinus(m, rank) {
  if (!m || !Number.isFinite(m.mean)) return "—";
  return rank === "surprise"
    ? `${formatValue(m.mean, rank, 2)} ± ${m.sd.toFixed(2)}σ`
    : `${pct(m.mean)} ± ${(m.sd * 100).toFixed(1)}`;
}

function renderHistogram(s, th) {
  const rank = s.rank;
  const N = state.data.works.length;
  const has = s.monkeys > 0;
  const series = [
    { label: "One monkey vs. one painting", color: COLORS.pairs, values: has ? s.pairsHist : null },
    { label: `One monkey vs. its best match of ${nf.format(N)}`, color: COLORS.match, values: has ? s.matchHist : null },
    { label: "Predicted, one painting", color: COLORS.pairs, values: th.valid ? th.pairs : null, dashed: true },
    { label: "Predicted best match, if independent", color: COLORS.match, values: th.valid ? th.match : null, dashed: true },
  ];
  legend("hist-legend", [
    { label: "vs. one painting", color: COLORS.pairs, wash: true },
    { label: `vs. its best match of ${nf.format(N)}`, color: COLORS.match, wash: true },
    { label: "predicted by theory", color: COLORS.ink, dashed: true },
  ]);
  $("hist-sub").textContent =
    rank === "surprise"
      ? "Share of results at each surprise score (σ above that painting's average against noise)"
      : "Share of results at each similarity";
  state.histWin = histogramWindow(th.scale, [th.pairs, th.match], [has ? s.pairsHist : null, has ? s.matchHist : null], state.histWin);
  const rows = drawHistogram($("hist-chart"), { scale: th.scale, rank, win: state.histWin, series });

  if ($("hist-details").open && performance.now() - state.tablesAt > 500) {
    table(
      "hist-table",
      ["Score", "One painting", "Predicted", "Best match", "Predicted"],
      rows.map((r) => [
        `${formatValue(r.from, rank, 2)} to ${formatValue(r.to, rank, 2)}`,
        ...r.shares.map((v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—")),
      ]),
    );
  }
}

function renderCompare(s, th) {
  const rank = s.rank;
  const N = state.data.works.length;
  const unit = rank === "surprise" ? "Surprise" : "Similarity";
  const rows = [
    [`${unit}, one painting`, th.valid ? plusMinus(th.pairStats, rank) : "—", plusMinus(s.pair, rank)],
    [`${unit}, best of ${nf.format(N)} paintings`, th.valid ? `${plusMinus(th.matchStats, rank)}*` : "—", plusMinus(s.match, rank)],
    ["Exact pixels, one painting", th.valid ? pct(th.exact) : "—", Number.isFinite(s.pairExact) ? pct(s.pairExact) : "—"],
    ["Exact pixels, best match", "—", Number.isFinite(s.matchExact) ? pct(s.matchExact) : "—"],
    ["Independent comparisons per monkey", th.valid ? `${nf.format(N)}*` : "—", s.effectiveN ? `≈ ${nf.format(Math.round(s.effectiveN))}` : "—"],
  ];
  const body = $("compare-body");
  body.replaceChildren(
    ...rows.map(([label, theory, observed]) => {
      const tr = document.createElement("tr");
      const th0 = document.createElement("th");
      th0.scope = "row";
      th0.textContent = label;
      const a = document.createElement("td");
      a.textContent = theory;
      const b = document.createElement("td");
      b.textContent = observed;
      tr.append(th0, a, b);
      return tr;
    }),
  );
  const parts = [];
  if (s.monkeys) {
    parts.push(
      `Observed over ${nf.format(s.monkeys)} monkeys × ${nf.format(N)} paintings = ${formatCount(s.comparisons)} comparisons.`,
    );
  }
  parts.push(
    `* If a monkey's ${nf.format(N)} comparisons were independent. They aren't: the same grid is scored against every painting, so its scores rise and fall together, and the real best match is lower.`,
  );
  if (s.effectiveN) {
    parts.push(`The ${nf.format(N)} comparisons are worth about ${nf.format(Math.round(s.effectiveN))} independent ones.`);
  }
  $("compare-note").textContent = parts.join(" ");
}

function renderBestOfN(s, th) {
  const rank = s.rank;
  const N = state.data.works.length;
  const monkeys = s.monkeys;
  const nMax = Math.max(1000, 10 ** Math.ceil(Math.log10(Math.max(1, monkeys))));
  const extend = (pts) => (pts.length && monkeys > pts[pts.length - 1][0] ? [...pts, [monkeys, pts[pts.length - 1][1]]] : pts);
  const curve = th.bestOfN || [];
  const lines = [
    { label: `Best match among all ${nf.format(N)}`, color: COLORS.match, points: extend(s.bestCurve), step: true },
    { label: "A typical painting's own best match", color: COLORS.pairs, points: extend(s.typicalCurve) },
  ];
  if (th.valid) {
    lines.push(
      { label: "Predicted best match, if independent", color: COLORS.match, dashed: true, points: curve.map((p) => [p.n, p.best]), valueAt: (n) => predictedAt(curve, "best", n) },
      { label: "Predicted, typical painting", color: COLORS.pairs, dashed: true, points: curve.map((p) => [p.n, p.typical]), valueAt: (n) => predictedAt(curve, "typical", n) },
    );
  }
  legend("bon-legend", [
    { label: `best match among all ${nf.format(N)}`, color: COLORS.match },
    { label: "a typical painting's own best match", color: COLORS.pairs },
    { label: "predicted by theory", color: COLORS.ink, dashed: true },
  ]);
  drawBestOfN($("bon-chart"), { rank, nMax, monkeys, lines });

  // Diminishing returns, in words.
  const decades = [];
  for (let n = 10; n <= monkeys; n *= 10) decades.push(n);
  const shown = decades.slice(-4);
  let note = "";
  if (shown.length >= 2) {
    const parts = shown.map((n, i) => {
      const v = stepAt(s.bestCurve, n);
      if (i === 0) return `after ${formatCount(n)} monkeys: ${formatValue(v, rank)}`;
      const gain = v - stepAt(s.bestCurve, shown[i - 1]);
      const g = rank === "surprise" ? `${gain.toFixed(2)}σ` : `${(gain * 100).toFixed(1)} points`;
      return `${formatCount(n)}: ${formatValue(v, rank)} (+${g})`;
    });
    note = `Best match ${parts.join("; ")}. Each tenfold increase in monkeys buys less, because the best of n draws from a bell curve grows only like √(2 ln n).`;
  } else {
    note = "Each tenfold increase in monkeys raises the best match by less than the last. Run the monkey to see it.";
  }
  if (th.valid && monkeys > 0) {
    const next = 10 ** Math.ceil(Math.log10(monkeys + 1));
    note += ` Theory says the best of ${formatCount(next)} independent tries would reach about ${formatValue(predictedAt(curve, "best", next), rank)}.`;
  }
  $("bon-note").textContent = note;

  if ($("bon-details").open && performance.now() - state.tablesAt > 500) {
    const rows = [];
    for (let n = 1; n <= nMax; n *= 10) {
      rows.push([
        nf.format(n),
        n <= monkeys ? formatValue(stepAt(s.bestCurve, n), rank, 2) : "—",
        th.valid ? formatValue(predictedAt(curve, "best", n), rank, 2) : "—",
        n <= monkeys ? formatValue(stepAt(s.typicalCurve, n), rank, 2) : "—",
        th.valid ? formatValue(predictedAt(curve, "typical", n), rank, 2) : "—",
      ]);
    }
    table("bon-table", ["Monkeys", "Best match", "Predicted", "Typical painting", "Predicted"], rows);
  }
}

/** "10" + superscript exponent, as DOM nodes. */
function power(exp) {
  const n = Math.round(exp);
  const span = document.createElement("span");
  span.className = "power";
  const visual = document.createElement("span");
  visual.setAttribute("aria-hidden", "true");
  const sup = document.createElement("sup");
  sup.textContent = String(n);
  visual.append("10", sup);
  const spoken = document.createElement("span");
  spoken.className = "sr-only";
  spoken.textContent = `10 to the power of ${n}`;
  span.append(visual, spoken);
  return span;
}

function sentence(parts) {
  const p = document.createElement("p");
  p.append(...parts);
  return p;
}

function renderOdds(perSecond) {
  const K = state.data.palette.length;
  const size = state.size;
  const cells = size * size;
  const N = state.data.works.length;
  const o = exactOdds(K, cells, N, perSecond);
  const key = [K, cells, N, perSecond ? Math.round(Math.log10(perSecond) * 10) : 0].join("|");
  const box = $("odds-text");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const paras = [
    sentence([
      `${size === 8 || size === 18 ? "An" : "A"} ${size} × ${size} grid has ${cells} pixels, and each can be any of ${K} colors, so there are `,
      power(o.oneInLog10),
      ` possible grids. The chance that one monkey paints one particular painting's grid exactly is 1 in `,
      power(o.oneInLog10),
      `, and 1 in about `,
      power(o.anyInLog10),
      ` that it copies any of the ${nf.format(N)}. For scale, the observable universe has about `,
      power(80),
      " atoms.",
    ]),
  ];
  if (o.waitYearsLog10 != null) {
    const wait = o.waitYearsLog10;
    paras.push(
      sentence(
        wait > 10
          ? [
              `At ${nf.format(Math.round(perSecond))} grids a second, you would expect to wait about `,
              power(wait),
              " years for the first exact copy. The universe is about 14 billion (1.4 × ",
              power(10),
              ") years old.",
            ]
          : [`At ${nf.format(Math.round(perSecond))} grids a second, you would expect the first exact copy within about ${formatWait(wait)}.`],
      ),
    );
  }
  const hits = o.universeHitsLog10;
  paras.push(
    sentence(
      hits < 0
        ? [
            "Even if every atom in the universe had been a monkey painting a billion grids a second since the Big Bang, the chance that any of them had copied a painting yet would be about 1 in ",
            power(-hits),
            ".",
          ]
        : [
            "If every atom in the universe had been a monkey painting a billion grids a second since the Big Bang, they would have made about ",
            power(hits),
            ` exact copies by now: each painting about `,
            power(hits - Math.log10(N)),
            " times over. Small grids are a different universe.",
          ],
    ),
  );
  box.replaceChildren(...paras);
}

function formatWait(log10Years) {
  const seconds = 10 ** log10Years * 365.25 * 24 * 3600;
  if (seconds < 120) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 3.15e7 * 2) return `${Math.round(seconds / 86400)} days`;
  return `${nf.format(Math.round(seconds / 3.15e7))} years`;
}

function renderStats(u) {
  const s = u.stats;
  const th = state.theory;
  if (!s || !th || th.rank !== s.rank) return;
  $("rank-note").hidden = s.rank !== "surprise";
  renderHistogram(s, th);
  renderCompare(s, th);
  renderBestOfN(s, th);
  renderOdds(u.running ? u.perSecond : state.lastRate || 0);
  if (u.running && u.perSecond > 0) state.lastRate = u.perSecond;
  if (performance.now() - state.tablesAt > 500) state.tablesAt = performance.now();
}

function render() {
  state.pending = false;
  const u = state.latest;
  if (!u || !state.data) return;
  renderGallery(u);
  renderStats(u);
}

function scheduleRender() {
  if (!state.pending) {
    state.pending = true;
    requestAnimationFrame(render);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function startWorker() {
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (err) {
    throw new Error(`This browser can't run the monkey in the background (${err.message}). Try a recent Chrome, Firefox or Safari.`);
  }
  worker.onmessage = ({ data: msg }) => {
    if (msg.type === "update") {
      // Ignore stragglers from before a grid-size switch.
      const cells = state.size * state.size;
      if (msg.current && msg.current.grid.length !== cells) return;
      if (msg.best && msg.best.grid.length !== cells) return;
      state.latest = msg;
      if (msg.best !== undefined) state.best = msg.best;
      state.running = msg.running;
      $("run").textContent = msg.running ? "Stop" : "Start";
      if (msg.stats && msg.stats.monkeys === 0) state.histWin = null;
      scheduleRender();
    } else if (msg.type === "theory") {
      state.theory = msg;
      state.histWin = null;
      scheduleRender();
    } else if (msg.type === "ready") {
      setControlsEnabled(true);
    } else if (msg.type === "error") {
      showNotice(msg.message);
      $("run").textContent = "Start";
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    showNotice(`The monkey crashed${event.message ? `: ${event.message}` : ""}. Reload the page to try again.`);
    setControlsEnabled(false);
  };
}

function sendConfig(extra = {}) {
  worker?.postMessage({
    type: "config",
    level: Number($("level").value),
    rate: Number($("speed").value),
    rank: $("rank").value,
    ...extra,
  });
}

async function useSize(size) {
  setControlsEnabled(false);
  const wasRunning = state.running;
  worker?.postMessage({ type: "stop" });
  const data = await loadGrids(size);
  state.data = data;
  state.size = data.size;
  state.rgb = data.palette.map(hexToRgb);
  state.best = null;
  state.theory = null;
  document.querySelectorAll("[data-size-label]").forEach((el) => (el.textContent = `${data.size} × ${data.size}`));
  document.querySelectorAll("[data-works-count]").forEach((el) => (el.textContent = nf.format(data.works.length)));
  sendConfig();
  worker.postMessage({ type: "init", data });
  if (wasRunning) worker.postMessage({ type: "start" });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function toggleRun() {
  if (!worker) return;
  worker.postMessage({ type: state.running ? "stop" : "start" });
}

function setupControls() {
  const level = $("level");
  for (const l of LEVELS) {
    const opt = document.createElement("option");
    opt.value = l.level;
    opt.textContent = `Level ${l.level}: ${l.name}`;
    opt.title = l.blurb;
    level.append(opt);
  }

  $("run").addEventListener("click", toggleRun);
  $("reset").addEventListener("click", () => {
    state.best = null;
    worker?.postMessage({ type: "reset" });
  });
  $("speed").addEventListener("change", () => sendConfig());
  $("level").addEventListener("change", () => {
    state.best = null;
    sendConfig({ reset: true });
  });
  $("rank").addEventListener("change", () => {
    state.rank = $("rank").value;
    state.best = null;
    sendConfig({ reset: true });
  });
  $("size").addEventListener("change", async (event) => {
    const select = event.target;
    const previous = state.size;
    try {
      showNotice("");
      await useSize(Number(select.value));
    } catch (err) {
      showNotice(err.message);
      select.value = String(previous);
      setControlsEnabled(Boolean(state.data));
    }
  });
  for (const id of ["hist-details", "bon-details"]) {
    $(id).addEventListener("toggle", () => {
      state.tablesAt = 0;
      scheduleRender();
    });
  }
  window.addEventListener("resize", scheduleRender);

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (event.target.closest?.("select, input, textarea, button, a, summary, [tabindex]")) return;
    event.preventDefault();
    toggleRun();
  });
}

async function main() {
  state.rank = $("rank").value;
  setupControls();
  try {
    startWorker();
    await useSize(Number($("size").value));
  } catch (err) {
    showNotice(err.message);
    setControlsEnabled(false);
  }
}

main();
