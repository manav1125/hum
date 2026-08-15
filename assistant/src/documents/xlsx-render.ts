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
        heading = plain((token as Tokens.Heading).text);
      } else if (token.type === "table") {
        const t = token as Tokens.Table;
        out.push({
          heading,
          header: t.header.map((c) => plain(c.text)),
          align: t.align ?? [],
          rows: t.rows.map((row) => row.map((c) => plain(c.text))),
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

/** Strip inline markdown so a cell reads as a value, not as source. */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface CoercedCell {
  value: string | number;
  numFmt?: string;
}

/**
 * Turn a markdown cell into a typed Excel value.
 *
 * Deliberately conservative: a string only becomes a number when the whole
 * cell is one, after removing a currency symbol, thousands separators and a
 * trailing percent. `2-3 weeks` stays text; so does `N/A` and `TBD`.
 */
export function coerceCell(raw: string): CoercedCell {
  const text = raw.trim();
  if (!text) return { value: "" };

  const percent = /^-?[\d.,]+\s*%$/.test(text);
  const currency = /^[-(]?\s*[$£€¥₹]/.test(text);
  const parenthesised = /^\(.*\)$/.test(text);

  const cleaned = text
    .replace(/[$£€¥₹]/g, "")
    .replace(/[(),\s]/g, "")
    .replace(/%$/, "");

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { value: text };

  let n = Number(cleaned);
  if (!Number.isFinite(n)) return { value: text };
  if (parenthesised) n = -n; // accounting negatives

  if (percent) return { value: n / 100, numFmt: "0.0%" };
  if (currency) {
    const symbol = text.match(/[$£€¥₹]/)?.[0] ?? "$";
    return { value: n, numFmt: `"${symbol}"#,##0.00` };
  }
  if (/[.,]/.test(text) && Math.abs(n) >= 1000)
    return { value: n, numFmt: "#,##0.00" };
  return { value: n };
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
    header.alignment = { vertical: "middle" };

    for (const row of table.rows) {
      const cells = row.map((cell) => coerceCell(cell));
      const added = sheet.addRow(cells.map((c) => c.value));
      cells.forEach((cell, i) => {
        if (cell.numFmt) added.getCell(i + 1).numFmt = cell.numFmt;
      });
    }

    // Column widths from the widest rendered value, and alignment from the
    // markdown's own column alignment.
    table.header.forEach((head, i) => {
      const column = sheet.getColumn(i + 1);
      const widest = Math.max(
        head.length,
        ...table.rows.map((r) => (r[i] ?? "").length),
      );
      column.width = Math.min(60, Math.max(10, widest + 3));
      const align = table.align[i];
      if (align === "right" || align === "center") {
        column.alignment = { horizontal: align };
      }
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    bytes: Buffer.from(buffer as ArrayBuffer),
    sheets,
    tableCount: tables.length,
  };
}
