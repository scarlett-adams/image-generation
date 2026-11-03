// Renders the statistics section from the worker's tallies (`s`) and the
// theory it sent (`th`). Three views share the same building blocks:
//  - pure chance against the whole collection
//  - pure chance against one target painting
//  - the mutation monkey (with pure chance as the comparison)

import {
  drawBestOfN,
  drawHistogram,
  formatCount,
  formatValue,
  histogramWindow,
  predictedAt,
  stepAt,
} from "./charts.js";
import { exactOdds, log10BinomialTail } from "./stats.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const COLORS = { pairs: "var(--series-pairs)", match: "var(--series-match)", ink: "var(--muted)" };

const view = { histWin: null, histKey: "", tablesAt: 0, lastRate: 0 };

export function resetStatsView() {
  view.histWin = null;
  view.histKey = "";
}

export function forceTables() {
  view.tablesAt = 0;
}

function legend(listId, items) {
  const ul = $(listId);
  const key = items.map((i) => `${i.label}|${i.color}|${i.dashed}|${i.wash}`).join(";");
  if (ul.dataset.key === key) return;
  ul.dataset.key = key;
  ul.replaceChildren(
    ...items.map((i) => {
      const li = document.createElement("li");
      const k = document.createElement("span");
      k.className = `chart-key${i.dashed ? " dashed" : ""}${i.wash ? " wash" : ""}`;
      k.style.setProperty("--key", i.color);
      const label = document.createElement("span");
      label.textContent = i.label;
      li.append(k, label);
      return li;
    }),
  );
}

function table(containerId, head, rows) {
  const t = document.createElement("table");
  t.className = "data-table";
  const thead = t.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    thead.append(th);
  }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r) tr.insertCell().textContent = c;
  }
  $(containerId).replaceChildren(t);
}

function tablesDue() {
  return performance.now() - view.tablesAt > 500;
}

function plusMinus(m, rank) {
  if (!m || !Number.isFinite(m.mean)) return "—";
  return rank === "surprise"
    ? `${formatValue(m.mean, rank, 2)} ± ${m.sd.toFixed(2)}σ`
    : `${pct(m.mean)} ± ${(m.sd * 100).toFixed(1)}`;
}

/** "10" with a superscript exponent, plus words for screen readers. */
function power(exp) {
  const n = Math.round(exp);
  const span = document.createElement("span");
  span.className = "power";
  const visual = document.createElement("span");
  visual.setAttribute("aria-hidden", "true");
  const sup = document.createElement("sup");
  sup.textContent = String(n);
  visual.append("10", sup);
  const spoken = document.createElement("span");
  spoken.className = "sr-only";
  spoken.textContent = `10 to the power of ${n}`;
  span.append(visual, spoken);
  return span;
}

function sentence(parts) {
  const p = document.createElement("p");
  p.append(...parts);
  return p;
}

// ---------------------------------------------------------------------------
// Pure chance
// ---------------------------------------------------------------------------

function renderHistogram(s, th, ctx) {
  const rank = s.rank;
  const single = th.N === 1;
  const has = s.monkeys > 0;
  const many = `its best match of ${nf.format(th.N)}`;
  const series = [
    { label: single ? "Monkey vs. the target" : "One monkey vs. one painting", color: COLORS.pairs, values: has ? s.pairsHist : null },
    { label: `One monkey vs. ${many}`, color: COLORS.match, values: has && !single ? s.matchHist : null },
    { label: ctx.exactModel ? "Predicted" : "Predicted for independent pixels", color: COLORS.pairs, values: th.pairs, dashed: true },
    { label: "Predicted best match, if independent", color: COLORS.match, values: single ? null : th.match, dashed: true },
  ];
  legend("hist-legend", [
    { label: single ? "vs. the target" : "vs. one painting", color: COLORS.pairs, wash: true },
    ...(single ? [] : [{ label: `vs. ${many}`, color: COLORS.match, wash: true }]),
    { label: ctx.exactModel ? "predicted by theory" : "predicted for independent pixels", color: COLORS.ink, dashed: true },
  ]);
  $("hist-sub").textContent =
    rank === "surprise"
      ? "Share of results at each surprise score (σ above that painting's average against noise)"
      : "Share of results at each similarity";
  const key = `${rank}|${th.N}|${ctx.level}`;
  if (key !== view.histKey) {
    view.histWin = null;
    view.histKey = key;
  }
  view.histWin = histogramWindow(
    th.scale,
    [th.pairs, single ? null : th.match],
    [has ? s.pairsHist : null, has && !single ? s.matchHist : null],
    view.histWin,
  );
  const rows = drawHistogram($("hist-chart"), { scale: th.scale, rank, win: view.histWin, series });
  if ($("hist-details").open && tablesDue()) {
    table(
      "hist-table",
      single ? ["Score", "vs. target", "Predicted"] : ["Score", "One painting", "Predicted", "Best match", "Predicted"],
      rows.map((r) => {
        const shares = single ? [r.shares[0], r.shares[2]] : r.shares;
        return [`${formatValue(r.from, rank, 2)} to ${formatValue(r.to, rank, 2)}`, ...shares.map((v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—"))];
      }),
    );
  }
}

function renderCompare(s, th, ctx) {
  const rank = s.rank;
  const N = th.N;
  const single = N === 1;
  const unit = rank === "surprise" ? "Surprise" : "Similarity";
  const theoryCell = (v, star = "") => (ctx.exactModel ? `${v}${star}` : `${v}†`);
  const rows = single
    ? [
        ["Similarity to the target", theoryCell(plusMinus(th.pairStats, rank)), plusMinus(s.pair, rank)],
        ["Exact pixels", theoryCell(pct(th.exact)), Number.isFinite(s.pairExact) ? pct(s.pairExact) : "—"],
      ]
    : [
        [`${unit}, one painting`, theoryCell(plusMinus(th.pairStats, rank)), plusMinus(s.pair, rank)],
        [`${unit}, best of ${nf.format(N)} paintings`, theoryCell(plusMinus(th.matchStats, rank), "*"), plusMinus(s.match, rank)],
        ["Exact pixels, one painting", theoryCell(pct(th.exact)), Number.isFinite(s.pairExact) ? pct(s.pairExact) : "—"],
        ["Exact pixels, best match", "—", Number.isFinite(s.matchExact) ? pct(s.matchExact) : "—"],
        ["Independent comparisons per monkey", ctx.exactModel ? `${nf.format(N)}*` : "—", s.effectiveN ? `≈ ${nf.format(Math.round(s.effectiveN))}` : "—"],
      ];
  $("compare-body").replaceChildren(
    ...rows.map(([label, theory, observed]) => {
      const tr = document.createElement("tr");
      const h = document.createElement("th");
      h.scope = "row";
      h.textContent = label;
      const a = document.createElement("td");
      a.textContent = theory;
      const b = document.createElement("td");
      b.textContent = observed;
      tr.append(h, a, b);
      return tr;
    }),
  );
  const parts = [];
  if (s.monkeys) {
    parts.push(
      single
        ? `Observed over ${nf.format(s.monkeys)} monkeys, each compared with the target only.`
        : `Observed over ${nf.format(s.monkeys)} monkeys × ${nf.format(N)} paintings = ${formatCount(s.comparisons)} comparisons.`,
    );
  }
  if (!ctx.exactModel) {
    parts.push("† What independent pixels with the same colors would do. This monkey's pixels aren't independent, so the observed spread is wider.");
  }
  if (!single && ctx.exactModel) {
    parts.push(
      `* If a monkey's ${nf.format(N)} comparisons were independent. They aren't: the same grid is scored against every painting, so its scores rise and fall together, and the real best match is lower.`,
    );
    if (s.effectiveN) parts.push(`The ${nf.format(N)} comparisons are worth about ${nf.format(Math.round(s.effectiveN))} independent ones.`);
  }
  $("compare-note").textContent = parts.join(" ");
}

function renderBestOfNChance(s, th) {
  const rank = s.rank;
  const single = th.N === 1;
  const monkeys = s.monkeys;
  const nMax = Math.max(1000, 10 ** Math.ceil(Math.log10(Math.max(1, monkeys))));
  const extend = (pts) => (pts.length && monkeys > pts[pts.length - 1][0] ? [...pts, [monkeys, pts[pts.length - 1][1]]] : pts);
  const curve = th.bestOfN || [];
  const bestLabel = single ? "Best match to the target" : `Best match among all ${nf.format(th.N)}`;
  const lines = [{ label: bestLabel, color: COLORS.match, points: extend(s.bestCurve), step: true }];
  if (!single) lines.push({ label: "A typical painting's own best match", color: COLORS.pairs, points: extend(s.typicalCurve) });
  lines.push({ label: "Predicted best match, if independent", color: COLORS.match, dashed: true, points: curve.map((p) => [p.n, p.best]), valueAt: (n) => predictedAt(curve, "best", n) });
  if (!single) {
    lines.push({ label: "Predicted, typical painting", color: COLORS.pairs, dashed: true, points: curve.map((p) => [p.n, p.typical]), valueAt: (n) => predictedAt(curve, "typical", n) });
  }
  legend("bon-legend", [
    { label: single ? "best match to the target" : `best match among all ${nf.format(th.N)}`, color: COLORS.match },
    ...(single ? [] : [{ label: "a typical painting's own best match", color: COLORS.pairs }]),
    { label: "predicted by theory", color: COLORS.ink, dashed: true },
  ]);
  $("bon-title").textContent = "Best of N: diminishing returns";
  $("bon-sub").textContent = "Best score so far against the number of monkeys (log scale)";
  drawBestOfN($("bon-chart"), { rank, nMax, monkeys, lines });

  const decades = [];
  for (let n = 10; n <= monkeys; n *= 10) decades.push(n);
  const shown = decades.slice(-4);
  let note;
  if (shown.length >= 2) {
    const parts = shown.map((n, i) => {
      const v = stepAt(s.bestCurve, n);
      if (i === 0) return `after ${formatCount(n)} monkeys: ${formatValue(v, rank)}`;
      const gain = v - stepAt(s.bestCurve, shown[i - 1]);
      const g = rank === "surprise" ? `${gain.toFixed(2)}σ` : `${(gain * 100).toFixed(1)} points`;
      return `${formatCount(n)}: ${formatValue(v, rank)} (+${g})`;
    });
    note = `Best match ${parts.join("; ")}. Each tenfold increase in monkeys buys less, because the best of n draws from a bell curve grows only like √(2 ln n).`;
  } else {
    note = "Each tenfold increase in monkeys raises the best match by less than the last. Run the monkey to see it.";
  }
  if (monkeys > 0) {
    const next = 10 ** Math.ceil(Math.log10(monkeys + 1));
    note += ` Theory says the best of ${formatCount(next)} independent tries would reach about ${formatValue(predictedAt(curve, "best", next), rank)}.`;
  }
  $("bon-note").textContent = note;

  if ($("bon-details").open && tablesDue()) {
    const rows = [];
    for (let n = 1; n <= nMax; n *= 10) {
      const row = [nf.format(n), n <= monkeys ? formatValue(stepAt(s.bestCurve, n), rank, 2) : "—", formatValue(predictedAt(curve, "best", n), rank, 2)];
      if (!single) row.push(n <= monkeys ? formatValue(stepAt(s.typicalCurve, n), rank, 2) : "—", formatValue(predictedAt(curve, "typical", n), rank, 2));
      rows.push(row);
    }
    table("bon-table", single ? ["Monkeys", "Best match", "Predicted"] : ["Monkeys", "Best match", "Predicted", "Typical painting", "Predicted"], rows);
  }
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

function figure(label, value) {
  const div = document.createElement("div");
  div.className = "figure";
  const v = document.createElement("p");
  v.className = "figure-value";
  v.textContent = value;
  const l = document.createElement("p");
  l.className = "figure-label";
  l.textContent = label;
  div.append(v, l);
  return div;
}

function renderMutation(s, th) {
  const right = Number.isFinite(s.exact) ? Math.round(s.exact * s.cells) : 0;
  $("mutation-figures").replaceChildren(
    figure("generations", nf.format(s.generations)),
    figure("grids tried", nf.format(s.monkeys)),
    figure("similar to the target", Number.isFinite(s.sim) ? pct(s.sim) : "—"),
    figure("pixels exactly right", `${right} of ${s.cells}`),
  );
  const curve = th.bestOfN || [];
  const text = $("mutation-text");
  text.replaceChildren();
  if (!s.monkeys) {
    text.append("Each generation makes 100 copies of the best grid so far with about one pixel changed, and keeps the closest. Press Start.");
  } else if (s.finished) {
    text.append(
      `An exact copy of the target after ${nf.format(s.monkeys)} grids (${nf.format(s.generations)} generations). For pure chance, each grid has a 1 in `,
      power(s.cells * Math.log10(s.K)),
      " chance of being that copy.",
    );
  } else {
    const tail = log10BinomialTail(s.cells, right, 1 / s.K);
    const chance = predictedAt(curve, "best", Math.max(1, s.monkeys));
    text.append(`A random grid gets at least ${right} of ${s.cells} pixels exactly right `);
    if (tail > -1) text.append(`${pct(10 ** tail, 0)} of the time.`);
    else text.append("about 1 time in ", power(-tail), ".");
    text.append(` After the same ${nf.format(s.monkeys)} grids, pure chance's best match would be about ${pct(chance)} similar; the mutation monkey is at ${pct(s.sim)}.`);
  }

  const monkeys = s.monkeys;
  const nMax = Math.max(1000, 10 ** Math.ceil(Math.log10(Math.max(1, monkeys))));
  const pts = s.curve.length && monkeys > s.curve[s.curve.length - 1][0] ? [...s.curve, [monkeys, s.curve[s.curve.length - 1][1]]] : s.curve;
  const lines = [
    { label: "Mutation monkey (cumulative selection)", color: COLORS.match, points: pts, step: true },
    { label: "Pure chance, predicted best", color: COLORS.pairs, dashed: true, points: curve.map((p) => [p.n, p.best]), valueAt: (n) => predictedAt(curve, "best", n) },
  ];
  legend("bon-legend", [
    { label: "mutation monkey: keeps the best of each generation", color: COLORS.match },
    { label: "pure chance: best of n random grids (predicted)", color: COLORS.pairs, dashed: true },
  ]);
  $("bon-title").textContent = "Cumulative selection vs. pure chance";
  $("bon-sub").textContent = "Similarity to the target against the number of grids tried (log scale)";
  // Pin the top of the axis at 100% so the climb reads against a copy.
  lines.push({ label: "", color: "transparent", points: [[1, 1]], dashed: true, hidden: true });
  drawBestOfN($("bon-chart"), { rank: "similarity", nMax, monkeys, lines });
  $("bon-note").textContent =
    "Pure chance creeps up like √(2 ln n). Keeping each small improvement compounds instead. That is Dawkins's point about cumulative selection, with the caveat that this monkey, unlike evolution, knows its target.";
  if ($("bon-details").open && tablesDue()) {
    const rows = [];
    for (let n = 1; n <= nMax; n *= 10) {
      rows.push([nf.format(n), n <= monkeys ? pct(stepAt(s.curve, n), 2) : "—", pct(predictedAt(curve, "best", n), 2)]);
    }
    table("bon-table", ["Grids tried", "Mutation monkey", "Pure chance (predicted)"], rows);
  }
}

// ---------------------------------------------------------------------------
// The odds of an exact copy
// ---------------------------------------------------------------------------

function formatWait(log10Years) {
  const seconds = 10 ** log10Years * 365.25 * 24 * 3600;
  if (seconds < 120) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 3.15e7 * 2) return `${Math.round(seconds / 86400)} days`;
  return `${nf.format(Math.round(seconds / 3.15e7))} years`;
}

function renderOdds(ctx, N, perSecond) {
  const { K, size } = ctx;
  const cells = size * size;
  const o = exactOdds(K, cells, N, perSecond);
  const key = [K, cells, N, perSecond ? Math.round(Math.log10(perSecond) * 10) : 0].join("|");
  const box = $("odds-text");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const which = N === 1 ? "the target" : `any of the ${nf.format(N)}`;
  const paras = [
    sentence([
      `${size === 8 ? "An" : "A"} ${size} × ${size} grid has ${cells} pixels, and each can be any of ${K} colors, so there are `,
      power(o.oneInLog10),
      " possible grids. The chance that one monkey paints one particular painting's grid exactly is 1 in ",
      power(o.oneInLog10),
      ...(N > 1 ? [", and 1 in about ", power(o.anyInLog10), ` that it copies ${which}`] : []),
      ". For scale, the observable universe has about ",
      power(80),
      " atoms.",
    ]),
  ];
  if (o.waitYearsLog10 != null) {
    const wait = o.waitYearsLog10;
    paras.push(
      sentence(
        wait > 10
          ? [`At ${nf.format(Math.round(perSecond))} grids a second, you would expect to wait about `, power(wait), ` years for an exact copy of ${which}. The universe is about 14 billion (1.4 × `, power(10), ") years old."]
          : [`At ${nf.format(Math.round(perSecond))} grids a second, you would expect an exact copy of ${which} within about ${formatWait(wait)}.`],
      ),
    );
  }
  const hits = o.universeHitsLog10;
  paras.push(
    sentence(
      hits < 0
        ? [`Even if every atom in the universe had been a monkey painting a billion grids a second since the Big Bang, the chance that any of them had copied ${N === 1 ? "the target" : "a painting"} yet would be about 1 in `, power(-hits), "."]
        : ["If every atom in the universe had been a monkey painting a billion grids a second since the Big Bang, they would have made about ", power(hits), ` exact copies by now${N === 1 ? "" : ": each painting about "}`, ...(N === 1 ? [] : [power(hits - Math.log10(N)), " times over"]), ". Small grids are a different universe."],
    ),
  );
  box.replaceChildren(...paras);
}

// ---------------------------------------------------------------------------

/**
 * ctx: {K, size, level, exactModel}. u: the worker's update message.
 */
export function renderStats(u, th, ctx) {
  const s = u.stats;
  if (!s || !th || th.mode !== s.mode) return;
  const mutation = s.mode === "mutation";
  if (!mutation && th.rank !== s.rank) return;
  $("chance-stats").hidden = mutation;
  $("mutation-stats").hidden = !mutation;
  $("rank-note").hidden = mutation || th.N === 1 || s.rank !== "surprise";
  const levelNote = $("level-note");
  levelNote.hidden = mutation || ctx.exactModel;
  if (!levelNote.hidden) {
    levelNote.textContent =
      ctx.level === 3
        ? "Level 3 borrows a real painting's colors, so its average similarity rises. Its pixels still aren't independent, so the dashed curves (independent pixels with the same colors) underestimate the spread, and the spread is what lifts the best match."
        : `Level ${ctx.level} paints shapes, not independent pixels. Every color is still equally likely in each cell, so the average similarity stays where theory puts it, but neighboring cells move together, so the spread of scores widens, and the best match comes from that wider tail.`;
  }
  if (mutation) {
    renderMutation(s, th);
  } else {
    renderHistogram(s, th, ctx);
    renderCompare(s, th, ctx);
    renderBestOfNChance(s, th);
  }
  if (u.running && u.perSecond > 0) view.lastRate = u.perSecond;
  renderOdds(ctx, th.N, u.running ? u.perSecond : view.lastRate);
  if (tablesDue()) view.tablesAt = performance.now();
}
