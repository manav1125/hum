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
import {
  type CellScalar,
  computeResults,
  type ModelCell,
  type WorkbookModel,
} from "./formula-eval.js";

function colIndexToLetter(index: number): string {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Unwrap a raw cell (plain value or rich `{value,format,bold}`) to its parts. */
function unwrapCell(raw: CellValue): {
  value: PlainCell;
  format?: string;
  bold?: boolean;
} {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rich = raw as RichCell;
    return {
      value: rich.value === undefined ? null : (rich.value as PlainCell),
      format: typeof rich.format === "string" ? rich.format : undefined,
      bold: typeof rich.bold === "boolean" ? rich.bold : undefined,
    };
  }
  return { value: raw as PlainCell };
}

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

/**
 * Coerce a value that should be an array/object but may arrive as a JSON
 * string. Open-weight brains (DeepSeek et al. over OpenRouter) routinely
 * serialize nested tool arguments into strings — `sheets: "[{...}]"` instead
 * of `sheets: [{...}]`. Rejecting that outright is what pushed the model to
 * improvise the workbook via bash. Parse it here instead so a well-formed
 * request succeeds regardless of how the provider encoded it.
 */
function coerceJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/** Exported for tests: validates + normalizes the `sheets` argument, including
 * the provider-stringified forms `coerceJson` unwraps. */
export function parseSheets(rawInput: unknown): SheetInput[] | string {
  const raw = coerceJson(rawInput);
  if (!Array.isArray(raw) || raw.length === 0) {
    return "Provide a non-empty `sheets` array.";
  }
  if (raw.length > MAX_SHEETS) {
    return `Too many sheets (${raw.length}); maximum is ${MAX_SHEETS}.`;
  }
  const sheets: SheetInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = coerceJson(raw[i]) as Record<string, unknown>;
    if (!s || typeof s.name !== "string" || !s.name.trim()) {
      return `Sheet ${i} is missing a string \`name\`.`;
    }
    // Same provider-stringification defense at the rows level: `rows` may be a
    // JSON string, and each row inside it may itself be stringified.
    s.rows = coerceJson(s.rows);
    if (Array.isArray(s.rows)) {
      s.rows = (s.rows as unknown[]).map((row) => coerceJson(row));
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
  context: ToolContext,
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

    // Emit a clickable in-chat preview surface so the workbook opens as a
    // native, reviewable spreadsheet inside Cue — mirroring how documents emit
    // a `document_preview`. The surface carries the attachment id; the client
    // fetches the bytes on open and renders the grid. The download attachment
    // (linked below via `attachmentIds`) remains as the fallback / export path.
    if (context.sendToClient && context.conversationId) {
      context.sendToClient({
        type: "ui_surface_show",
        conversationId: context.conversationId,
        surfaceId: `sheet-${attachment.id}`,
        surfaceType: "spreadsheet_preview",
        display: "inline",
        title: filename,
        data: {
          filename,
          attachmentId: attachment.id,
          sheets: sheetSummaries,
          totalFormulaCells: formulaCells,
          sizeBytes: buffer.byteLength,
        },
      });
    }

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
      // Typed side channel: lets the daemon link the stored attachment onto
      // the assistant message row so history reloads return it.
      attachmentIds: [attachment.id],
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

    // First, build a value model of the whole workbook so we can compute the
    // cached result of every formula cell before writing the file. ExcelJS
    // writes `{ formula }` with no cached value, so without this the delivered
    // file has 0 pre-computed numbers — every derived cell renders blank in a
    // viewer that has no spreadsheet engine. `computeResults` is fail-closed:
    // any formula it can't fully resolve is simply absent from the map and
    // left uncached (Excel recomputes it on open via `fullCalcOnLoad`).
    const model: WorkbookModel = new Map();
    for (const sheet of parsed) {
      const cells = new Map<string, ModelCell>();
      for (let r = 0; r < sheet.rows.length; r++) {
        const rowValues = sheet.rows[r];
        for (let c = 0; c < rowValues.length; c++) {
          const { value } = unwrapCell(rowValues[c]);
          const a1 = `${colIndexToLetter(c + 1)}${r + 1}`;
          if (typeof value === "string" && value.startsWith("=")) {
            cells.set(a1, { formula: value.slice(1) });
          } else if (value !== null && value !== undefined) {
            cells.set(a1, { literal: value as CellScalar });
          }
        }
      }
      // Sheet names are truncated to 31 chars at parse time; the model and the
      // worksheet share that same key so cross-sheet refs resolve.
      model.set(sheet.name, cells);
    }
    const computed = computeResults(model);

    for (const sheet of parsed) {
      const ws = wb.addWorksheet(sheet.name);
      let sheetFormulas = 0;
      const sheetResults = computed.get(sheet.name);

      // Apply COLUMN-level number formats FIRST, so per-cell formats set in the
      // write loop below win. ExcelJS's Column.numFmt setter overwrites the
      // numFmt of every existing cell in the column — so if this ran after the
      // cell loop, a column "$#,##0" would clobber a per-cell "0.0%" (a percent
      // margin row would render as "$1"). Setting it before the cells exist
      // makes it a column default that per-cell writes override.
      // Cell-reference keys (e.g. "B4") are applied AFTER the loop below.
      if (sheet.number_formats) {
        for (const [col, fmt] of Object.entries(sheet.number_formats)) {
          if (/^[A-Z]{1,2}$/i.test(col) && typeof fmt === "string") {
            ws.getColumn(col.toUpperCase()).numFmt = fmt;
          }
        }
      }

      for (let r = 0; r < sheet.rows.length; r++) {
        const rowValues = sheet.rows[r];
        const row = ws.getRow(r + 1);
        for (let c = 0; c < rowValues.length; c++) {
          const cell = row.getCell(c + 1);
          // Unwrap rich cells ({value, format?, bold?}) to their plain value
          // plus styling; anything else object-shaped is skipped rather than
          // serialized into the sheet.
          const {
            value,
            format: cellFormat,
            bold: cellBold,
          } = unwrapCell(rowValues[c]);
          if (typeof value === "string" && value.startsWith("=")) {
            const a1 = `${colIndexToLetter(c + 1)}${r + 1}`;
            const result = sheetResults?.get(a1);
            // Store the computed result alongside the formula when we have one,
            // so the file carries a real cached value; otherwise write the bare
            // formula and let Excel/Numbers recompute on open.
            cell.value =
              result === undefined
                ? { formula: value.slice(1) }
                : { formula: value.slice(1), result };
            sheetFormulas++;
          } else if (value !== null && value !== undefined) {
            cell.value = value;
          }
          if (cellFormat) cell.numFmt = cellFormat;
          if (cellBold) cell.font = { ...(cell.font ?? {}), bold: true };
        }
        row.commit();
      }

      // Apply CELL-reference number formats (e.g. "B4": "0.0%") AFTER the write
      // loop and after the column defaults, so a single cell's format wins over
      // its column format. The model frequently formats an individual percent
      // cell this way (a margin row inside a currency column); previously only
      // column-letter keys were honored, so "B4" was silently dropped and the
      // cell inherited the column's "$#,##0" — rendering 0.6 as "$1".
      if (sheet.number_formats) {
        for (const [ref, fmt] of Object.entries(sheet.number_formats)) {
          if (/^[A-Z]{1,2}[0-9]+$/i.test(ref) && typeof fmt === "string") {
            ws.getCell(ref.toUpperCase()).numFmt = fmt;
          }
        }
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
