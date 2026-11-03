// The monkey. Runs in a Web Worker so the page stays smooth while it
// generates grids, scores them, and keeps the statistics.
//
// Messages in:  init {data, seed?}
//               config {level?, rate?, rank?, mode?, target?, reset?}
//               start | stop | reset
// Messages out: ready {N, size} | theory {...} | update {...} | error {message}
//
// Modes:
//  - chance:   every grid is new; scored against every painting (or just
//              the target, if one is chosen)
//  - mutation: Dawkins's weasel. Keep the best grid so far, make 100
//              children with a pixel or so changed, keep the best child.

import {
  collectionShares,
  colorShares,
  exactMatch,
  generate,
  makeModel,
  makeSampler,
  mulberry32,
  mutateGeneration,
  scoreAgainstAll,
  subModel,
} from "./core.js";
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
const BROOD = 100; // children per generation (mutation mode)
const MUTATIONS = 1; // expected changed pixels per child

let full = null; // model with every painting
let model = null; // what we score against: everything, or just the target
let sums, rows, cur, values, child, bestChild;
let rand = Math.random;

let running = false;
let level = 0;
let rate = Infinity; // grids per second
let rank = "similarity"; // or "surprise"
let mode = "chance"; // or "mutation"
let target = null; // index into the full collection, or null

let sampler = null; // color sampler for the current level/target
let workSamplers = null; // level 3 without a target: one per painting
let theory = null;
let invSd = null;
let predicted = null;
let tally = null;

let best = null;
let bestChanged = false;
let last = null;
let ranSincePost = 0;
let finished = false; // mutation: exact copy reached

// mutation state
let parent = null;
let parentSum = Infinity;
let generations = 0;
let mutationCurve = [];

let timer = null;
let allowance = 0;
let lastTick = 0;
let lastPost = 0;
let rateWindow = [];

function scale() {
  return SCALES[mode === "mutation" || target != null ? "similarity" : rank];
}

function effectiveRank() {
  return mode === "mutation" || target != null ? "similarity" : rank;
}

/** Marginal color distribution of the current level's pixels. */
function levelShares() {
  if (level !== 3) return null; // uniform
  return target != null ? colorShares(full, target) : collectionShares(full);
}

function setupSamplers() {
  sampler = makeSampler(levelShares(), full.K);
  workSamplers = level === 3 && target == null
    ? Array.from({ length: full.N }, (_, w) => makeSampler(colorShares(full, w), full.K))
    : null;
}

function rebuild() {
  // The weasel needs a target; pick one at random if none was chosen.
  if (mode === "mutation" && target == null) target = (rand() * full.N) | 0;
  model = target != null ? subModel(full, target) : full;
  sums = new Float64Array(model.N);
  values = new Float64Array(model.N);
  setupSamplers();
  refreshTheory();
  reset();
}

function reset() {
  tally = makeTally(model.N, scale());
  best = null;
  bestChanged = true;
  last = null;
  finished = false;
  allowance = 0;
  rateWindow = [];
  parent = null;
  parentSum = Infinity;
  generations = 0;
  mutationCurve = [];
  if (cur) cur.fill(0);
}

/** Predictions for the current setup, sent to the page. In mutation mode
 * they describe pure chance (level 0) against the target, for contrast. */
function refreshTheory() {
  const q = mode === "mutation" ? null : levelShares();
  theory = iidTheory(model, q ? Array.from(q) : null);
  invSd = theory.sd.map((s) => (s > 0 ? 1 / s : 0));
  const r = effectiveRank();
  const sc = scale();
  const dist = predictedDistributions(theory, r, sc);
  predicted = { ...dist, exactModel: level === 0 || mode === "mutation" };
  self.postMessage({
    type: "theory",
    rank: r,
    level,
    mode,
    target,
    exactModel: predicted.exactModel,
    scale: sc,
    pairs: dist.pairs,
    match: dist.match,
    pairStats: dist.pairStats,
    matchStats: dist.matchStats,
    exact: dist.exact,
    bestOfN: predictedBestOfN(theory, r, sc, dist.logF, logSteps(1e12)),
    N: model.N,
  });
}

// ---------------------------------------------------------------------------
// Pure chance
// ---------------------------------------------------------------------------

function runChance() {
  const draw = workSamplers ? workSamplers[(rand() * workSamplers.length) | 0] : sampler;
  generate(level, cur, full, rand, level === 3 ? draw : undefined);
  scoreAgainstAll(model, cur, sums, rows);
  const inv = 1 / (model.cells * model.maxDist);
  const { N } = model;
  if (effectiveRank() === "surprise") {
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
  for (let k = 0; k < 2; k++) {
    tally.pairExactSum += exactMatch(model, cur, (rand() * N) | 0);
    tally.pairExactCount++;
  }
  ranSincePost++;
  const work = target != null ? target : w;
  last = { work, value: values[w], sim, z, exact };
  if (!best || values[w] > best.value) {
    best = { grid: cur.slice(), work, value: values[w], sim, z, exact, at: tally.monkeys };
    bestChanged = true;
  }
}

// ---------------------------------------------------------------------------
// Mutation (cumulative selection)
// ---------------------------------------------------------------------------

function runGeneration() {
  const inv = 1 / (model.cells * model.maxDist);
  if (!parent) {
    parent = generate(level, new Uint8Array(model.cells), full, rand, level === 3 ? sampler : undefined);
    parentSum = scoreAgainstAllOne(parent);
    tally.monkeys++;
    mutationCurve.push([tally.monkeys, 1 - parentSum * inv]);
  }
  const s = mutateGeneration(model, parent, BROOD, MUTATIONS, sampler, rand, child, bestChild);
  generations++;
  tally.monkeys += BROOD;
  ranSincePost += BROOD;
  if (s <= parentSum) {
    const improved = s < parentSum;
    parent.set(bestChild);
    parentSum = s;
    if (improved) mutationCurve.push([tally.monkeys, 1 - s * inv]);
  }
  const sim = 1 - parentSum * inv;
  const exact = exactMatch(model, parent, 0);
  last = { work: target, value: 1 - s * inv, sim: 1 - s * inv, z: NaN, exact: exactMatch(model, bestChild, 0), grid: bestChild };
  best = { grid: parent.slice(), work: target, value: sim, sim, z: NaN, exact, at: tally.monkeys, generation: generations };
  bestChanged = true;
  if (parentSum === 0) {
    finished = true;
    running = false;
  }
}

function scoreAgainstAllOne(grid) {
  scoreAgainstAll(model, grid, sums, rows);
  return sums[0];
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

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
  if (mode === "mutation") {
    return {
      mode,
      rank: "similarity",
      monkeys: t.monkeys,
      generations,
      curve: mutationCurve.slice(),
      sim: best ? best.sim : NaN,
      exact: best ? best.exact : NaN,
      cells: model.cells,
      K: model.K,
      finished,
    };
  }
  const match = meanSd(t.matchSum, t.matchSq, t.monkeys);
  return {
    mode,
    rank: effectiveRank(),
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
      predicted?.exactModel && N > 1 && t.monkeys >= 200
        ? effectiveComparisons(predicted.logF, t.scale, match.mean, N)
        : null,
  };
}

function post(now) {
  if (!model || !tally) return;
  const current = last
    ? { ...last, grid: (last.grid || cur).slice() }
    : null;
  const msg = {
    type: "update",
    running,
    mode,
    target,
    tried: tally.monkeys,
    perSecond: running ? observedRate(now) : 0,
    current,
    best: bestChanged ? best : undefined,
    stats: snapshot(),
  };
  bestChanged = false;
  ranSincePost = 0;
  lastPost = now;
  const transfer = msg.stats.pairsHist ? [msg.stats.pairsHist.buffer, msg.stats.matchHist.buffer] : [];
  self.postMessage(msg, transfer);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function runOne() {
  if (mode === "mutation") runGeneration();
  else runChance();
}

/** Grids produced by one runOne() call. */
function unit() {
  return mode === "mutation" ? BROOD : 1;
}

function tick() {
  timer = null;
  if (!running || !model) return;
  const now = performance.now();
  const end = now + TICK_BUDGET_MS;
  try {
    if (rate === Infinity) {
      do {
        for (let i = 0; i < 8 && running; i++) runOne();
      } while (running && performance.now() < end);
    } else {
      allowance = Math.min(allowance + (rate * (now - lastTick)) / 1000, rate * 0.25 + unit());
      while (running && allowance >= unit()) {
        runOne();
        allowance -= unit();
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
  if (!running || (slow && ranSincePost > 0) || now - lastPost >= POST_EVERY_MS) post(performance.now());
  if (!running) return;
  const delay = rate === Infinity ? 0 : Math.max(4, Math.min(50, (1000 * unit()) / rate));
  timer = setTimeout(tick, delay);
}

function start() {
  if (running || !model) return;
  if (finished) reset();
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
        full = makeModel(msg.data);
        rows = new Int32Array(full.cells);
        cur = new Uint8Array(full.cells);
        child = new Uint8Array(full.cells);
        bestChild = new Uint8Array(full.cells);
        if (target != null && target >= full.N) target = null;
        rand = msg.seed != null ? mulberry32(msg.seed) : Math.random; // seed: repeatable runs
        rebuild();
        self.postMessage({ type: "ready", N: full.N, size: full.size });
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
        if (msg.mode != null && msg.mode !== mode) {
          mode = msg.mode === "mutation" ? "mutation" : "chance";
          changed = true;
        }
        if ("target" in msg) {
          const t = msg.target == null || msg.target === "" ? null : Number(msg.target);
          if (t !== target) {
            target = Number.isInteger(t) && full && t >= 0 && t < full.N ? t : null;
            changed = true;
          }
        }
        if (msg.rate != null) rate = msg.rate > 0 ? msg.rate : Infinity;
        if (full && changed) rebuild();
        else if (full && msg.reset) reset();
        if (full && (changed || msg.reset)) post(performance.now());
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
