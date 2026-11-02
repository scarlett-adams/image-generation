// Pure functions shared by the page, the Web Worker and the tests.
// No DOM access here.

/** "#a1b2c3" -> [161, 178, 195] */
export function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB (0-255) -> CIE Lab (D65). Same formulas as scripts/build_grids.py. */
export function srgbToLab([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Checks a grids.json payload and turns it into flat typed arrays for fast
 * scoring. Throws an Error with a readable message if the data is malformed.
 */
export function makeModel(data) {
  if (!data || !Array.isArray(data.palette) || !Array.isArray(data.works)) {
    throw new Error("grids file is missing its palette or works");
  }
  const K = data.palette.length;
  const size = data.size;
  if (K < 2 || K > 255) throw new Error(`unexpected palette size ${K}`);
  if (!Number.isInteger(size) || size < 2) throw new Error(`unexpected grid size ${size}`);
  const cells = size * size;
  const lab =
    Array.isArray(data.paletteLab) && data.paletteLab.length === K
      ? data.paletteLab
      : data.palette.map((h) => srgbToLab(hexToRgb(h)));

  // D[a * K + b] = Lab distance between palette colors a and b.
  const D = new Float64Array(K * K);
  let maxDist = 0;
  for (let a = 0; a < K; a++) {
    for (let b = 0; b < K; b++) {
      const d = labDistance(lab[a], lab[b]);
      D[a * K + b] = d;
      if (d > maxDist) maxDist = d;
    }
  }

  const works = data.works.filter((w) => Array.isArray(w.grid) && w.grid.length === cells);
  if (works.length === 0) throw new Error("grids file has no usable works");
  const N = works.length;
  const grids = new Uint8Array(N * cells);
  works.forEach((w, i) => {
    for (let j = 0; j < cells; j++) {
      const v = w.grid[j];
      grids[i * cells + j] = v >= 0 && v < K ? v : 0;
    }
  });

  return { K, size, cells, N, D, maxDist, grids, palette: data.palette, lab };
}

/** Similarity from the sum of per-pixel Lab distances. 1 = identical. */
export function similarityFromSum(model, sum) {
  return 1 - sum / (model.cells * model.maxDist);
}

/**
 * Scores `grid` against every artwork. Writes the summed Lab distance for
 * each work into `sums` (Float64Array of length N) and returns the index of
 * the closest work.
 */
export function scoreAgainstAll(model, grid, sums, rowScratch) {
  const { N, cells, K, D, grids } = model;
  const rows = rowScratch || new Int32Array(cells);
  for (let i = 0; i < cells; i++) rows[i] = grid[i] * K;
  let best = 0;
  let bestSum = Infinity;
  for (let w = 0, off = 0; w < N; w++, off += cells) {
    let s = 0;
    for (let i = 0; i < cells; i++) s += D[rows[i] + grids[off + i]];
    sums[w] = s;
    if (s < bestSum) {
      bestSum = s;
      best = w;
    }
  }
  return best;
}

/** Summed Lab distance between `grid` and one work. */
export function scoreAgainst(model, grid, w) {
  const { cells, K, D, grids } = model;
  const off = w * cells;
  let s = 0;
  for (let i = 0; i < cells; i++) s += D[grid[i] * K + grids[off + i]];
  return s;
}

/** Fraction of cells where `grid` has exactly the same color as work `w`. */
export function exactMatch(model, grid, w) {
  const { cells, grids } = model;
  const off = w * cells;
  let same = 0;
  for (let i = 0; i < cells; i++) if (grid[i] === grids[off + i]) same++;
  return same / cells;
}

export function workGrid(model, w) {
  return model.grids.subarray(w * model.cells, (w + 1) * model.cells);
}

/** Small, fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Monkeys
// ---------------------------------------------------------------------------

/** Level 0: every pixel independently uniform over the palette. */
export function uniformGrid(out, K, rand) {
  for (let i = 0; i < out.length; i++) out[i] = (rand() * K) | 0;
  return out;
}

export const LEVELS = [
  {
    level: 0,
    name: "Uniform noise",
    blurb: "Every pixel is an independent, uniformly random palette color.",
  },
];

/** Fills `out` with a new grid from the monkey at `level`. */
export function generate(level, out, model, rand) {
  switch (level) {
    default:
      return uniformGrid(out, model.K, rand);
  }
}
