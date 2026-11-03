import assert from "node:assert/strict";
import { test } from "node:test";
import { makeModel, mulberry32, scoreAgainstAll, uniformGrid } from "../public/js/core.js";
import {
  SCALES,
  binOf,
  effectiveComparisons,
  erfc,
  exactOdds,
  expectedMaxOfNormals,
  iidTheory,
  logNormCdf,
  logSteps,
  makeTally,
  meanSd,
  normCdf,
  normInv,
  normSf,
  predictedBestOfN,
  predictedDistributions,
  recordMonkey,
} from "../public/js/stats.js";

const close = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b} (±${eps})`);

/** A small but realistic collection: `N` random paintings built from blocks. */
function collection({ N = 60, size = 16, K = 10, seed = 3 } = {}) {
  const rand = mulberry32(seed);
  const palette = Array.from({ length: K }, (_, i) => {
    const r = Math.round(40 + 200 * rand()), g = Math.round(30 + 180 * rand()), b = Math.round(20 + 160 * rand());
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  });
  const works = Array.from({ length: N }, () => {
    const colors = Array.from({ length: 4 }, () => (rand() * K) | 0);
    const grid = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) grid.push(colors[((y >> 2) + (x >> 3)) % 4]);
    return { grid };
  });
  return makeModel({ size, palette, works });
}

test("normal distribution helpers match reference values", () => {
  close(normCdf(1.959964), 0.975, 1e-6);
  close(normCdf(0), 0.5, 1e-7);
  close(erfc(0.5), 0.4795001222, 1e-7);
  // The upper tail keeps its relative accuracy.
  close(normSf(5) / 2.866515719e-7, 1, 1e-5);
  close(normSf(8) / 6.220960574e-16, 1, 1e-5);
  close(logNormCdf(6), -9.865876e-10, 1e-13);
  close(normInv(0.975), 1.959964, 1e-6);
  close(normInv(0.001), -3.090232, 1e-6);
  close(normInv(normCdf(-2.3)), -2.3, 1e-6);
});

test("expected max of n normals", () => {
  assert.equal(expectedMaxOfNormals(1), 0);
  close(expectedMaxOfNormals(2), 0.5642, 0.03); // Blom is least accurate at tiny n
  close(expectedMaxOfNormals(1000), 3.241, 0.02);
});

test("iid theory predicts the mean and spread of level 0 similarity", () => {
  const model = collection();
  const th = iidTheory(model);
  const rand = mulberry32(11);
  const grid = new Uint8Array(model.cells);
  const sums = new Float64Array(model.N);
  const M = 4000;
  const acc = new Float64Array(model.N);
  const acc2 = new Float64Array(model.N);
  for (let i = 0; i < M; i++) {
    uniformGrid(grid, model.K, rand);
    scoreAgainstAll(model, grid, sums);
    for (let w = 0; w < model.N; w++) {
      const s = 1 - sums[w] / (model.cells * model.maxDist);
      acc[w] += s;
      acc2[w] += s * s;
    }
  }
  for (const w of [0, 7, 31]) {
    const mean = acc[w] / M;
    const sd = Math.sqrt(acc2[w] / M - mean * mean);
    close(mean, th.mu[w], 4 * (th.sd[w] / Math.sqrt(M)) + 1e-4, `mean w${w}`);
    close(sd / th.sd[w], 1, 0.05, `sd w${w}`);
  }
  for (const e of th.exact) close(e, 1 / model.K, 1e-12); // uniform pixels: 1 in K
});

test("predicted distributions are proper and agree with simulation", () => {
  const model = collection();
  const th = iidTheory(model);
  for (const rank of ["similarity", "surprise"]) {
    const scale = SCALES[rank];
    const p = predictedDistributions(th, rank, scale);
    close(p.pairs.reduce((a, b) => a + b, 0), 1, 1e-6, rank);
    close(p.match.reduce((a, b) => a + b, 0), 1, 1e-6, rank);
    assert.ok(p.matchStats.mean > p.pairStats.mean, "the best of N beats a single painting");
    close(p.exact, 0.1, 1e-12);
    if (rank === "surprise") {
      close(p.pairStats.mean, 0, 0.01);
      close(p.pairStats.sd, 1, 0.01);
      close(p.matchStats.mean, expectedMaxOfNormals(model.N), 0.05);
    }
  }
  // Single-pair prediction vs a simulated tally.
  const scale = SCALES.similarity;
  const p = predictedDistributions(th, "similarity", scale);
  const t = makeTally(model.N, scale);
  const rand = mulberry32(5);
  const grid = new Uint8Array(model.cells);
  const sums = new Float64Array(model.N);
  const values = new Float64Array(model.N);
  for (let i = 0; i < 3000; i++) {
    uniformGrid(grid, model.K, rand);
    scoreAgainstAll(model, grid, sums);
    for (let w = 0; w < model.N; w++) values[w] = 1 - sums[w] / (model.cells * model.maxDist);
    recordMonkey(t, values);
  }
  const obs = meanSd(t.pairSum, t.pairSq, t.monkeys * model.N);
  close(obs.mean, p.pairStats.mean, 0.002);
  close(obs.sd / p.pairStats.sd, 1, 0.03);
  // The best of N real comparisons is no better than N independent ones.
  const match = meanSd(t.matchSum, t.matchSq, t.monkeys);
  assert.ok(match.mean <= p.matchStats.mean + 0.002);
  const nEff = effectiveComparisons(p.logF, scale, match.mean, model.N);
  assert.ok(nEff > 1 && nEff <= model.N * 1.2, `n_eff ${nEff}`);
  // Feeding back the independent prediction recovers N.
  close(effectiveComparisons(p.logF, scale, p.matchStats.mean, model.N) / model.N, 1, 0.05);
});

test("best-of-n predictions rise with diminishing returns", () => {
  const model = collection();
  const th = iidTheory(model);
  for (const rank of ["similarity", "surprise"]) {
    const scale = SCALES[rank];
    const p = predictedDistributions(th, rank, scale);
    const ns = [1, 10, 100, 1000, 10000, 100000];
    const curve = predictedBestOfN(th, rank, scale, p.logF, ns);
    const gains = [];
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i].best > curve[i - 1].best, `${rank} best rises`);
      assert.ok(curve[i].typical > curve[i - 1].typical, `${rank} typical rises`);
      gains.push(curve[i].best - curve[i - 1].best);
    }
    for (let i = 2; i < gains.length; i++) assert.ok(gains[i] < gains[i - 1] * 1.02, `${rank} gains shrink`);
    // n = 1 is the median of a single monkey's best match.
    close(curve[0].best, p.matchStats.mean, 3 * p.matchStats.sd);
  }
});

test("tally records histograms, bests and checkpoints", () => {
  const scale = { lo: 0, hi: 1, n: 10 };
  const t = makeTally(3, scale);
  assert.equal(recordMonkey(t, Float64Array.from([0.15, 0.55, 0.35])), 1);
  assert.equal(recordMonkey(t, Float64Array.from([0.95, 0.05, 0.35])), 0);
  assert.equal(recordMonkey(t, Float64Array.from([0.25, 0.45, 0.25])), 1);
  assert.deepEqual([...t.pairsHist], [1, 1, 2, 2, 1, 1, 0, 0, 0, 1]);
  assert.deepEqual([...t.matchHist], [0, 0, 0, 0, 1, 1, 0, 0, 0, 1]);
  assert.deepEqual(t.bestCurve, [[1, 0.55], [2, 0.95]]);
  assert.deepEqual([...t.bestPer], [0.95, 0.55, 0.35]);
  assert.equal(t.typicalCurve[0][0], 1);
  close(meanSd(t.matchSum, t.matchSq, t.monkeys).mean, (0.55 + 0.95 + 0.45) / 3, 1e-12);
  assert.equal(binOf(-5, scale), 0);
  assert.equal(binOf(5, scale), 9);
});

test("exact-copy odds", () => {
  const o = exactOdds(10, 256, 1000, 4000);
  close(o.oneInLog10, 256, 1e-9);
  close(o.anyInLog10, 253, 1e-9);
  close(o.waitYearsLog10, 256 - Math.log10(4e6) - Math.log10(365.25 * 24 * 3600), 1e-9);
  // Every atom a monkey, 1e9 grids/s, since the Big Bang: ~1e106.6 grids.
  close(o.universeHitsLog10, 80 + 9 + Math.log10(13.8e9 * 365.25 * 24 * 3600) + 3 - 256, 1e-9);
  const small = exactOdds(10, 64, 1000, 4000);
  assert.ok(small.universeHitsLog10 > 40, "8x8 grids would be copied many times over");
  assert.equal(exactOdds(10, 64, 1000, 0).waitYearsLog10, null);
  assert.deepEqual(logSteps(100), [1, 2, 3, 5, 10, 20, 30, 50, 100]);
});

test("histogram window stays put across redraws and ignores lone outliers", async () => {
  const { histogramWindow } = await import("../public/js/charts.js");
  const scale = { lo: 0, hi: 1, n: 400 };
  const pred = new Float64Array(400);
  for (let i = 200; i < 240; i++) pred[i] = 1 / 40;
  const obs = new Float64Array(400);
  for (let i = 205; i < 235; i++) obs[i] = 1000;
  obs[10] = 1; // a lone outlier
  obs[390] = 1;
  let win = null;
  const seen = [];
  for (let k = 0; k < 50; k++) {
    win = histogramWindow(scale, [pred], [obs], win);
    seen.push(`${win.lo}-${win.hi}`);
  }
  assert.equal(new Set(seen).size, 1, "no growth across redraws");
  assert.ok(win.lo >= 190 && win.hi <= 250, `window ${win.lo}-${win.hi}`);
});
