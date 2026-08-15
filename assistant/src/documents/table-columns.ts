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
 * that have width to spare. When the floors cannot all be paid the table stays
 * within its total and the shortfall is shared — an impossible ask must never
 * produce a table wider than the page.
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
