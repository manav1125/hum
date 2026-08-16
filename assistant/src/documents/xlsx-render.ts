/**
 * Markdown tables → Excel (.xlsx) rendering.
 *
 * A proposal's pricing table is the part the client actually works with — they
 * change a quantity, re-run the total, send it back. That only works if the
 * cells arrive as *numbers*, so the coercion below is the substance of this
 * module: `$1,200.00` becomes `1200` carrying a currency format, `35%` becomes
 * `0.35` carrying a percent format, and anything ambiguous stays text rather
 * than being guessed into a wrong figure.
 */

import ExcelJS from "exceljs";
import type { Token, Tokens } from "marked";
import { marked } from "marked";

/** Excel's own limit — sheet names are 31 chars and may not contain []:*?/\ */
const MAX_SHEET_NAME = 31;

/** Column width bounds, in Excel's "characters of the default font" unit. */
const MIN_COLUMN_WIDTH = 10;
const MAX_COLUMN_WIDTH = 60;

/** Breathing room either side of the widest value in a column. */
const COLUMN_PADDING = 3;

/**
 * Excel stores a number as a float64 and shows at most 15 significant digits.
 * Anything longer is an identifier — an account or invoice number — and turning
 * it into a number would round away the digits that identify it.
 */
const MAX_SIGNIFICANT_DIGITS = 15;

export interface ExtractedTable {
  /** The nearest preceding heading, used to name the sheet. */
  heading?: string;
  header: string[];
  align: (string | null)[];
  rows: string[][];
}

/**
 * Pull every markdown table out of a document, in order, each tagged with the
 * heading it sits under.
 */
export function extractTables(markdown: string): ExtractedTable[] {
  const tokens = marked.lexer(markdown, { gfm: true });
  const out: ExtractedTable[] = [];
  let heading: string | undefined;

  const walk = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "heading") {
        const h = token as Tokens.Heading;
        heading = (
          h.tokens?.length ? flattenInline(h.tokens) : decode(h.text)
        ).trim();
      } else if (token.type === "table") {
        const t = token as Tokens.Table;
        out.push({
          heading,
          header: t.header.map(cellText),
          align: t.align ?? [],
          rows: t.rows.map((row) => row.map(cellText)),
        });
      } else if (token.type === "blockquote") {
        walk((token as Tokens.Blockquote).tokens);
      } else if (token.type === "list") {
        for (const item of (token as Tokens.List).items) walk(item.tokens);
      }
    }
  };
  walk(tokens);
  return out;
}

/**
 * Read a cell as a value rather than as markdown source.
 *
 * This walks the tokens marked already produced instead of stripping `*_\`~`
 * out of the raw text, because those characters are only markup when marked
 * says they are. Deleting them blindly rewrites the data: `SKU_ALPHA_01`
 * arrives as `SKUALPHA01`, and — worse, because it survives into a *number* —
 * `~5000` becomes `5000` and `5*3` becomes `53`. An approximation is not an
 * exact figure, and a hyphenated ratio is not a two-digit quantity.
 */
function cellText(cell: Tokens.TableCell): string {
  const text = cell.tokens?.length
    ? flattenInline(cell.tokens)
    : decode(cell.text);
  return text.trim();
}

function flattenInline(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        out += t.tokens?.length ? flattenInline(t.tokens) : decode(t.text);
        break;
      }
      case "strong":
      case "em":
      case "del":
        out += flattenInline(
          (token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens ?? [],
        );
        break;
      case "codespan":
        out += decode((token as Tokens.Codespan).text);
        break;
      case "link": {
        const link = token as Tokens.Link;
        // The label is the value; the href belongs to a document, not a cell.
        out += link.tokens?.length
          ? flattenInline(link.tokens)
          : decode(link.text);
        break;
      }
      case "image":
        out += decode((token as Tokens.Image).text ?? "");
        break;
      case "br":
        out += " ";
        break;
      case "escape":
        out += (token as Tokens.Escape).text;
        break;
      case "html": {
        const raw = (token as Tokens.HTML).raw;
        out += /^<br\s*\/?>$/i.test(raw.trim())
          ? " "
          : decode(raw.replace(/<[^>]+>/g, ""));
        break;
      }
      default: {
        const t = token as { text?: string; raw?: string };
        out += decode(t.text ?? t.raw ?? "");
      }
    }
  }
  return out;
}

/** marked leaves HTML entities escaped in token text; a cell wants characters. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export interface CoercedCell {
  /** `null` is a genuinely blank cell — `""` is a text cell that looks blank. */
  value: string | number | null;
  numFmt?: string;
}

/**
 * Turn a markdown cell into a typed Excel value.
 *
 * Deliberately conservative: a string only becomes a number when the whole
 * cell is one, after removing a currency symbol, thousands separators and a
 * trailing percent. `2-3 weeks` stays text; so does `N/A` and `TBD`.
 *
 * The refusals matter as much as the conversions. A leading zero means the
 * cell is an identifier — a SKU, a cost centre, a postcode — and `007` stored
 * as `7` has lost the characters that identify it. A run of more than fifteen
 * digits is past what a float64 can hold exactly, so an account number would
 * come back rounded. Both stay text.
 */
export function coerceCell(raw: string): CoercedCell {
  const text = raw.trim();
  if (!text) return { value: null };

  // Accounting parentheses wrap the whole value — symbol, digits and any
  // trailing percent — so they come off before anything else is read. Reading
  // them last is how `(20%)` used to land as -20 instead of -0.2.
  const parenthesised = /^\(.*\)$/.test(text);
  const inner = parenthesised ? text.slice(1, -1).trim() : text;

  const percent = /%$/.test(inner);
  const currency = /^-?\s*[$£€¥₹]/.test(inner);

  const cleaned = inner
    .replace(/[$£€¥₹]/g, "")
    .replace(/[,\s]/g, "")
    .replace(/%$/, "");

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { value: text };

  const digits = cleaned.replace(/^-/, "");
  if (/^0\d/.test(digits)) return { value: text }; // identifier, not a quantity
  if (digits.replace(".", "").length > MAX_SIGNIFICANT_DIGITS)
    return { value: text };

  let n = Number(cleaned);
  if (!Number.isFinite(n)) return { value: text };
  if (parenthesised) n = -n;

  if (percent) return { value: n / 100, numFmt: "0.0%" };

  // Keep the source's own precision: `$480` is money and gets cents, but a
  // count written `12,500` should not gain a `.00` it never had.
  const decimals = digits.includes(".") ? 2 : 0;
  if (currency) {
    const symbol = inner.match(/[$£€¥₹]/)?.[0] ?? "$";
    return { value: n, numFmt: `"${symbol}"#,##0.00` };
  }
  if (/[.,]/.test(inner) && Math.abs(n) >= 1000)
    return { value: n, numFmt: decimals ? "#,##0.00" : "#,##0" };
  return { value: n };
}

/**
 * What Excel will actually draw in the cell.
 *
 * Column width has to be measured against this, not against the markdown that
 * produced it. `$120000` is seven characters of source and eleven of rendered
 * `$120,000.00`, and a numeric cell that does not fit its column is not
 * truncated politely — Excel replaces the number with `####`.
 */
export function displayText(cell: CoercedCell): string {
  const { value, numFmt } = cell;
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (!numFmt) return String(value);
  if (numFmt.endsWith("%")) return `${grouped(value * 100, 1)}%`;
  const symbol = /^"(.)"/.exec(numFmt)?.[1] ?? "";
  const decimals = numFmt.includes(".00") ? 2 : 0;
  const body = grouped(Math.abs(value), decimals);
  return `${value < 0 ? "-" : ""}${symbol}${body}`;
}

function grouped(n: number, decimals: number): string {
  const [whole = "0", fraction] = Math.abs(n).toFixed(decimals).split(".");
  const sign = n < 0 ? "-" : "";
  const separated = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${separated}${fraction ? `.${fraction}` : ""}`;
}

function sheetName(
  table: ExtractedTable,
  index: number,
  taken: Set<string>,
): string {
  const base =
    (table.heading || table.header[0] || `Table ${index + 1}`)
      .replace(/[[\]:*?/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SHEET_NAME) || `Table ${index + 1}`;

  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Build a workbook with one sheet per markdown table. Throws when the content
 * has no tables — an empty workbook is a worse answer than a clear refusal.
 */
export async function renderMarkdownTablesToXlsx(
  markdown: string,
  opts: { title?: string } = {},
): Promise<{ bytes: Buffer; sheets: string[]; tableCount: number }> {
  const tables = extractTables(markdown);
  if (tables.length === 0) {
    throw new Error(
      "No tables found. XLSX export writes one sheet per markdown table — add a table, or export another format.",
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Cue";
  workbook.created = new Date();
  if (opts.title) workbook.title = opts.title;

  const taken = new Set<string>();
  const sheets: string[] = [];

  for (const [index, table] of tables.entries()) {
    const name = sheetName(table, index, taken);
    sheets.push(name);
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.addRow(table.header);
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FF1A2230" } };
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEEF1F7" },
    };
    header.border = {
      bottom: { style: "thin", color: { argb: "FFD9DEE8" } },
    };

    const body = table.rows.map((row) => row.map(coerceCell));
    for (const cells of body) {
      const added = sheet.addRow(cells.map((c) => c.value));
      cells.forEach((cell, i) => {
        if (cell.numFmt) added.getCell(i + 1).numFmt = cell.numFmt;
      });
    }

    // Width is measured against what Excel will draw — the formatted value —
    // and alignment is applied per cell so the header keeps its own.
    table.header.forEach((head, i) => {
      const shown = body.map((row) => displayText(row[i] ?? { value: null }));
      const widest = Math.max(head.length, ...shown.map((s) => s.length));
      const natural = widest + COLUMN_PADDING;
      sheet.getColumn(i + 1).width = Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, natural),
      );

      // A column too wide for the cap holds prose, and prose that runs under
      // the next column is prose the reader never sees: Excel clips a text
      // cell the moment its neighbour is occupied. Wrapping is the only way
      // the whole value stays on screen.
      const wraps = natural > MAX_COLUMN_WIDTH;

      const align = table.align[i];
      const horizontal: Partial<ExcelJS.Alignment> =
        align === "right"
          ? { horizontal: "right" }
          : align === "center"
            ? { horizontal: "center" }
            : {};

      header.getCell(i + 1).alignment = { vertical: "middle", ...horizontal };
      body.forEach((row, r) => {
        const cell = sheet.getRow(2 + r).getCell(i + 1);
        const isText = typeof row[i]?.value === "string";
        cell.alignment = {
          ...horizontal,
          ...(wraps && isText ? { wrapText: true, vertical: "top" } : {}),
        };
      });
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    bytes: Buffer.from(buffer as ArrayBuffer),
    sheets,
    tableCount: tables.length,
  };
}
