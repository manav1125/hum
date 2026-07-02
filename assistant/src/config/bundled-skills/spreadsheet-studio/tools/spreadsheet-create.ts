/**
 * spreadsheet_create — build a real .xlsx workbook (live formulas, number
 * formats, frozen headers) and deliver it as an in-chat attachment.
 *
 * The formula convention: any cell string beginning with "=" is written as a
 * live Excel formula, so the delivered file recalculates when the user edits
 * an input — the difference between a financial model and a table of stale
 * numbers. `fullCalcOnLoad` makes Excel/Numbers/Sheets recompute on open.
 */

import ExcelJS from "exceljs";

import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const MAX_SHEETS = 20;
const MAX_ROWS = 10_000;
const MAX_COLS = 200;

type PlainCell = string | number | boolean | null;
/** Rich cell: value plus optional per-cell format/bold. The model produces
 * these naturally, so the tool accepts both forms. */
interface RichCell {
  value?: PlainCell;
  format?: string;
  bold?: boolean;
}
type CellValue = PlainCell | RichCell;

interface SheetInput {
  name: string;
  rows: CellValue[][];
  header?: boolean;
  column_widths?: number[];
  number_formats?: Record<string, string>;
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/\.xlsx$/i, "");
  const clean =
    base
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "spreadsheet";
  return `${clean}.xlsx`;
}

function parseSheets(raw: unknown): SheetInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "Provide a non-empty `sheets` array.";
  }
  if (raw.length > MAX_SHEETS) {
    return `Too many sheets (${raw.length}); maximum is ${MAX_SHEETS}.`;
  }
  const sheets: SheetInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown>;
    if (!s || typeof s.name !== "string" || !s.name.trim()) {
      return `Sheet ${i} is missing a string \`name\`.`;
    }
    if (!Array.isArray(s.rows)) {
      return `Sheet "${s.name}" is missing a \`rows\` array (array of row arrays).`;
    }
    if (s.rows.length > MAX_ROWS) {
      return `Sheet "${s.name}" has too many rows (${s.rows.length}; max ${MAX_ROWS}).`;
    }
    for (const row of s.rows) {
      if (!Array.isArray(row)) {
        return `Sheet "${s.name}": every entry in \`rows\` must itself be an array of cells.`;
      }
      if (row.length > MAX_COLS) {
        return `Sheet "${s.name}" has a row with ${row.length} columns (max ${MAX_COLS}).`;
      }
    }
    sheets.push({
      name: s.name.trim().slice(0, 31), // Excel's sheet-name limit
      rows: s.rows as CellValue[][],
      header: s.header !== false,
      column_widths: Array.isArray(s.column_widths)
        ? (s.column_widths as number[]).filter(
            (w) => typeof w === "number" && w > 0 && w <= 120,
          )
        : undefined,
      number_formats:
        s.number_formats && typeof s.number_formats === "object"
          ? (s.number_formats as Record<string, string>)
          : undefined,
    });
  }
  return sheets;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const filenameRaw =
    typeof input.filename === "string" && input.filename.trim()
      ? input.filename.trim()
      : "";
  if (!filenameRaw) {
    return {
      content: 'Provide a `filename` (e.g. "saas-model.xlsx").',
      isError: true,
    };
  }
  const parsed = parseSheets(input.sheets);
  if (typeof parsed === "string") {
    return { content: parsed, isError: true };
  }

  try {
    const { buffer, sheetSummaries, formulaCells } =
      await buildWorkbook(parsed);
    const filename = sanitizeFilename(filenameRaw);
    const attachment = uploadAttachmentFromBytes(
      filename,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      new Uint8Array(buffer),
    );

    return {
      content: JSON.stringify({
        message: "Spreadsheet created.",
        attachmentId: attachment.id,
        filename,
        sizeBytes: buffer.byteLength,
        sheets: sheetSummaries,
        totalFormulaCells: formulaCells,
      }),
      isError: false,
    };
  } catch (err) {
    return {
      content: `Spreadsheet creation failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}

/**
 * Build the workbook in memory. Exported for hermetic tests (attachment
 * delivery needs a live workspace DB; workbook math does not).
 */
export async function buildWorkbook(parsed: SheetInput[]): Promise<{
  buffer: ArrayBuffer;
  sheetSummaries: Array<{ name: string; rows: number; formulaCells: number }>;
  formulaCells: number;
}> {
  {
    const wb = new ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true;

    let formulaCells = 0;
    const sheetSummaries: Array<{
      name: string;
      rows: number;
      formulaCells: number;
    }> = [];

    for (const sheet of parsed) {
      const ws = wb.addWorksheet(sheet.name);
      let sheetFormulas = 0;

      for (let r = 0; r < sheet.rows.length; r++) {
        const rowValues = sheet.rows[r];
        const row = ws.getRow(r + 1);
        for (let c = 0; c < rowValues.length; c++) {
          const raw = rowValues[c];
          const cell = row.getCell(c + 1);
          // Unwrap rich cells ({value, format?, bold?}) to their plain value
          // plus styling; anything else object-shaped is skipped rather than
          // serialized into the sheet.
          let value: PlainCell = null;
          let cellFormat: string | undefined;
          let cellBold: boolean | undefined;
          if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
            const rich = raw as RichCell;
            value = rich.value === undefined ? null : (rich.value as PlainCell);
            if (typeof rich.format === "string") cellFormat = rich.format;
            if (typeof rich.bold === "boolean") cellBold = rich.bold;
          } else {
            value = raw as PlainCell;
          }
          if (typeof value === "string" && value.startsWith("=")) {
            cell.value = { formula: value.slice(1) };
            sheetFormulas++;
          } else if (value !== null && value !== undefined) {
            cell.value = value;
          }
          if (cellFormat) cell.numFmt = cellFormat;
          if (cellBold) cell.font = { ...(cell.font ?? {}), bold: true };
        }
        row.commit();
      }

      if (sheet.header && sheet.rows.length > 0) {
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: "frozen", ySplit: 1 }];
      }
      if (sheet.column_widths) {
        sheet.column_widths.forEach((w, idx) => {
          ws.getColumn(idx + 1).width = w;
        });
      }
      if (sheet.number_formats) {
        for (const [col, fmt] of Object.entries(sheet.number_formats)) {
          if (/^[A-Z]{1,2}$/i.test(col) && typeof fmt === "string") {
            ws.getColumn(col.toUpperCase()).numFmt = fmt;
          }
        }
      }

      formulaCells += sheetFormulas;
      sheetSummaries.push({
        name: sheet.name,
        rows: sheet.rows.length,
        formulaCells: sheetFormulas,
      });
    }

    const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    return { buffer, sheetSummaries, formulaCells };
  }
}
