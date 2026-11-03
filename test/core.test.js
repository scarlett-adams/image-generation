import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactMatch,
  generate,
  hexToRgb,
  makeModel,
  mulberry32,
  scoreAgainst,
  scoreAgainstAll,
  similarityFromSum,
  srgbToLab,
  uniformGrid,
} from "../public/js/core.js";

const close = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function fixture({ size = 4, works = 3, K = 3 } = {}) {
  const cells = size * size;
  const palette = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"].slice(0, K);
  return {
    size,
    palette,
    works: Array.from({ length: works }, (_, w) => ({
      id: w + 1,
      title: `W${w}`,
      grid: Array.from({ length: cells }, (_, i) => (w + i) % K),
    })),
  };
}

test("hexToRgb", () => {
  assert.deepEqual(hexToRgb("#ff1000"), [255, 16, 0]);
  assert.deepEqual(hexToRgb("0a0b0c"), [10, 11, 12]);
});

test("srgbToLab matches the pipeline's reference values", () => {
  const [L, a, b] = srgbToLab([255, 0, 0]);
  close(L, 53.24);
  close(a, 80.09);
  close(b, 67.2);
  const white = srgbToLab([255, 255, 255]);
  close(white[0], 100, 0.01);
  close(white[1], 0, 0.01);
  close(white[2], 0, 0.01);
});

test("makeModel builds a symmetric distance matrix", () => {
  const m = makeModel(fixture());
  assert.equal(m.K, 3);
  assert.equal(m.cells, 16);
  assert.equal(m.N, 3);
  for (let a = 0; a < m.K; a++) {
    assert.equal(m.D[a * m.K + a], 0);
    for (let b = 0; b < m.K; b++) close(m.D[a * m.K + b], m.D[b * m.K + a], 1e-9);
  }
  // black vs red (ΔE ≈ 117.3) is the widest pair here, wider than black vs white (100)
  close(m.maxDist, Math.hypot(...srgbToLab([255, 0, 0])), 1e-9);
});

test("makeModel prefers paletteLab when present", () => {
  const data = fixture();
  data.paletteLab = [[0, 0, 0], [10, 0, 0], [30, 0, 0]];
  const m = makeModel(data);
  assert.equal(m.maxDist, 30);
});

test("makeModel rejects malformed data", () => {
  assert.throws(() => makeModel(null), /palette/);
  assert.throws(() => makeModel({ palette: ["#000"], works: [] }), /palette size/);
  assert.throws(() => makeModel({ ...fixture(), works: [{ grid: [1, 2] }] }), /no usable works/);
  assert.throws(() => makeModel({ ...fixture(), size: 0 }), /grid size/);
});

test("a grid identical to a work scores 1 and is the closest", () => {
  const data = fixture({ works: 5 });
  const m = makeModel(data);
  const sums = new Float64Array(m.N);
  const grid = Uint8Array.from(data.works[3].grid);
  const best = scoreAgainstAll(m, grid, sums);
  // works 0 and 3 share a grid when K = 3; either is a perfect match
  assert.ok(best === 0 || best === 3);
  assert.equal(similarityFromSum(m, sums[3]), 1);
  assert.equal(exactMatch(m, grid, 3), 1);
  assert.equal(scoreAgainst(m, grid, 3), 0);
});

test("similarity is 0 only when every pixel is the widest-apart pair", () => {
  const data = { size: 2, palette: ["#000000", "#ffffff"], works: [{ grid: [0, 0, 0, 0] }] };
  const m = makeModel(data);
  const sums = new Float64Array(1);
  scoreAgainstAll(m, Uint8Array.from([1, 1, 1, 1]), sums);
  close(similarityFromSum(m, sums[0]), 0, 1e-12);
  scoreAgainstAll(m, Uint8Array.from([1, 1, 0, 0]), sums);
  close(similarityFromSum(m, sums[0]), 0.5, 1e-12);
  assert.equal(exactMatch(m, Uint8Array.from([1, 1, 0, 0]), 0), 0.5);
});

test("mulberry32 is repeatable and in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("level 0 is uniform over the palette", () => {
  const K = 10;
  const out = new Uint8Array(100000);
  uniformGrid(out, K, mulberry32(7));
  const counts = new Array(K).fill(0);
  for (const v of out) counts[v]++;
  for (const c of counts) close(c / out.length, 1 / K, 0.005);
  const m = makeModel(fixture());
  const g = generate(0, new Uint8Array(m.cells), m, mulberry32(1));
  assert.ok(g.every((v) => v < m.K));
});

test("color sampler follows its distribution", async () => {
  const { makeSampler } = await import("../public/js/core.js");
  const q = [0.5, 0.25, 0, 0.25];
  const draw = makeSampler(q, 4);
  const rand = mulberry32(3);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 40000; i++) counts[draw(rand())]++;
  counts.forEach((c, i) => close(c / 40000, q[i], 0.01));
  const uniform = makeSampler(null, 5);
  assert.equal(uniform(0.99), 4);
  assert.equal(uniform(0), 0);
});

test("levels 1-3 keep colors in range and add structure", async () => {
  const { LEVELS, colorShares, makeSampler, smudgedGrid, fieldsGrid } = await import("../public/js/core.js");
  assert.deepEqual(LEVELS.map((l) => l.level), [0, 1, 2, 3]);
  const m = makeModel(fixture({ size: 16, works: 4, K: 5 }));
  const rand = mulberry32(9);
  const sameNeighbors = (g) => {
    let same = 0;
    for (let y = 0; y < 16; y++) for (let x = 1; x < 16; x++) same += g[y * 16 + x] === g[y * 16 + x - 1];
    return same / (16 * 15);
  };
  const agg = { 0: 0, 1: 0, 2: 0 };
  const counts1 = new Array(5).fill(0);
  for (let t = 0; t < 300; t++) {
    for (const level of [0, 1, 2]) {
      const g = generate(level, new Uint8Array(m.cells), m, rand);
      assert.ok(g.every((v) => v < m.K), `level ${level} in range`);
      agg[level] += sameNeighbors(g) / 300;
      if (level === 1) g.forEach((v) => counts1[v]++);
    }
  }
  close(agg[0], 1 / 5, 0.02); // independent pixels: neighbors agree 1 time in K
  assert.ok(agg[1] > 0.5, `smudged neighbors agree ${agg[1]}`);
  assert.ok(agg[2] > 0.6, `color fields agree ${agg[2]}`);
  // Smudging keeps every color equally likely on its own.
  counts1.forEach((c) => close(c / (300 * 256), 1 / 5, 0.02));
  // Level 3 only uses the borrowed palette's colors.
  const q = colorShares(m, 1);
  const draw = makeSampler(q, m.K);
  for (let t = 0; t < 50; t++) {
    const g = generate(3, new Uint8Array(m.cells), m, rand, draw);
    assert.ok(g.every((v) => q[v] > 0));
  }
  assert.ok(fieldsGrid(new Uint8Array(16), 4, draw, rand).every((v) => q[v] > 0));
  assert.ok(smudgedGrid(new Uint8Array(16), 4, draw, rand).every((v) => q[v] > 0));
});

test("the mutation monkey never gets worse and copies its target", async () => {
  const { subModel, mutateGeneration, makeSampler } = await import("../public/js/core.js");
  const m = makeModel(fixture({ size: 8, works: 3, K: 4 }));
  const t = subModel(m, 2);
  assert.equal(t.N, 1);
  assert.deepEqual([...t.grids], [...m.grids.slice(2 * 64, 3 * 64)]);
  const rand = mulberry32(4);
  const sample = makeSampler(null, m.K);
  const parent = generate(0, new Uint8Array(m.cells), m, rand);
  const child = new Uint8Array(m.cells);
  const bestChild = new Uint8Array(m.cells);
  let score = scoreAgainst(t, parent, 0);
  let generations = 0;
  while (score > 0 && generations < 5000) {
    const s = mutateGeneration(t, parent, 50, 1, sample, rand, child, bestChild);
    generations++;
    if (s <= score) {
      parent.set(bestChild);
      assert.ok(s <= score);
      score = s;
    }
  }
  assert.equal(score, 0, "reached an exact copy");
  assert.equal(exactMatch(t, parent, 0), 1);
  assert.ok(generations < 2000, `took ${generations} generations`);
});
