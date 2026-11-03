// The page: loads the painting grids, runs the monkey in a Web Worker,
// and draws the gallery, the real painting, the statistics and findings.

import { LEVELS, hexToRgb } from "./core.js";
import { formatValue } from "./charts.js";
import { renderFindings } from "./findings.js";
import { revealWork } from "./reveal.js";
import { forceTables, renderStats, resetStatsView } from "./statsview.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

const state = {
  data: null, // parsed grids.json
  rgb: [], // palette as [r, g, b]
  size: 16,
  rank: "similarity",
  mode: "chance",
  target: null, // index into data.works, or null
  targetByLabel: new Map(),
  running: false,
  latest: null, // last update from the worker
  best: null,
  theory: null,
  pending: false,
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
  for (const id of ["run", "reset", "target-random", "target-clear"]) $(id).disabled = !enabled;
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

/** Shows a grid in a painting's real proportions, fitted inside the box. */
function setAspect(canvas, aspect) {
  const a = aspect > 0 ? aspect : 1;
  canvas.style.width = `${Math.min(1, a) * 100}%`;
  canvas.style.height = `${Math.min(1, 1 / a) * 100}%`;
}

function clearCanvas(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function work(i) {
  return i == null ? null : state.data?.works[i] || null;
}

function workLabel(w) {
  return `${w.title} — ${w.artist || "Unknown artist"}${w.dated ? `, ${w.dated}` : ""}`;
}

function showArtwork(w, kicker) {
  $("closest-kicker").textContent = kicker;
  if (!w) {
    clearCanvas($("closest"));
    $("closest-artist").textContent = "—";
    $("closest-title").textContent = "";
    $("closest-dated").textContent = "";
    $("closest-culture").textContent = "";
    return;
  }
  drawGrid($("closest"), w.grid, state.size);
  setAspect($("closest"), w.aspect);
  $("closest-artist").textContent = w.artist || "Unknown artist";
  $("closest-title").textContent = w.title;
  $("closest-dated").textContent = w.dated ? `, ${w.dated}` : "";
  $("closest-culture").textContent = w.culture || "";
}

function renderGallery(u) {
  const size = state.size;
  const mutation = u.mode === "mutation";
  const targeted = mutation || state.target != null;
  $("tried").textContent = nf.format(u.tried);
  $("tried-label").textContent = u.tried === 1 ? "grid tried" : "grids tried";
  if (u.running) {
    const against = targeted ? "the target" : `${nf.format(state.data.works.length)} paintings`;
    $("rate").textContent = `${nf.format(Math.round(u.perSecond))} grids a second, each compared with ${against}`;
  } else if (mutation && u.stats?.finished) {
    $("rate").textContent = "Done: an exact copy. Press Start to evolve another.";
  } else {
    $("rate").textContent = u.tried ? "Paused." : "Press Start (or the space bar) to set the monkey loose.";
  }

  // Latest attempt
  const c = u.current;
  $("current-kicker").textContent = mutation ? "Best child of the latest generation" : "Latest attempt";
  if (c) {
    drawGrid($("current"), c.grid, size);
    const w = work(c.work) || { title: "?" };
    if (mutation || state.target != null) {
      $("current-title").textContent = `${pct(c.sim)} similar to the target`;
      $("current-score").textContent = `${pct(c.exact, 0)} of pixels exactly right`;
    } else if (state.rank === "surprise") {
      $("current-title").textContent = `${formatValue(c.z, "surprise")} for “${w.title}”`;
      $("current-score").textContent = `${pct(c.sim)} similar · ${pct(c.exact, 0)} of pixels exactly right`;
    } else {
      $("current-title").textContent = `${pct(c.sim)} similar to “${w.title}”`;
      $("current-score").textContent = `${pct(c.exact, 0)} of pixels exactly right`;
    }
  } else {
    clearCanvas($("current"));
    $("current-title").textContent = "—";
    $("current-score").textContent = "";
  }

  // Best so far
  const b = state.best;
  $("best-kicker").textContent = mutation ? `Surviving grid${b?.generation ? ` · generation ${nf.format(b.generation)}` : ""}` : "Best so far";
  if (b && work(b.work)) {
    drawGrid($("best"), b.grid, size);
    $("best-score").textContent =
      !targeted && state.rank === "surprise" ? `${formatValue(b.z, "surprise")} for its painting (${pct(b.sim)} similar)` : `${pct(b.sim)} similar`;
    $("best-meta").textContent = mutation
      ? `${pct(b.exact, 0)} of pixels exactly right after ${nf.format(b.at)} grids`
      : `${pct(b.exact, 0)} of pixels exactly right · found by monkey #${nf.format(b.at)}`;
  } else {
    clearCanvas($("best"));
    $("best-score").textContent = "—";
    $("best-meta").textContent = "";
  }

  // The painting: the target, or the best grid's closest match
  if (targeted) showArtwork(work(state.target), "Target");
  else showArtwork(b ? work(b.work) : null, "Closest artwork");
  revealWork(targeted ? work(state.target) : b ? work(b.work) : null);
}

function render() {
  state.pending = false;
  const u = state.latest;
  if (!u || !state.data) return;
  renderGallery(u);
  renderStats(u, state.theory, {
    K: state.data.palette.length,
    size: state.size,
    level: Number($("level").value),
    exactModel: Boolean(state.theory?.exactModel),
  });
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
      if (msg.target !== state.target) setTarget(msg.target, { send: false });
      state.latest = msg;
      if (msg.best !== undefined) state.best = msg.best;
      state.running = msg.running;
      $("run").textContent = msg.running ? "Stop" : "Start";
      if (msg.stats && msg.stats.monkeys === 0) resetStatsView();
      scheduleRender();
    } else if (msg.type === "theory") {
      state.theory = msg;
      resetStatsView();
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
    mode: $("mode").value,
    target: state.target,
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
  buildTargetList();
  renderFindings(data);
  sendConfig();
  worker.postMessage({ type: "init", data });
  if (wasRunning) worker.postMessage({ type: "start" });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function buildTargetList() {
  state.targetByLabel = new Map();
  const options = state.data.works.map((w, i) => {
    let label = workLabel(w);
    if (state.targetByLabel.has(label)) label = `${label} (#${w.id})`;
    state.targetByLabel.set(label, i);
    const opt = document.createElement("option");
    opt.value = label;
    return opt;
  });
  $("target-list").replaceChildren(...options);
  if (state.target != null && state.target >= state.data.works.length) state.target = null;
  $("target-input").value = state.target != null ? workLabel(state.data.works[state.target]) : "";
}

function findTarget(text) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  for (const [label, i] of state.targetByLabel) if (label.toLowerCase() === q) return i;
  for (const [label, i] of state.targetByLabel) if (label.toLowerCase().includes(q)) return i;
  return undefined;
}

function setTarget(index, { send = true } = {}) {
  state.target = index == null ? null : index;
  state.best = null;
  $("target-input").value = state.target != null && state.data ? workLabel(state.data.works[state.target]) : "";
  updateHelp();
  if (send) sendConfig();
}

function updateHelp() {
  const level = LEVELS[Number($("level").value)] || LEVELS[0];
  const mode = $("mode").value;
  const N = state.data ? nf.format(state.data.works.length) : "every";
  const parts = [];
  if (mode === "mutation") {
    parts.push(
      "Mutation: keep the best grid so far, make 100 copies with about one pixel changed, keep the closest to the target, repeat.",
      `It starts from a level ${level.level} grid${level.level === 3 ? " and mutates with the target's colors" : ""}.`,
    );
  } else {
    parts.push(`Level ${level.level}, ${level.name.toLowerCase()}: ${level.blurb}`);
    parts.push(state.target != null ? "Each grid is compared with the target only." : `Each grid is compared with all ${N} paintings.`);
  }
  $("mode-help").textContent = parts.join(" ");
  const rankLocked = mode === "mutation" || state.target != null;
  $("rank").disabled = rankLocked;
  $("rank").title = rankLocked ? "With a single target, similarity and surprise rank the same way." : "";
}

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
  for (const id of ["level", "rank"]) {
    $(id).addEventListener("change", () => {
      state.rank = $("rank").value;
      state.best = null;
      updateHelp();
      sendConfig({ reset: true });
    });
  }
  $("mode").addEventListener("change", () => {
    state.mode = $("mode").value;
    state.best = null;
    if (state.mode === "mutation") {
      // Fast enough to watch it converge in a few seconds, slow enough to see it.
      if ($("speed").value === "0") $("speed").value = "10000";
      if (state.target == null && state.data) state.target = Math.floor(Math.random() * state.data.works.length);
    }
    setTarget(state.target, { send: false });
    sendConfig({ reset: true });
  });
  $("target-input").addEventListener("change", () => {
    const found = findTarget($("target-input").value);
    if (found === undefined) {
      showNotice(`No painting matches “${$("target-input").value}”. Pick one from the list, or press Random.`);
      return;
    }
    showNotice("");
    if (found == null && $("mode").value === "mutation") {
      setTarget(Math.floor(Math.random() * state.data.works.length));
      return;
    }
    setTarget(found);
  });
  $("target-random").addEventListener("click", () => {
    if (state.data) setTarget(Math.floor(Math.random() * state.data.works.length));
  });
  $("target-clear").addEventListener("click", () => {
    if ($("mode").value === "mutation") {
      showNotice("The mutation monkey needs a target. Switch to Pure chance to compare with every painting.");
      return;
    }
    showNotice("");
    setTarget(null);
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
      forceTables();
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
  state.mode = $("mode").value;
  setupControls();
  updateHelp();
  try {
    startWorker();
    await useSize(Number($("size").value));
    updateHelp();
  } catch (err) {
    showNotice(err.message);
    setControlsEnabled(false);
  }
}

main();
