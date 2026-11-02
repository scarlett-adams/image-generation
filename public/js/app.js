import { LEVELS, hexToRgb } from "./core.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

const state = {
  data: null, // parsed grids.json
  rgb: [], // palette as [r, g, b]
  size: 16,
  running: false,
  latest: null, // last update from the worker
  best: null,
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
// Drawing
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

function clearCanvas(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function work(i) {
  return state.data?.works[i];
}

function artistLine(w) {
  return w.artist || "Unknown artist";
}

function render() {
  state.pending = false;
  const u = state.latest;
  if (!u) return;
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
    $("current-title").textContent = `${pct(u.current.sim)} similar to “${w.title}”`;
    $("current-score").textContent = `${pct(u.current.exact, 0)} of pixels exactly right`;
  } else {
    clearCanvas($("current"));
    $("current-title").textContent = "—";
    $("current-score").textContent = "";
  }

  const b = state.best;
  if (b && work(b.work)) {
    drawGrid($("best"), b.grid, size);
    $("best-score").textContent = `${pct(b.sim)} similar`;
    $("best-meta").textContent = `${pct(b.exact, 0)} of pixels exactly right · found by monkey #${nf.format(b.at)}`;
    const w = work(b.work);
    drawGrid($("closest"), state.data.works[b.work].grid, size);
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
  $("level").addEventListener("change", () => sendConfig({ reset: true }));
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

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (event.target.closest?.("select, input, textarea, button, a")) return;
    event.preventDefault();
    toggleRun();
  });
}

async function main() {
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
