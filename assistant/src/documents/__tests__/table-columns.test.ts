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
  columnGroups,
  columnNeed,
  type ColumnText,
  fitFontSize,
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

/** The ten-column table Word was still breaking numbers in, at 11pt. */
const WIDE: ColumnText[] = [
  {
    header: "Workstream",
    cells: ["Discovery and stakeholder alignment", "Build", "Cutover"],
  },
  { header: "Owner", cells: ["R. Vance", "K. Osei", "M. Duarte"] },
  { header: "Start", cells: ["2026-01-05", "2026-02-16", "2026-07-01"] },
  { header: "End", cells: ["2026-02-13", "2026-06-30", "2026-07-31"] },
  { header: "Effort (days)", cells: ["120", "480", "60"] },
  { header: "Rate", cells: ["$1,450.00", "$1,250.00", "$1,600.00"] },
  { header: "Budget", cells: ["$174000", "$600000", "$96000"] },
  { header: "Spent", cells: ["$166750", "$412500", "$0"] },
  { header: "Remaining", cells: ["$7250", "$187500", "$96000"] },
  { header: "Status", cells: ["On track", "At risk", "Not started"] },
];

describe("fitFontSize", () => {
  test("leaves a table that already fits at the size it was given", () => {
    expect(fitFontSize(REVENUE, CONTENT_WIDTH, OPTS)).toBe(FONT_PT);
    expect(fitFontSize([], CONTENT_WIDTH, OPTS)).toBe(FONT_PT);
  });

  test("sets a table smaller rather than breaking its numbers", () => {
    // Opening the export in Word showed the real defect: at 11pt these ten
    // columns cannot all hold their values, so apportionment scaled the floors
    // down and Word laid out `$1,450.00` as `$1,450.0` above `0`. The page
    // cannot grow, so the type has to shrink.
    const pt = fitFontSize(WIDE, CONTENT_WIDTH, OPTS);
    expect(pt).toBeLessThan(FONT_PT);
    expect(pt).toBeGreaterThan(6);

    // At the fitted size every floor is payable, so no column is starved.
    const scale = pt / FONT_PT;
    const padding = Math.round(PADDING * scale);
    const widths = apportionColumns(WIDE, CONTENT_WIDTH, {
      fontPt: pt,
      unitsPerPt: 20,
      padding,
    });
    const charWidth = pt * 0.56 * 20;
    WIDE.forEach((column, i) => {
      const longest = Math.max(
        longestToken(column.header),
        ...column.cells.map(longestToken),
      );
      expect(widths[i]! - padding).toBeGreaterThanOrEqual(longest * charWidth);
    });
  });

  test("does not shrink the whole table to chase one URL", () => {
    // A 300-character token is going to wrap whatever we do, and letting it
    // set the type size would make the readable columns unreadable too.
    const withUrl: ColumnText[] = [
      { header: "Link", cells: ["https://" + "a".repeat(300)] },
      { header: "Note", cells: ["short"] },
    ];
    expect(fitFontSize(withUrl, CONTENT_WIDTH, OPTS)).toBe(FONT_PT);
  });

  test("never goes below the readable floor", () => {
    const absurd: ColumnText[] = Array.from({ length: 40 }, (_, i) => ({
      header: `column${i}`,
      cells: ["1234567890123456"],
    }));
    expect(fitFontSize(absurd, CONTENT_WIDTH, OPTS)).toBe(6);
  });
});

describe("columnGroups", () => {
  /** A slide's content column, in inches, at the deck's 12pt table type. */
  const SLIDE = 8.9;
  const SLIDE_OPTS = { fontPt: 12, unitsPerPt: 1 / 72, padding: 10 / 72 };

  test("leaves a table that fits as one group, so narrow tables are untouched", () => {
    expect(columnGroups(REVENUE, SLIDE, SLIDE_OPTS)).toEqual([[0, 1, 2, 3, 4]]);
    expect(columnGroups([], SLIDE, SLIDE_OPTS)).toEqual([]);
  });

  test("cuts a ten-column table into groups that each fit the slide", () => {
    const groups = columnGroups(WIDE, SLIDE, SLIDE_OPTS);
    expect(groups.length).toBeGreaterThan(1);

    for (const group of groups) {
      const width = group.reduce(
        (sum, i) => sum + columnNeed(WIDE[i]!, SLIDE_OPTS),
        0,
      );
      expect(width).toBeLessThanOrEqual(SLIDE);
    }
  });

  test("repeats the first column on every group and loses no other one", () => {
    const groups = columnGroups(WIDE, SLIDE, SLIDE_OPTS);
    // Without the key column a continuation is a block of figures with nothing
    // to say which row is which — the same failure as a missing header row.
    for (const group of groups) expect(group[0]).toBe(0);

    const seen = new Set(groups.flat());
    expect([...seen].sort((a, b) => a - b)).toEqual(WIDE.map((_, i) => i));
  });

  test("evens the groups out rather than leaving an orphan last slide", () => {
    const groups = columnGroups(WIDE, SLIDE, SLIDE_OPTS);
    const sizes = groups.map((g) => g.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test("cannot be made to claim more than a sixth of the slide for the key", () => {
    // The reason repeating the first column is affordable at all: whatever is
    // in it, `columnNeed` caps what it may ask for. A prose key column asks for
    // the same width as a sixteen-character one.
    const prose = {
      header: "Summary",
      cells: ["antidisestablishmentarianism-and-then-some-more-besides"],
    };
    expect(columnNeed(prose, SLIDE_OPTS)).toBeLessThan(SLIDE / 5);
  });

  test("never separates a two-column table — a lone column is not a table", () => {
    const pair: ColumnText[] = [
      { header: "Clause", cells: ["Assignment"] },
      { header: "Position", cells: ["x".repeat(400)] },
    ];
    expect(columnGroups(pair, SLIDE, SLIDE_OPTS)).toEqual([[0, 1]]);
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
