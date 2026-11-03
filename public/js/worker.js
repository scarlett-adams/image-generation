// The monkey. Runs in a Web Worker so the page stays smooth while it
// generates grids, scores each one against every painting, and keeps the
// statistics.
//
// Messages in:  init {data, seed?} | config {level?, rate?, rank?, reset?}
//               | start | stop | reset
// Messages out: ready {N, size} | theory {...} | update {...} | error {message}

import { exactMatch, generate, makeModel, mulberry32, scoreAgainstAll } from "./core.js";
import {
  SCALES,
  effectiveComparisons,
  iidTheory,
  logSteps,
  makeTally,
  meanSd,
  predictedBestOfN,
  predictedDistributions,
  recordMonkey,
} from "./stats.js";

const POST_EVERY_MS = 80; // ~12 updates a second
const TICK_BUDGET_MS = 30; // work per tick before yielding

let model = null;
let sums, rows, cur, values;
let rand = Math.random;

let running = false;
let level = 0;
let rate = Infinity; // monkeys per second
let rank = "similarity"; // or "surprise"

let theory = null; // iidTheory for the current model and level
let invSd = null;
let predicted = null;
let tally = null;

let best = null;
let bestChanged = false;
let last = null; // latest monkey's match
let ranSincePost = 0;

let timer = null;
let allowance = 0;
let lastTick = 0;
let lastPost = 0;
let rateWindow = []; // [time, monkeys] samples for the observed speed

function scale() {
  return SCALES[rank];
}

function reset() {
  tally = model ? makeTally(model.N, scale()) : null;
  best = null;
  bestChanged = true;
  last = null;
  allowance = 0;
  rateWindow = [];
  if (cur) cur.fill(0);
}

/** Recomputes the predictions and sends them to the page. */
function refreshTheory() {
  // Level 0 draws every pixel independently and uniformly, which is what
  // the theory assumes.
  theory = iidTheory(model);
  invSd = theory.sd.map((s) => (s > 0 ? 1 / s : 0));
  const sc = scale();
  const dist = predictedDistributions(theory, rank, sc);
  predicted = { ...dist, valid: true };
  const bestOfN = predictedBestOfN(theory, rank, sc, dist.logF, logSteps(1e12));
  self.postMessage({
    type: "theory",
    rank,
    level,
    valid: predicted.valid,
    scale: sc,
    pairs: dist.pairs,
    match: dist.match,
    pairStats: dist.pairStats,
    matchStats: dist.matchStats,
    exact: dist.exact,
    bestOfN,
    N: model.N,
  });
}

function runOne() {
  generate(level, cur, model, rand);
  scoreAgainstAll(model, cur, sums, rows);
  const inv = 1 / (model.cells * model.maxDist);
  const { N } = model;
  if (rank === "surprise") {
    const { mu } = theory;
    for (let w = 0; w < N; w++) values[w] = (1 - sums[w] * inv - mu[w]) * invSd[w];
  } else {
    for (let w = 0; w < N; w++) values[w] = 1 - sums[w] * inv;
  }
  const w = recordMonkey(tally, values);
  const sim = 1 - sums[w] * inv;
  const z = (sim - theory.mu[w]) * invSd[w];
  const exact = exactMatch(model, cur, w);
  tally.matchExactSum += exact;
  // Exact matches against a couple of random paintings, to estimate the
  // average for "one monkey vs one painting" without checking all of them.
  for (let k = 0; k < 2; k++) {
    tally.pairExactSum += exactMatch(model, cur, (rand() * N) | 0);
    tally.pairExactCount++;
  }
  ranSincePost++;
  last = { work: w, value: values[w], sim, z, exact };
  if (!best || values[w] > best.value) {
    best = { grid: cur.slice(), work: w, value: values[w], sim, z, exact, at: tally.monkeys };
    bestChanged = true;
  }
}

function observedRate(now) {
  const n = tally ? tally.monkeys : 0;
  rateWindow.push([now, n]);
  while (rateWindow.length > 2 && now - rateWindow[0][0] > 2000) rateWindow.shift();
  const [t0, n0] = rateWindow[0];
  return now > t0 ? ((n - n0) * 1000) / (now - t0) : 0;
}

function snapshot() {
  const t = tally;
  const N = model.N;
  const match = meanSd(t.matchSum, t.matchSq, t.monkeys);
  return {
    rank,
    monkeys: t.monkeys,
    comparisons: t.monkeys * N,
    pairsHist: t.pairsHist.slice(),
    matchHist: t.matchHist.slice(),
    pair: meanSd(t.pairSum, t.pairSq, t.monkeys * N),
    match,
    pairExact: t.pairExactCount ? t.pairExactSum / t.pairExactCount : NaN,
    matchExact: t.monkeys ? t.matchExactSum / t.monkeys : NaN,
    bestCurve: t.bestCurve.slice(),
    typicalCurve: t.typicalCurve.slice(),
    effectiveN:
      predicted?.valid && t.monkeys >= 200
        ? effectiveComparisons(predicted.logF, t.scale, match.mean, N)
        : null,
  };
}

function post(now) {
  if (!model || !tally) return;
  const msg = {
    type: "update",
    running,
    tried: tally.monkeys,
    perSecond: running ? observedRate(now) : 0,
    current: last ? { grid: cur.slice(), ...last } : null,
    best: bestChanged ? best : undefined,
    stats: snapshot(),
  };
  bestChanged = false;
  ranSincePost = 0;
  lastPost = now;
  self.postMessage(msg, [msg.stats.pairsHist.buffer, msg.stats.matchHist.buffer]);
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
        values = new Float64Array(model.N);
        rows = new Int32Array(model.cells);
        cur = new Uint8Array(model.cells);
        rand = msg.seed != null ? mulberry32(msg.seed) : Math.random; // seed: repeatable runs
        refreshTheory();
        reset();
        self.postMessage({ type: "ready", N: model.N, size: model.size });
        post(performance.now());
        if (wasRunning) start();
        break;
      }
      case "config": {
        let changed = false;
        if (msg.level != null && msg.level !== level) {
          level = msg.level;
          changed = true;
        }
        if (msg.rank != null && msg.rank !== rank) {
          rank = msg.rank === "surprise" ? "surprise" : "similarity";
          changed = true;
        }
        if (msg.rate != null) rate = msg.rate > 0 ? msg.rate : Infinity;
        if (model && changed) refreshTheory();
        if (model && (changed || msg.reset)) {
          reset();
          post(performance.now());
        }
        break;
      }
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
