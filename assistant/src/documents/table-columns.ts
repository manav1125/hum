/**
 * Table column apportionment, shared by the Word and PowerPoint exporters.
 *
 * Sizing a column by how much text it carries reads well for prose and badly
 * for data. "Q1 Revenue" weighs 10 characters against a 40-character prose
 * column, so it wins about a sixth of the page — and the cell it has to hold
 * is `1250000`, which does not fit. Word does the only thing it can with a
 * fixed grid and breaks the number across two lines, so the reader sees
 * `12500` above `00`.
 *
 * A wrapped sentence is fine. A wrapped number is a different number. So
 * proportional sizing is kept, but every column also gets a floor: enough
 * width for its longest unbreakable run of characters, funded by the columns
 * that have width to spare.
 *
 * When the floors cannot all be paid out of the page, sharing the shortfall
 * only spreads the damage — every numeric column ends up a little too narrow,
 * which is the same broken number in more places. There are two things that
 * can give, and the page is not one of them, so `fitFontSize` shrinks the
 * type until the floors fit and apportionment runs at that size. Only past the
 * point where the table would stop being readable does wrapping win.
 *
 * A slide has a third thing that can give, and it is the one Word does not:
 * there can be more than one of it. Shrinking type on a slide buys almost
 * nothing — a deck's table is already near the floor at which a person can read
 * it from a chair — so `columnGroups` cuts a too-wide table into groups of
 * columns instead, one per slide. See there.
 *
 * Units are the caller's: twips for Word, inches for PowerPoint. Every number
 * in and out is in the same unit, so this module never needs to know which.
 */

/** Weight bounds, in characters: one prose column must not starve the rest. */
const WEIGHT_MIN = 6;
const WEIGHT_MAX = 40;

/**
 * How much of the table one column's floor may claim, as a multiple of an even
 * share. Without a cap, a single long token (a URL, a hash) would set the
 * whole layout.
 */
const FLOOR_CAP = 1.5;

/**
 * The longest token that gets a vote in choosing the table's font size.
 *
 * Every value a reader would notice being cut in half — a date, a currency
 * figure, an eight-digit total — is shorter than this. Beyond it lies the
 * long tail of URLs and hashes, and letting one of those drag the whole table
 * down to six points would be a worse answer than letting it wrap.
 */
const SIZING_TOKEN_CAP = 16;

/** Below this the table is unreadable, so wrapping becomes the lesser evil. */
const MIN_FONT_PT = 6;

export interface ColumnText {
  /** The header cell's plain text. */
  header: string;
  /** Every body cell's plain text, in row order. */
  cells: string[];
}

/**
 * Width of a wide character as a fraction of the font size.
 *
 * Deliberately not the *average* advance (~0.45 em of prose in Calibri and
 * Arial) — this sets a floor, so it has to be an upper bound for the
 * characters that matter. Digits are the widest thing a numeric column holds:
 * Calibri's are 0.497 em and Arial's 0.556 em. Erring low costs a number
 * broken in half; erring high costs a little whitespace.
 */
const WIDE_CHAR_ADVANCE = 0.56;

export interface ApportionOptions {
  /** Size of the table's text, in points. */
  fontPt: number;
  /** Caller's units per point — 20 for Word's twips, 1/72 for inches. */
  unitsPerPt: number;
  /** Non-text width a cell always spends — left plus right padding. */
  padding: number;
}

/** The longest run of non-space characters — the part that cannot be wrapped. */
export function longestToken(text: string): number {
  let longest = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length > longest) longest = token.length;
  }
  return longest;
}

function longestLine(column: ColumnText): number {
  let longest = column.header.length;
  for (const cell of column.cells) {
    if (cell.length > longest) longest = cell.length;
  }
  return longest;
}

function widestToken(column: ColumnText): number {
  let longest = longestToken(column.header);
  for (const cell of column.cells) {
    const token = longestToken(cell);
    if (token > longest) longest = token;
  }
  return longest;
}

/**
 * The largest font size, at or below `fontPt`, at which every column can still
 * hold its longest unbreakable token on one line.
 *
 * Apportionment alone cannot save a table whose columns need more width than
 * the page has. Scaling the floors down to fit is what produces `$1,450.0`
 * above `0` — the table obeys the page and lies about the number. A human
 * given the same page and the same ten columns does the obvious thing instead:
 * makes the table's type smaller. So does this.
 *
 * Padding shrinks with the type, because it is spacing rather than content;
 * at ten columns the margins alone were claiming a fifth of the page.
 */
export function fitFontSize(
  columns: ColumnText[],
  total: number,
  { fontPt, unitsPerPt, padding }: ApportionOptions,
): number {
  if (columns.length === 0) return fontPt;

  const tokens = columns.reduce(
    (sum, column) => sum + Math.min(widestToken(column), SIZING_TOKEN_CAP),
    0,
  );

  // Width needed is linear in the font size — text and padding both scale — so
  // the largest size that fits is a division, not a search.
  const perPt =
    tokens * WIDE_CHAR_ADVANCE * unitsPerPt +
    (columns.length * padding) / fontPt;
  if (perPt <= 0) return fontPt;

  const fits = total / perPt;
  if (fits >= fontPt) return fontPt;
  return Math.max(MIN_FONT_PT, Math.floor(fits * 10) / 10);
}

/**
 * Split `total` across the columns, proportional to the text they carry but
 * never below what each needs to keep its longest token on one line.
 *
 * The returned widths always sum to `total` (up to floating-point error);
 * callers that need integers round afterwards.
 */
export function apportionColumns(
  columns: ColumnText[],
  total: number,
  { fontPt, unitsPerPt, padding }: ApportionOptions,
): number[] {
  const count = columns.length;
  if (count === 0) return [];

  const charWidth = fontPt * WIDE_CHAR_ADVANCE * unitsPerPt;

  const weights = columns.map((column) =>
    Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, longestLine(column))),
  );
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (total * w) / weightTotal);

  const evenShare = total / count;
  const floors = columns.map((column) =>
    Math.min(widestToken(column) * charWidth + padding, evenShare * FLOOR_CAP),
  );
  // Floors that cannot all be paid are scaled together rather than paid in
  // column order, so the table never outgrows the page and no column is
  // singled out to absorb the whole shortfall.
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  const scale = floorTotal > total ? total / floorTotal : 1;
  const needs = floors.map((f) => f * scale);

  let deficit = 0;
  for (let i = 0; i < count; i++) {
    const need = needs[i] ?? 0;
    if ((widths[i] ?? 0) < need) {
      deficit += need - (widths[i] ?? 0);
      widths[i] = need;
    }
  }

  if (deficit > 0) {
    let spare = 0;
    for (let i = 0; i < count; i++) {
      spare += Math.max(0, (widths[i] ?? 0) - (needs[i] ?? 0));
    }
    if (spare > 0) {
      const take = Math.min(deficit, spare);
      for (let i = 0; i < count; i++) {
        const columnSpare = Math.max(0, (widths[i] ?? 0) - (needs[i] ?? 0));
        if (columnSpare > 0) {
          widths[i] = (widths[i] ?? 0) - (take * columnSpare) / spare;
        }
      }
    }
  }

  return widths;
}

/**
 * The width one column needs before anything of its has to wrap mid-token.
 *
 * The same two clamps `fitFontSize` uses apply, and for the same reasons: a
 * column narrower than {@link WEIGHT_MIN} characters is not a column, and a
 * lone 300-character URL does not get to set the layout because it will wrap
 * whatever anyone does about it.
 */
export function columnNeed(
  column: ColumnText,
  { fontPt, unitsPerPt, padding }: ApportionOptions,
): number {
  const chars = Math.max(
    WEIGHT_MIN,
    Math.min(widestToken(column), SIZING_TOKEN_CAP),
  );
  return chars * fontPt * WIDE_CHAR_ADVANCE * unitsPerPt + padding;
}

/**
 * Cut a table too wide for one canvas into groups of columns, one per canvas.
 *
 * The first column is repeated at the head of every group. A continuation that
 * drops it is a block of figures with nothing to say which row is which —
 * exactly the failure repeating the header row exists to prevent, one axis
 * over. Carrying it is affordable because {@link columnNeed} caps what any
 * column may ask for, so the key can never claim more than a sixth of a canvas
 * this is worth splitting.
 *
 * A table that already fits comes back as a single group holding every column,
 * so callers can run this unconditionally and narrow tables are untouched. Two
 * columns are never separated: a column beside nothing is not a table, and the
 * cap means a pair always fits anyway.
 *
 * Groups are then evened out rather than left as the greedy pass found them:
 * the same number of slides either way, and "four, four, one" ends on a slide
 * carrying a single column beside its key for no reason.
 */
export function columnGroups(
  columns: ColumnText[],
  total: number,
  options: ApportionOptions,
): number[][] {
  const count = columns.length;
  if (count === 0) return [];

  const needs = columns.map((column) => columnNeed(column, options));
  const all = needs.reduce((a, b) => a + b, 0);
  if (all <= total || count <= 2) return [columns.map((_, i) => i)];

  const keyNeed = needs[0] ?? 0;
  const rest = columns.map((_, i) => i).filter((i) => i !== 0);

  const greedy: number[][] = [];
  let group: number[] = [];
  let used = keyNeed;
  for (const i of rest) {
    const need = needs[i] ?? 0;
    if (group.length && used + need > total) {
      greedy.push(group);
      group = [];
      used = keyNeed;
    }
    group.push(i);
    used += need;
  }
  if (group.length) greedy.push(group);

  const per = Math.ceil(rest.length / greedy.length);
  const even: number[][] = [];
  for (let at = 0; at < rest.length; at += per)
    even.push(rest.slice(at, at + per));
  const evenFits = even.every(
    (g) =>
      g.length === 1 ||
      keyNeed + g.reduce((sum, i) => sum + (needs[i] ?? 0), 0) <= total,
  );

  const chosen = evenFits && even.length <= greedy.length ? even : greedy;
  return chosen.map((g) => [0, ...g]);
}

/**
 * Round apportioned widths to whole units, keeping the sum exactly `total`.
 *
 * Word's grid is integer twips, and a grid that does not add up to the table
 * width is the thing that makes a renderer start auto-fitting — which is
 * exactly what writing the grid was meant to prevent.
 */
export function roundToTotal(widths: number[], total: number): number[] {
  if (widths.length === 0) return [];
  const rounded = widths.map((w) => Math.max(1, Math.floor(w)));
  const remainder = total - rounded.reduce((a, b) => a + b, 0);
  const widest = rounded.indexOf(Math.max(...rounded));
  rounded[widest] = (rounded[widest] ?? 0) + remainder;
  return rounded;
}
