import assert from "node:assert/strict";
import { test } from "node:test";
import { centuryCounts, describeColor, parseDated } from "../public/js/findings.js";

test("palette colors get plain names and families", () => {
  const cases = [
    [[14.8, 2.7, 4.2], "near-black", "neutral"],
    [[27.4, 6.5, 14.9], "dark brown", "earth"],
    [[44.1, 0.2, 11.2], "taupe", "earth"],
    [[62.6, 5.5, 15.4], "tan", "earth"],
    [[80.1, 1.1, 7.2], "beige", "earth"],
    [[44.6, 7.6, 27.7], "brown", "earth"],
    [[31.1, 4.2, -2.0], "charcoal", "neutral"],
    [[58.6, -3.3, -3.1], "blue-gray", "neutral"],
    [[65.4, 0.9, 36.1], "ochre", "earth"],
    [[43.1, 30.5, 24.5], "brick red", "red"],
    [[50, -20, -40], "blue", "blue"],
    [[50, -40, 20], "green", "green"],
    [[95, 0, 1], "off-white", "neutral"],
  ];
  for (const [lab, name, family] of cases) {
    const d = describeColor(lab);
    assert.equal(d.name, name, JSON.stringify(lab));
    assert.equal(d.family, family, JSON.stringify(lab));
  }
  assert.equal(describeColor([58.6, -3.3, -3.1]).cool, true);
  assert.equal(describeColor([62.6, 5.5, 15.4]).cool, false);
});

test("museum dates parse to rough years", () => {
  assert.deepEqual(parseDated("1919"), { year: 1919, span: false });
  assert.deepEqual(parseDated("c. 1735-1745"), { year: 1735, span: false });
  assert.deepEqual(parseDated("c. 1873-c. 1874"), { year: 1873, span: false });
  assert.deepEqual(parseDated("17th century"), { year: 1650, span: false });
  assert.deepEqual(parseDated("19th-20th century"), { year: 1850, span: true });
  assert.deepEqual(parseDated("1916 - 1921"), { year: 1916, span: false });
  assert.deepEqual(parseDated("1780-1860"), { year: 1780, span: true });
  assert.equal(parseDated(""), null);
  assert.equal(parseDated(null), null);
  assert.equal(parseDated("undated"), null);
});

test("century counts", () => {
  const works = ["1510", "1650", "c. 1655", "17th century", "1899", "19th-20th century", null, "1350"].map((dated) => ({ dated }));
  const { rows, span, unknown } = centuryCounts(works);
  assert.deepEqual(rows, [["before 1400", 1], ["1500s", 1], ["1600s", 3], ["1800s", 1]]);
  assert.equal(span, 1);
  assert.equal(unknown, 1);
});
