// Statistics for the monkey: normal-distribution helpers, the theory of
// similarity scores when pixels are independent, and running tallies.
// Pure functions, shared by the worker, the page and the tests.

// ---------------------------------------------------------------------------
// The normal distribution
// ---------------------------------------------------------------------------

/** Complementary error function, fractional error < 1.2e-7 everywhere
 * (Chebyshev fit, Numerical Recipes "erfcc"), so tails stay accurate. */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** P(Z <= z) for a standard normal Z. */
export const normCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);
/** P(Z > z), accurate far into the upper tail. */
export const normSf = (z) => 0.5 * erfc(z / Math.SQRT2);
export const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/** log P(Z <= z), accurate for P near 1 (where 1 - tiny matters). */
export function logNormCdf(z) {
  return z > 0 ? Math.log1p(-normSf(z)) : Math.log(normCdf(z));
}

/** Inverse of normCdf (Acklam's rational approximation, rel. error < 1.2e-9). */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Expected largest of n independent standard normals (Blom's approximation). */
export function expectedMaxOfNormals(n) {
  return n <= 1 ? 0 : normInv((n - 0.375) / (n + 0.25));
}

// ---------------------------------------------------------------------------
// Theory: similarity when every pixel is drawn independently
// ---------------------------------------------------------------------------

/**
 * For a monkey whose pixels are independent draws from color distribution
 * `q` (uniform for level 0), the similarity S to painting w is an average
 * of `cells` independent terms, so by the central limit theorem it is close
 * to Normal(mu[w], sd[w]):
 *
 *   m_a  = sum_c q_c D(c, a)               mean distance to a pixel of color a
 *   v_a  = sum_c q_c D(c, a)^2 - m_a^2     its variance
 *   mu_w = 1 - (sum_a f_wa m_a) / Dmax     f_wa = share of w's pixels with color a
 *   sd_w = sqrt(sum_a f_wa v_a / cells) / Dmax
 *
 * Also returns the expected exact-match share, sum_a f_wa q_a.
 */
export function iidTheory(model, q) {
  const { K, N, cells, D, grids, maxDist } = model;
  q = q || new Array(K).fill(1 / K);
  const m = new Float64Array(K);
  const v = new Float64Array(K);
  for (let a = 0; a < K; a++) {
    let s = 0;
    let s2 = 0;
    for (let c = 0; c < K; c++) {
      const d = D[c * K + a];
      s += q[c] * d;
      s2 += q[c] * d * d;
    }
    m[a] = s;
    v[a] = Math.max(0, s2 - s * s);
  }
  const mu = new Float64Array(N);
  const sd = new Float64Array(N);
  const exact = new Float64Array(N);
  const counts = new Float64Array(K);
  for (let w = 0; w < N; w++) {
    counts.fill(0);
    for (let i = 0, off = w * cells; i < cells; i++) counts[grids[off + i]]++;
    let em = 0;
    let ev = 0;
    let ex = 0;
    for (let a = 0; a < K; a++) {
      const f = counts[a] / cells;
      em += f * m[a];
      ev += f * v[a];
      ex += f * q[a];
    }
    mu[w] = 1 - em / maxDist;
    sd[w] = Math.sqrt(ev / cells) / maxDist;
    exact[w] = ex;
  }
  return { mu, sd, exact, q };
}

// ---------------------------------------------------------------------------
// Scores, bins and predicted distributions
// ---------------------------------------------------------------------------

/**
 * Two ways to rank paintings for a monkey's grid:
 *  - similarity: the raw score S (1 = identical)
 *  - surprise:   z = (S - mu_w) / sd_w, how unusual S is for that painting.
 *    Flat, mid-toned paintings score high against any noise; surprise
 *    corrects for that, and under the theory every z is standard normal.
 */
export const SCALES = {
  similarity: { lo: 0, hi: 1, n: 400 },
  surprise: { lo: -8, hi: 12, n: 400 },
};

export function binOf(value, scale) {
  const i = Math.floor(((value - scale.lo) / (scale.hi - scale.lo)) * scale.n);
  return i < 0 ? 0 : i >= scale.n ? scale.n - 1 : i;
}

export const binEdge = (i, scale) => scale.lo + ((scale.hi - scale.lo) * i) / scale.n;

function moments(probs, scale) {
  let total = 0;
  let mean = 0;
  for (let i = 0; i < scale.n; i++) {
    const x = (binEdge(i, scale) + binEdge(i + 1, scale)) / 2;
    total += probs[i];
    mean += probs[i] * x;
  }
  mean /= total || 1;
  let varSum = 0;
  for (let i = 0; i < scale.n; i++) {
    const x = (binEdge(i, scale) + binEdge(i + 1, scale)) / 2;
    varSum += probs[i] * (x - mean) ** 2;
  }
  return { mean, sd: Math.sqrt(varSum / (total || 1)) };
}

/**
 * Predicted distributions on the histogram bins, under the independent-pixel
 * theory `th`:
 *  - pairs: one monkey vs one random painting (a mix of N normals)
 *  - match: one monkey vs its best painting, *if* its N comparisons were
 *    independent: P(max <= x) = prod_w P(S_w <= x). They aren't quite (one
 *    grid is compared with every painting), which the page shows.
 * `logF` holds log P(max <= x) at every bin edge, for best-of-n predictions.
 */
export function predictedDistributions(th, rank, scale) {
  const N = th.mu.length;
  const edges = scale.n + 1;
  const pairsCdf = new Float64Array(edges);
  const logF = new Float64Array(edges);
  for (let e = 0; e < edges; e++) {
    const x = binEdge(e, scale);
    if (rank === "surprise") {
      pairsCdf[e] = normCdf(x);
      logF[e] = N * logNormCdf(x);
    } else {
      let cdf = 0;
      let lf = 0;
      for (let w = 0; w < N; w++) {
        const z = (x - th.mu[w]) / th.sd[w];
        cdf += normCdf(z);
        lf += logNormCdf(z);
      }
      pairsCdf[e] = cdf / N;
      logF[e] = lf;
    }
  }
  const pairs = new Float64Array(scale.n);
  const match = new Float64Array(scale.n);
  for (let i = 0; i < scale.n; i++) {
    pairs[i] = Math.max(0, pairsCdf[i + 1] - pairsCdf[i]);
    match[i] = Math.max(0, Math.exp(logF[i + 1]) - Math.exp(logF[i]));
  }
  let exact = 0;
  for (let w = 0; w < N; w++) exact += th.exact[w];
  return {
    pairs,
    match,
    logF,
    pairStats: moments(pairs, scale),
    matchStats: moments(match, scale),
    exact: exact / N,
  };
}

/** Value x where log P(max <= x) first reaches `target`, by interpolation. */
function quantileFromLogF(logF, scale, target) {
  for (let e = 1; e < logF.length; e++) {
    if (logF[e] >= target) {
      const a = logF[e - 1];
      const b = logF[e];
      const t = b > a && Number.isFinite(a) ? (target - a) / (b - a) : 1;
      return binEdge(e - 1, scale) + t * (binEdge(e, scale) - binEdge(e - 1, scale));
    }
  }
  return scale.hi;
}

/**
 * Predicted best-of-n curves for n in `ns`:
 *  - best: the median best match after n monkeys, if comparisons were
 *    independent: solve P(max <= x)^n = 1/2.
 *  - typical: the expected best score for one particular painting after n
 *    monkeys, averaged over paintings: mu_w + sd_w * E[max of n normals].
 */
export function predictedBestOfN(th, rank, scale, logF, ns) {
  const N = th.mu.length;
  let meanMu = 0;
  let meanSd = 0;
  for (let w = 0; w < N; w++) {
    meanMu += th.mu[w];
    meanSd += th.sd[w];
  }
  meanMu /= N;
  meanSd /= N;
  return ns.map((n) => {
    const e = expectedMaxOfNormals(n);
    return {
      n,
      best: quantileFromLogF(logF, scale, Math.log(0.5) / n),
      typical: rank === "surprise" ? e : meanMu + meanSd * e,
    };
  });
}

/**
 * How many independent comparisons the N real ones are worth: the n_eff for
 * which the best of n_eff independent comparisons has the observed mean.
 * Uses P(max <= x)^(n_eff / N).
 */
export function effectiveComparisons(logF, scale, observedMean, N) {
  const meanFor = (alpha) => {
    let mean = 0;
    let total = 0;
    let prev = Math.exp(alpha * logF[0]);
    for (let i = 0; i < scale.n; i++) {
      const cur = Math.exp(alpha * logF[i + 1]);
      const p = Math.max(0, cur - prev);
      mean += p * (binEdge(i, scale) + binEdge(i + 1, scale)) / 2;
      total += p;
      prev = cur;
    }
    return mean / (total || 1);
  };
  let lo = Math.log(1 / N / 4);
  let hi = Math.log(8);
  if (observedMean <= meanFor(Math.exp(lo))) return Math.exp(lo) * N;
  if (observedMean >= meanFor(Math.exp(hi))) return Math.exp(hi) * N;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    if (meanFor(Math.exp(mid)) < observedMean) lo = mid;
    else hi = mid;
  }
  return Math.exp((lo + hi) / 2) * N;
}

/** n = 1, 2, 3, 5, 10, 20, 30, 50, 100, ... up to `max`. */
export function logSteps(max) {
  const out = [];
  for (let p = 1; p <= max; p *= 10) for (const m of [1, 2, 3, 5]) if (m * p <= max) out.push(m * p);
  return out;
}

// ---------------------------------------------------------------------------
// Running tallies
// ---------------------------------------------------------------------------

export function makeTally(N, scale) {
  return {
    scale,
    monkeys: 0,
    pairsHist: new Float64Array(scale.n),
    matchHist: new Float64Array(scale.n),
    pairSum: 0,
    pairSq: 0,
    matchSum: 0,
    matchSq: 0,
    matchExactSum: 0,
    pairExactSum: 0,
    pairExactCount: 0,
    bestPer: new Float64Array(N).fill(-Infinity),
    bestCurve: [], // [n, best value] each time the best improves
    typicalCurve: [], // [n, mean over paintings of their best value]
    nextCheckpoint: 1,
  };
}

/**
 * Records one monkey's scores against every painting (`values`, one per
 * painting, in the active ranking's units). Returns the index of its match
 * (the highest value).
 */
export function recordMonkey(t, values) {
  const { scale, pairsHist, bestPer } = t;
  const n = values.length;
  const span = scale.n / (scale.hi - scale.lo);
  let best = 0;
  let bestV = -Infinity;
  let sum = 0;
  let sq = 0;
  for (let w = 0; w < n; w++) {
    const v = values[w];
    let i = Math.floor((v - scale.lo) * span);
    if (i < 0) i = 0;
    else if (i >= scale.n) i = scale.n - 1;
    pairsHist[i]++;
    sum += v;
    sq += v * v;
    if (v > bestPer[w]) bestPer[w] = v;
    if (v > bestV) {
      bestV = v;
      best = w;
    }
  }
  t.monkeys++;
  t.pairSum += sum;
  t.pairSq += sq;
  t.matchHist[binOf(bestV, scale)]++;
  t.matchSum += bestV;
  t.matchSq += bestV * bestV;
  const last = t.bestCurve[t.bestCurve.length - 1];
  if (!last || bestV > last[1]) t.bestCurve.push([t.monkeys, bestV]);
  if (t.monkeys >= t.nextCheckpoint) {
    let s = 0;
    for (let w = 0; w < n; w++) s += bestPer[w];
    t.typicalCurve.push([t.monkeys, s / n]);
    t.nextCheckpoint = Math.ceil(t.nextCheckpoint * 1.25);
  }
  return best;
}

/** Mean and standard deviation from running sums. */
export function meanSd(sum, sq, count) {
  if (!count) return { mean: NaN, sd: NaN };
  const mean = sum / count;
  return { mean, sd: Math.sqrt(Math.max(0, sq / count - mean * mean)) };
}

// ---------------------------------------------------------------------------
// The odds of an exact copy
// ---------------------------------------------------------------------------

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const AGE_OF_UNIVERSE_S = 13.8e9 * SECONDS_PER_YEAR;
const ATOMS_LOG10 = 80;

/**
 * log10 odds for exact copies: one grid matching one painting is 1 in
 * K^cells. Returns the numbers the page turns into sentences.
 */
export function exactOdds(K, cells, N, perSecond) {
  const oneInLog10 = cells * Math.log10(K); // 1 in 10^this
  const universeGrids = ATOMS_LOG10 + 9 + Math.log10(AGE_OF_UNIVERSE_S); // atoms x 1e9/s x age
  const rate = perSecond > 0 ? perSecond : null;
  return {
    oneInLog10,
    anyInLog10: oneInLog10 - Math.log10(N),
    // expected years until any exact copy at the current speed
    waitYearsLog10: rate ? oneInLog10 - Math.log10(rate * N) - Math.log10(SECONDS_PER_YEAR) : null,
    ageOfUniverseYearsLog10: Math.log10(13.8e9),
    // expected exact copies if every atom were a monkey painting 1e9 grids/s since the Big Bang
    universeHitsLog10: universeGrids + Math.log10(N) - oneInLog10,
  };
}
