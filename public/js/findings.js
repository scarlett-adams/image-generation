// The Findings section: the global palette (named and grouped), which
// paintings survived the legibility filter, and when they were painted.
// The pure helpers at the top are tested in test/findings.test.js.

import { hexToRgb, srgbToLab } from "./core.js";

const nf = new Intl.NumberFormat("en-US");
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

/**
 * A plain-language name and family for a Lab color. Families: "earth"
 * (browns, tans, ochres), "neutral" (blacks, grays, off-whites), "red",
 * "green", "blue", "violet".
 */
export function describeColor([L, a, b]) {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  if (C < 6) {
    const cool = C >= 3 && h >= 150 && h < 330;
    if (L < 20) return { name: "near-black", family: "neutral", cool };
    if (L < 40) return { name: cool ? "slate" : "charcoal", family: "neutral", cool };
    if (L < 60) return { name: cool ? "blue-gray" : "gray", family: "neutral", cool };
    if (L < 78) return { name: cool ? "pale blue-gray" : "light gray", family: "neutral", cool };
    return { name: "off-white", family: "neutral", cool };
  }
  if ((h < 20 || h >= 330) || (h < 45 && C >= 30)) {
    return { name: L < 50 ? "brick red" : "rose", family: "red", cool: false };
  }
  if (h < 110) {
    if (L < 35) return { name: "dark brown", family: "earth", cool: false };
    if (L < 55) return { name: C < 15 ? "taupe" : "brown", family: "earth", cool: false };
    if (L < 72) return { name: C >= 30 ? "ochre" : "tan", family: "earth", cool: false };
    return { name: C >= 30 ? "straw" : "beige", family: "earth", cool: false };
  }
  if (h < 180) return { name: C < 15 ? "olive gray" : "green", family: "green", cool: true };
  if (h < 300) return { name: C < 15 ? "slate blue" : "blue", family: "blue", cool: true };
  return { name: "plum", family: "violet", cool: false };
}

/** Rough year from a museum date string ("c. 1650-1653", "17th century"),
 * or null. Returns {year, span} where span means "crosses centuries". */
export function parseDated(dated) {
  if (!dated) return null;
  const s = String(dated).toLowerCase();
  const bce = /\b(bce|b\.c\.)/.test(s);
  const cent = s.match(/(\d{1,2})(?:st|nd|rd|th)\s*(?:[-–]\s*(\d{1,2})(?:st|nd|rd|th)\s*)?centur/);
  if (cent) {
    const first = Number(cent[1]);
    const second = cent[2] ? Number(cent[2]) : null;
    const year = (first - 1) * 100 + 50;
    return { year: bce ? -year : year, span: second != null && second !== first };
  }
  const years = [...s.matchAll(/\b(\d{3,4})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return null;
  const year = years[0];
  const last = years.length > 1 && years[1] > year ? years[1] : year;
  return { year: bce ? -year : year, span: Math.floor(year / 100) !== Math.floor(last / 100) && last - year > 30 };
}

/** Counts works per century (by start date); ranges that cross centuries
 * by more than a few decades are counted separately. */
export function centuryCounts(works) {
  const buckets = new Map();
  let span = 0;
  let unknown = 0;
  for (const w of works) {
    const d = parseDated(w.dated);
    if (!d) unknown++;
    else if (d.span) span++;
    else {
      const c = d.year < 1400 ? "before 1400" : `${Math.floor(d.year / 100) * 100}s`;
      buckets.set(c, (buckets.get(c) || 0) + 1);
    }
  }
  const order = (k) => (k === "before 1400" ? 0 : Number(k.slice(0, 4)));
  const rows = [...buckets.entries()].sort((x, y) => order(x[0]) - order(y[0]));
  return { rows, span, unknown };
}

const EAST_ASIAN = /^(chinese|japanese|korean)/i;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function renderPalette(data) {
  const labs = data.paletteLab || data.palette.map((h) => srgbToLab(hexToRgb(h)));
  const shares = data.paletteShare || data.palette.map(() => 1 / data.palette.length);
  const colors = data.palette.map((hex, i) => ({ hex, share: shares[i], lab: labs[i], ...describeColor(labs[i]) }));

  document.getElementById("swatches").replaceChildren(
    ...colors.map((c) => {
      const li = el("li", { class: "swatch" });
      const chip = el("span", { class: "swatch-chip", "aria-hidden": "true" });
      chip.style.background = c.hex;
      const name = el("span", { class: "swatch-name" }, c.name);
      const meta = el("span", { class: "swatch-meta" }, `${c.hex} · ${pct(c.share, 1)}`);
      li.append(chip, name, meta);
      return li;
    }),
  );

  const sum = (f) => colors.filter(f).reduce((t, c) => t + c.share, 0);
  const earth = sum((c) => c.family === "earth");
  const neutral = sum((c) => c.family === "neutral");
  const cool = colors.filter((c) => c.cool).sort((x, y) => y.share - x.share);
  const vivid = [...colors].sort((x, y) => Math.hypot(y.lab[1], y.lab[2]) - Math.hypot(x.lab[1], x.lab[2]))[0];
  const hasBlueOrGreen = colors.some((c) => (c.family === "blue" || c.family === "green") && Math.hypot(c.lab[1], c.lab[2]) >= 10);
  const parts = [
    `Browns, tans and ochres cover ${pct(earth)} of all the pixels in the collection, and blacks, grays and off-whites another ${pct(neutral)}.`,
  ];
  if (cool.length) {
    parts.push(`The only cool color${cool.length > 1 ? "s are" : " is"} ${cool.map((c) => `a ${c.name} (${pct(c.share)})`).join(" and ")}.`);
  } else {
    parts.push("There is not a single cool color.");
  }
  parts.push(`The most saturated is a ${vivid.name} (${pct(vivid.share)}).`);
  if (!hasBlueOrGreen) {
    parts.push(
      "There is no true blue or green: averaged into big cells, skies, sea and foliage melt into the surrounding browns and grays. Old varnish, which yellows and darkens with age, and aged paper and silk warm things further. To a monkey, the museum is brown.",
    );
  }
  document.getElementById("palette-text").textContent = parts.join(" ");
}

function renderSelection(data) {
  const sel = data.selection;
  const text = document.getElementById("selection-text");
  const table = document.getElementById("selection-table");
  if (!sel) {
    text.textContent = "This data was built without the legibility filter, so every painting with an image is included.";
    table.replaceChildren();
    return;
  }
  const rows = sel.cultures || [];
  const ea = rows.filter((r) => EAST_ASIAN.test(r.culture));
  const eaPool = ea.reduce((t, r) => t + r.pool, 0);
  const eaKept = ea.reduce((t, r) => t + r.kept, 0);
  const top = [...rows].filter((r) => r.culture !== "Other" && r.culture !== "Unknown").sort((a, b) => b.kept - a.kept)[0];
  const parts = [
    `Of the ${nf.format(sel.pool)} paintings with images, ${nf.format(sel.legible)} (${pct(sel.legible / sel.pool)}) are still legible at ${data.size} × ${data.size}: no color covers more than half the grid, at least ${sel.rules.minColors} colors appear, light and dark vary, and the shape is within ${sel.rules.maxAspect}:1. The first ${nf.format(sel.kept)} of those, in random order, are the monkey's museum.`,
  ];
  if (eaPool) {
    parts.push(
      `Chinese, Japanese and Korean paintings were ${pct(eaPool / sel.pool)} of the paintings with images but are ${pct(eaKept / sel.kept)} of the collection here. Ink on silk or paper leaves much of the picture as open ground, and in those traditions the empty space is part of the composition, but a pixel grid reads it as one flat color with nothing to match.`,
    );
  }
  if (top) {
    parts.push(`${top.culture} paintings went from ${pct(top.pool / sel.pool)} of the pool to ${pct(top.kept / sel.kept)} of the collection.`);
  }
  text.textContent = parts.join(" ");

  const t = el("table", { class: "data-table" });
  const head = t.createTHead().insertRow();
  for (const h of ["Culture", "With images", "Legible", "Kept"]) head.append(el("th", { scope: "col" }, h));
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    tr.append(el("th", { scope: "row" }, r.culture));
    for (const v of [r.pool, r.legible, r.kept]) tr.insertCell().textContent = nf.format(v);
  }
  table.replaceChildren(t);
}

function renderEras(data) {
  const { rows, span, unknown } = centuryCounts(data.works);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const t = el("table", { class: "data-table era-table" });
  const head = t.createTHead().insertRow();
  for (const h of ["Century", "Paintings", ""]) head.append(el("th", { scope: "col" }, h));
  const body = t.createTBody();
  for (const [century, n] of rows) {
    const tr = body.insertRow();
    tr.append(el("th", { scope: "row" }, century));
    tr.insertCell().textContent = nf.format(n);
    const barCell = tr.insertCell();
    barCell.className = "era-bar-cell";
    const bar = el("span", { class: "era-bar", "aria-hidden": "true" });
    bar.style.width = `${(n / max) * 100}%`;
    barCell.append(bar);
  }
  document.getElementById("era-table").replaceChildren(t);
  const notes = ["Grouped by the start of the museum's date for each painting."];
  if (span) notes.push(`${nf.format(span)} more are dated across two centuries (often “19th–20th century”).`);
  if (unknown) notes.push(`${nf.format(unknown)} have no usable date.`);
  document.getElementById("era-text").textContent = notes.join(" ");
}

export function renderFindings(data) {
  renderPalette(data);
  renderSelection(data);
  renderEras(data);
}
