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

/**
 * A color sampler: draws palette indices with probabilities `q` (uniform
 * if omitted). Returned as a function of a uniform random number.
 */
export function makeSampler(q, K) {
  if (!q) return (r) => (r * K) | 0;
  const cum = new Float64Array(K);
  let total = 0;
  for (let c = 0; c < K; c++) {
    total += q[c];
    cum[c] = total;
  }
  return (r) => {
    const x = r * total;
    for (let c = 0; c < K - 1; c++) if (x < cum[c]) return c;
    return K - 1;
  };
}

/** Share of each palette color in work `w`. */
export function colorShares(model, w) {
  const q = new Float64Array(model.K);
  const off = w * model.cells;
  for (let i = 0; i < model.cells; i++) q[model.grids[off + i]]++;
  for (let c = 0; c < model.K; c++) q[c] /= model.cells;
  return q;
}

/** Average color shares over the whole collection. */
export function collectionShares(model) {
  const q = new Float64Array(model.K);
  for (let i = 0; i < model.grids.length; i++) q[model.grids[i]]++;
  for (let c = 0; c < model.K; c++) q[c] /= model.grids.length;
  return q;
}

/**
 * Level 1: smudged. Pixels are painted in reading order; each one copies
 * its left or upper neighbor with probability `keep`, otherwise it gets a
 * fresh color. Every pixel is still uniformly distributed on its own, but
 * neighbors agree, so the grid forms blobs.
 */
export function smudgedGrid(out, size, sample, rand, keep = 0.8) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = rand();
      if (r < keep && (x > 0 || y > 0)) {
        const fromLeft = y === 0 || (x > 0 && rand() < 0.5);
        out[i] = fromLeft ? out[i - 1] : out[i - size];
      } else {
        out[i] = sample(rand());
      }
    }
  }
  return out;
}

/**
 * Level 2: color fields. A ground color, then 2-6 rectangles of random
 * size, position and color laid on top, like a sketch for a Rothko or a
 * Mondrian.
 */
export function fieldsGrid(out, size, sample, rand) {
  out.fill(sample(rand()));
  const n = 2 + ((rand() * 5) | 0);
  for (let k = 0; k < n; k++) {
    const w = 1 + ((rand() * size) | 0);
    const h = 1 + ((rand() * size) | 0);
    const x0 = (rand() * (size - w + 1)) | 0;
    const y0 = (rand() * (size - h + 1)) | 0;
    const c = sample(rand());
    for (let y = y0; y < y0 + h; y++) out.fill(c, y * size + x0, y * size + x0 + w);
  }
  return out;
}

export const LEVELS = [
  {
    level: 0,
    name: "Uniform noise",
    blurb: "Every pixel is an independent, uniformly random palette color.",
  },
  {
    level: 1,
    name: "Smudged",
    blurb: "Each pixel usually copies a neighbor, so colors form blobs. Every color is still equally likely.",
  },
  {
    level: 2,
    name: "Color fields",
    blurb: "A ground color with a few random rectangles on top, like a sketch for a Rothko or a Mondrian.",
  },
  {
    level: 3,
    name: "Borrowed palette",
    blurb: "Color fields painted with a real painting's colors, in its proportions (the target's, or a random painting's).",
  },
];

/**
 * Fills `out` with a new grid from the monkey at `level`. `sample` draws a
 * palette index from a uniform random number (see makeSampler).
 */
export function generate(level, out, model, rand, sample) {
  const draw = sample || ((r) => (r * model.K) | 0);
  switch (level) {
    case 1:
      return smudgedGrid(out, model.size, draw, rand);
    case 2:
    case 3:
      return fieldsGrid(out, model.size, draw, rand);
    default:
      return sample ? fillFrom(out, draw, rand) : uniformGrid(out, model.K, rand);
  }
}

function fillFrom(out, draw, rand) {
  for (let i = 0; i < out.length; i++) out[i] = draw(rand());
  return out;
}

/** A model holding only painting `w` (for a chosen target). */
export function subModel(model, w) {
  return { ...model, N: 1, grids: model.grids.slice(w * model.cells, (w + 1) * model.cells) };
}

// ---------------------------------------------------------------------------
// The mutation monkey (Dawkins's weasel)
// ---------------------------------------------------------------------------

/**
 * One generation of cumulative selection. Makes `brood` children of
 * `parent`, each with about `rate` pixels changed (at least one), scores
 * them against the single painting in `target` (a one-painting model), and
 * returns the best child and its score. The caller keeps whichever of
 * parent and child is better, so the score never gets worse.
 */
export function mutateGeneration(target, parent, brood, rate, sample, rand, child, bestOut) {
  const cells = target.cells;
  let bestSum = Infinity;
  for (let b = 0; b < brood; b++) {
    child.set(parent);
    let changed = false;
    for (let i = 0; i < cells; i++) {
      if (rand() < rate / cells) {
        child[i] = sample(rand());
        changed = true;
      }
    }
    if (!changed) child[(rand() * cells) | 0] = sample(rand());
    const s = scoreAgainst(target, child, 0);
    if (s < bestSum) {
      bestSum = s;
      bestOut.set(child);
    }
  }
  return bestSum;
}
