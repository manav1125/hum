/**
 * Column apportionment is the difference between a table that reads and one
 * that lies. Word and PowerPoint both lay out a fixed grid exactly as written,
 * so a numeric column that is one character too narrow does not overflow
 * visibly — it wraps, and `1250000` becomes `12500` above `00`. These tests
 * pin the floor that stops that, and the invariant that pays for it: whatever
 * the floors demand, the columns still add up to the width they were given.
 */

import { describe, expect, test } from "bun:test";

import {
  apportionColumns,
  type ColumnText,
  longestToken,
  roundToTotal,
} from "../table-columns.js";

/** A4 at 1" margins, in twips — what the Word exporter passes. */
const CONTENT_WIDTH = 9026;
/** 11pt text at the module's wide-character estimate, in twips. */
const FONT_PT = 11;
const CHAR_WIDTH = FONT_PT * 0.56 * 20;
const PADDING = 200;

const OPTS = { fontPt: FONT_PT, unitsPerPt: 20, padding: PADDING };

/** The table that exposed the defect: one prose column, three numeric ones. */
const REVENUE: ColumnText[] = [
  {
    header: "Region",
    cells: [
      "North America — the largest territory by headcount",
      "EMEA",
      "APAC",
      "LATAM",
    ],
  },
  { header: "Q1 Revenue", cells: ["1250000", "640000", "288000", "95000"] },
  { header: "Q2 Revenue", cells: ["1418750", "601600", "391680", "99750"] },
  { header: "Growth %", cells: ["13.5", "-6", "36", "5"] },
  {
    header: "Notes",
    cells: [
      "Strong enterprise renewals across the mid-market",
      "FX headwind",
      "Two new logos",
      "Flat",
    ],
  },
];

function fits(width: number, token: string): boolean {
  return width - PADDING >= token.length * CHAR_WIDTH;
}

describe("longestToken", () => {
  test("measures the longest unbreakable run, not the whole string", () => {
    expect(longestToken("North America — the largest territory")).toBe(9);
    expect(longestToken("1250000")).toBe(7);
    expect(longestToken("")).toBe(0);
  });
});

describe("apportionColumns", () => {
  test("gives a numeric column enough width to keep its number on one line", () => {
    const widths = apportionColumns(REVENUE, CONTENT_WIDTH, OPTS);

    // The regression: sized purely by text volume these came out around 835
    // twips, which cannot hold seven digits at 11pt.
    expect(fits(widths[1]!, "1250000")).toBe(true);
    expect(fits(widths[2]!, "1418750")).toBe(true);
  });

  test("still spends the whole width it was given", () => {
    const widths = apportionColumns(REVENUE, CONTENT_WIDTH, OPTS);
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(CONTENT_WIDTH, 6);
  });

  test("still gives the prose columns the most room", () => {
    const widths = apportionColumns(REVENUE, CONTENT_WIDTH, OPTS);
    expect(widths[0]!).toBeGreaterThan(widths[1]!);
    expect(widths[4]!).toBeGreaterThan(widths[3]!);
  });

  test("keeps the table inside its width when no floor can be paid", () => {
    // Every column wants far more than a fifth of the page.
    const impossible: ColumnText[] = Array.from({ length: 5 }, (_, i) => ({
      header: `col${i}`,
      cells: ["x".repeat(80)],
    }));
    const widths = apportionColumns(impossible, CONTENT_WIDTH, OPTS);

    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(CONTENT_WIDTH, 6);
    for (const w of widths) expect(w).toBeGreaterThan(0);
  });

  test("does not let one monster token starve the other columns", () => {
    const withUrl: ColumnText[] = [
      { header: "Link", cells: ["https://" + "a".repeat(300)] },
      { header: "Note", cells: ["short"] },
      { header: "Note2", cells: ["short"] },
    ];
    const widths = apportionColumns(withUrl, CONTENT_WIDTH, OPTS);

    // A 308-character token cannot be made to fit, and asking for its full
    // width would leave the other two columns as hairlines. The floor is
    // capped at 1.5x an even share, so they keep enough to hold their own
    // content and the total is unchanged.
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(CONTENT_WIDTH, 6);
    expect(fits(widths[1]!, "short")).toBe(true);
    expect(fits(widths[2]!, "short")).toBe(true);
  });

  test("handles a table with no columns", () => {
    expect(apportionColumns([], CONTENT_WIDTH, OPTS)).toEqual([]);
  });
});

describe("roundToTotal", () => {
  test("rounds to whole units without losing or inventing width", () => {
    const widths = apportionColumns(REVENUE, CONTENT_WIDTH, OPTS);
    const rounded = roundToTotal(widths, CONTENT_WIDTH);

    expect(rounded.reduce((a, b) => a + b, 0)).toBe(CONTENT_WIDTH);
    for (const w of rounded) expect(Number.isInteger(w)).toBe(true);
  });
});
