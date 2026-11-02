// The monkey. Runs in a Web Worker so the page stays smooth while it
// generates and scores grids as fast as it can.
//
// Messages in:  init {data} | config {level, rate} | start | stop | reset
// Messages out: ready {N, size} | update {...} | error {message}

import {
  exactMatch,
  generate,
  makeModel,
  mulberry32,
  scoreAgainstAll,
  similarityFromSum,
} from "./core.js";

const POST_EVERY_MS = 80; // ~12 updates a second
const TICK_BUDGET_MS = 30; // work per tick before yielding

let model = null;
let sums, rows, cur;
let rand = Math.random;

let running = false;
let level = 0;
let rate = Infinity; // monkeys per second

let tried = 0;
let best = null;
let bestChanged = false;
let last = null; // latest monkey: {work, sim, exact}
let ranSincePost = 0;

let timer = null;
let allowance = 0;
let lastTick = 0;
let lastPost = 0;
let rateWindow = []; // [time, tried] samples for the observed speed

function reset() {
  tried = 0;
  best = null;
  bestChanged = true;
  last = null;
  allowance = 0;
  rateWindow = [];
  if (cur) cur.fill(0);
}

function runOne() {
  generate(level, cur, model, rand);
  const w = scoreAgainstAll(model, cur, sums, rows);
  const sim = similarityFromSum(model, sums[w]);
  tried++;
  ranSincePost++;
  last = { work: w, sim };
  if (!best || sim > best.sim) {
    best = { grid: cur.slice(), work: w, sim, exact: exactMatch(model, cur, w), at: tried };
    bestChanged = true;
  }
}

function observedRate(now) {
  rateWindow.push([now, tried]);
  while (rateWindow.length > 2 && now - rateWindow[0][0] > 2000) rateWindow.shift();
  const [t0, n0] = rateWindow[0];
  return now > t0 ? ((tried - n0) * 1000) / (now - t0) : 0;
}

function post(now) {
  const msg = {
    type: "update",
    running,
    tried,
    perSecond: running ? observedRate(now) : 0,
    current: last ? { grid: cur.slice(), work: last.work, sim: last.sim, exact: exactMatch(model, cur, last.work) } : null,
    best: bestChanged ? best : undefined,
  };
  bestChanged = false;
  ranSincePost = 0;
  lastPost = now;
  self.postMessage(msg);
}

function tick() {
  timer = null;
  if (!running || !model) return;
  const now = performance.now();
  const end = now + TICK_BUDGET_MS;
  try {
    if (rate === Infinity) {
      do {
        for (let i = 0; i < 8; i++) runOne();
      } while (performance.now() < end);
    } else {
      // Spread `rate` monkeys per second evenly over time.
      allowance = Math.min(allowance + (rate * (now - lastTick)) / 1000, rate * 0.25 + 1);
      let n = Math.floor(allowance);
      allowance -= n;
      while (n-- > 0) {
        runOne();
        if (performance.now() > end) {
          allowance = 0;
          break;
        }
      }
    }
  } catch (err) {
    running = false;
    self.postMessage({ type: "error", message: `The monkey tripped: ${err.message}` });
    return;
  }
  lastTick = now;
  const slow = rate <= 30;
  if ((slow && ranSincePost > 0) || now - lastPost >= POST_EVERY_MS) post(performance.now());
  const delay = rate === Infinity ? 0 : Math.max(4, Math.min(50, 1000 / rate));
  timer = setTimeout(tick, delay);
}

function start() {
  if (running || !model) return;
  running = true;
  lastTick = performance.now();
  rateWindow = [];
  tick();
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  post(performance.now());
}

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case "init": {
        const wasRunning = running;
        stop();
        model = makeModel(msg.data);
        sums = new Float64Array(model.N);
        rows = new Int32Array(model.cells);
        cur = new Uint8Array(model.cells);
        rand = msg.seed != null ? mulberry32(msg.seed) : Math.random; // seed: repeatable runs
        reset();
        self.postMessage({ type: "ready", N: model.N, size: model.size });
        post(performance.now());
        if (wasRunning) start();
        break;
      }
      case "config":
        if (msg.level != null) level = msg.level;
        if (msg.rate != null) rate = msg.rate > 0 ? msg.rate : Infinity;
        if (msg.reset) {
          reset();
          post(performance.now());
        }
        break;
      case "start":
        start();
        break;
      case "stop":
        stop();
        break;
      case "reset":
        reset();
        post(performance.now());
        break;
    }
  } catch (err) {
    running = false;
    self.postMessage({ type: "error", message: err.message });
  }
};
