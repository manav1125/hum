/**
 * Native in-Cue spreadsheet viewer — now EDITABLE with live recalculation.
 *
 * Opens a generated .xlsx (by attachment id) as a real, reviewable surface —
 * sheet tabs, a scrollable grid with A/B/C column headers and row numbers,
 * frozen header rows, number formats, and computed formula values. This mirrors
 * the document viewer (`document-viewer-container.tsx`): an in-chat surface that
 * fetches a stored artifact, renders it, and lets the user edit it.
 *
 * Editing (SLICE 2):
 *   • Click a cell to edit its UNDERLYING value — the literal, or the formula
 *     text (`=SUM(B2:B4)`) for a formula cell, never the formatted display.
 *   • Commit with Enter or blur; Escape cancels. On commit the edit is written
 *     into a local editable workbook model and `computeResults` re-runs over the
 *     WHOLE workbook, so every dependent formula recalculates and re-renders
 *     with its number format applied.
 *   • "Download updated file" writes the edited model back to a fresh .xlsx via
 *     ExcelJS (formulas as `{ formula, result }`, literals as values, number
 *     formats / bold / frozen header preserved) and downloads the new bytes.
 *   • All client-side — nothing is written back to the server in this slice.
 *
 * Honesty contract (load-bearing, unchanged):
 *   • A formula cell WITH a resolvable result renders that result (formatted).
 *   • A formula cell the engine CANNOT resolve (a function outside its set, a
 *     cycle, a division by zero) renders the FORMULA TEXT, visibly marked, never
 *     a blank or a made-up number. Before any edit we also honor the result
 *     cached in the file by the daemon; after an edit only live-computed values
 *     are trusted (a stale cache could misrepresent a changed input).
 *
 * ExcelJS is the same library the daemon writes the file with, so the read is
 * byte-for-byte faithful. It is imported dynamically so its weight lands in a
 * separate chunk loaded only when a spreadsheet is opened.
 */

import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, Typography } from "@vellumai/design-library";
import { Download, FilePlus2, Loader2, Sigma, Table2, X } from "lucide-react";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import {
  coerceScalar,
  type CellView,
} from "@/domains/chat/utils/spreadsheet-cell";
import {
  computeResults,
  type CellScalar,
  type ModelCell,
  type WorkbookModel,
} from "@/domains/chat/utils/formula-eval";

// ---------------------------------------------------------------------------
// Editable model
// ---------------------------------------------------------------------------

/**
 * One cell of the editable workbook. Carries BOTH the underlying value (literal
 * or formula) — what the user edits and what we recompute / write back — and
 * the presentation (number format, bold, alignment) needed to render and
 * re-export faithfully.
 */
interface CellModel {
  /** Formula body WITHOUT the leading `=` (e.g. "B2*12"), when this is a formula cell. */
  formula?: string;
  /** Literal value for non-formula cells. `null`/`undefined` = empty. */
  literal?: CellScalar | null;
  /** Result cached in the original file (used only before the first edit). */
  cachedResult?: CellScalar;
  /** Effective Excel number-format string for the cell. */
  numFmt?: string;
  bold: boolean;
}

interface SheetModel {
  name: string;
  /** Number of frozen header rows (0 or 1 in practice). */
  frozenRows: number;
  /** Number of frozen leading columns. */
  frozenCols: number;
  colCount: number;
  /** cells[rowIndex][colIndex], both 0-based. Holds every row (not just the
   *  displayed window) so a write-back never drops data past the display cap. */
  cells: CellModel[][];
  /** True when more rows exist than the display window shows. */
  truncated: boolean;
}

interface WorkbookState {
  sheets: SheetModel[];
}

export interface SpreadsheetViewerContainerProps {
  attachmentId: string;
  filename: string;
  assistantId: string;
  onClose: () => void;
}

const MAX_DISPLAY_ROWS = 1000;

// ---------------------------------------------------------------------------
// A1 helpers
// ---------------------------------------------------------------------------

function colLetter(index: number): string {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1 address for a 0-based (row, col). */
function a1(row: number, col: number): string {
  return `${colLetter(col + 1)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Cell extraction: ExcelJS cell.value → CellModel (underlying, not display)
// ---------------------------------------------------------------------------

function extractCell(
  rawValue: unknown,
  numFmt: string | undefined,
  bold: boolean,
): CellModel {
  const base = { numFmt, bold } as const;

  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { ...base, literal: null };
  }
  if (rawValue instanceof Date) {
    // Dates are rendered/edited as their localized string in this slice; the
    // numeric-first vocabulary the generator emits rarely uses them.
    return { ...base, literal: rawValue.toLocaleDateString() };
  }
  if (typeof rawValue === "object") {
    const obj = rawValue as Record<string, unknown>;
    if ("formula" in obj || "sharedFormula" in obj) {
      const formula = String(obj.formula ?? obj.sharedFormula ?? "");
      let cachedResult: CellScalar | undefined;
      const result = obj.result;
      if (result !== undefined && result !== null) {
        if (typeof result === "object") {
          if ("error" in result) {
            cachedResult = String((result as { error: unknown }).error);
          } else if (result instanceof Date) {
            cachedResult = result.toLocaleDateString();
          }
        } else if (
          typeof result === "number" ||
          typeof result === "string" ||
          typeof result === "boolean"
        ) {
          cachedResult = result;
        }
      }
      return { ...base, formula, cachedResult };
    }
    if ("richText" in obj && Array.isArray(obj.richText)) {
      const text = (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("");
      return { ...base, literal: text };
    }
    if ("text" in obj) {
      return { ...base, literal: String(obj.text) };
    }
    if ("error" in obj) {
      return { ...base, literal: String(obj.error) };
    }
    return { ...base, literal: null };
  }
  if (
    typeof rawValue === "number" ||
    typeof rawValue === "string" ||
    typeof rawValue === "boolean"
  ) {
    return { ...base, literal: rawValue };
  }
  return { ...base, literal: null };
}

// ---------------------------------------------------------------------------
// Parse the workbook into the editable model (dynamic ExcelJS import)
// ---------------------------------------------------------------------------

async function parseWorkbook(buffer: ArrayBuffer): Promise<WorkbookState> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheets: SheetModel[] = wb.worksheets.map((ws) => {
    let frozenRows = 0;
    let frozenCols = 0;
    const view = ws.views?.[0];
    if (view && view.state === "frozen") {
      frozenRows = view.ySplit ?? 0;
      frozenCols = view.xSplit ?? 0;
    }

    const colCount = Math.max(ws.columnCount, 1);
    const totalRows = ws.rowCount;

    const cells: CellModel[][] = [];
    for (let r = 1; r <= totalRows; r++) {
      const row = ws.getRow(r);
      const rowCells: CellModel[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        const effectiveFmt =
          (cell.numFmt as string | undefined) ||
          (ws.getColumn(c).numFmt as string | undefined);
        const bold = Boolean(cell.font?.bold);
        rowCells.push(extractCell(cell.value, effectiveFmt, bold));
      }
      cells.push(rowCells);
    }

    return {
      name: ws.name,
      frozenRows,
      frozenCols,
      colCount,
      cells,
      truncated: totalRows > MAX_DISPLAY_ROWS,
    };
  });

  return { sheets };
}

// ---------------------------------------------------------------------------
// Model helpers: build a WorkbookModel for the engine, derive display cells
// ---------------------------------------------------------------------------

function buildWorkbookModel(sheets: SheetModel[]): WorkbookModel {
  const model: WorkbookModel = new Map();
  for (const s of sheets) {
    const m = new Map<string, ModelCell>();
    for (let r = 0; r < s.cells.length; r++) {
      const row = s.cells[r];
      for (let c = 0; c < s.colCount; c++) {
        const cell = row[c];
        if (!cell) continue;
        if (cell.formula !== undefined) {
          m.set(a1(r, c), { formula: cell.formula });
        } else if (cell.literal !== null && cell.literal !== undefined) {
          m.set(a1(r, c), { literal: cell.literal });
        }
      }
    }
    model.set(s.name, m);
  }
  return model;
}

/** The value to show for a cell: live engine result, else (pristine only) the
 *  file's cached result, else undefined (formula shown honestly as text). */
function effectiveResult(
  cell: CellModel,
  live: CellScalar | undefined,
  dirty: boolean,
): CellScalar | undefined {
  if (live !== undefined) return live;
  if (!dirty) return cell.cachedResult;
  return undefined;
}

function displayCell(
  cell: CellModel,
  result: CellScalar | undefined,
): CellView {
  if (cell.formula !== undefined) {
    if (result !== undefined) return coerceScalar(result, cell.numFmt, cell.bold);
    return {
      text: `=${cell.formula}`,
      kind: "formula-uncached",
      bold: cell.bold,
      align: "left",
    };
  }
  if (cell.literal === null || cell.literal === undefined) {
    return { text: "", kind: "empty", bold: cell.bold, align: "left" };
  }
  return coerceScalar(cell.literal, cell.numFmt, cell.bold);
}

/** The text seeded into the edit input: the underlying value the user edits. */
function editSeed(cell: CellModel): string {
  if (cell.formula !== undefined) return `=${cell.formula}`;
  if (cell.literal === null || cell.literal === undefined) return "";
  if (typeof cell.literal === "boolean") return cell.literal ? "TRUE" : "FALSE";
  return String(cell.literal);
}

/** Parse a committed edit string into the underlying cell fields. */
function parseInput(raw: string): Pick<CellModel, "formula" | "literal" | "cachedResult"> {
  if (raw.startsWith("=")) {
    return { formula: raw.slice(1), literal: undefined, cachedResult: undefined };
  }
  const t = raw.trim();
  if (t === "") return { formula: undefined, literal: null, cachedResult: undefined };
  const upper = t.toUpperCase();
  if (upper === "TRUE") return { formula: undefined, literal: true, cachedResult: undefined };
  if (upper === "FALSE") return { formula: undefined, literal: false, cachedResult: undefined };
  const n = Number(t);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    return { formula: undefined, literal: n, cachedResult: undefined };
  }
  return { formula: undefined, literal: raw, cachedResult: undefined };
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

function editedFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-edited.xlsx`;
  return `${name.slice(0, dot)}-edited${name.slice(dot)}`;
}

async function buildEditedWorkbook(
  sheets: SheetModel[],
  results: Map<string, Map<string, CellScalar>>,
): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    if (sheet.frozenRows > 0 || sheet.frozenCols > 0) {
      ws.views = [
        {
          state: "frozen",
          xSplit: sheet.frozenCols,
          ySplit: sheet.frozenRows,
        },
      ];
    }
    const sheetResults = results.get(sheet.name);
    for (let r = 0; r < sheet.cells.length; r++) {
      const row = sheet.cells[r];
      for (let c = 0; c < sheet.colCount; c++) {
        const cm = row[c];
        if (!cm) continue;
        const cell = ws.getCell(r + 1, c + 1);
        if (cm.formula !== undefined) {
          const result = sheetResults?.get(a1(r, c));
          cell.value =
            result !== undefined
              ? { formula: cm.formula, result }
              : { formula: cm.formula };
        } else if (cm.literal !== null && cm.literal !== undefined) {
          cell.value = cm.literal;
        }
        if (cm.numFmt) cell.numFmt = cm.numFmt;
        if (cm.bold) cell.font = { bold: true };
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function triggerDownload(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SpreadsheetViewerContainer({
  attachmentId,
  filename,
  assistantId,
  onClose,
}: SpreadsheetViewerContainerProps) {
  const [workbook, setWorkbook] = useState<WorkbookState | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setWorkbook(null);
    setError(null);
    setActiveSheet(0);
    setDirty(false);
    setEditing(null);

    void (async () => {
      try {
        const { data, error: fetchErr } = await attachmentsByIdContentGet({
          path: { assistant_id: assistantId, id: attachmentId },
          parseAs: "blob",
          throwOnError: false,
        });
        if (fetchErr || !(data instanceof Blob)) {
          throw new Error("Failed to load the spreadsheet file.");
        }
        if (cancelled) return;
        objectUrl = URL.createObjectURL(data);
        setBlobUrl(objectUrl);
        const buffer = await data.arrayBuffer();
        const parsed = await parseWorkbook(buffer);
        if (cancelled) return;
        if (parsed.sheets.length === 0) {
          setError("This workbook has no sheets to display.");
          return;
        }
        setWorkbook(parsed);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not open this spreadsheet.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobUrl(null);
    };
  }, [attachmentId, assistantId]);

  const sheets = workbook?.sheets;

  // Recalculate the whole workbook whenever the editable model changes.
  const results = useMemo(
    () => (sheets ? computeResults(buildWorkbookModel(sheets)) : null),
    [sheets],
  );

  const sheet = sheets?.[activeSheet];
  const sheetResults = sheet ? results?.get(sheet.name) : undefined;

  // Derive the displayed grid (values + honesty markers) for the active sheet.
  const grid = useMemo(() => {
    if (!sheet) return null;
    const displayRows = Math.min(sheet.cells.length, MAX_DISPLAY_ROWS);
    const views: CellView[][] = [];
    let uncachedFormulas = 0;
    for (let r = 0; r < displayRows; r++) {
      const row = sheet.cells[r];
      const viewRow: CellView[] = [];
      for (let c = 0; c < sheet.colCount; c++) {
        const cell = row[c];
        const live = sheetResults?.get(a1(r, c));
        const result = effectiveResult(cell, live, dirty);
        const view = displayCell(cell, result);
        if (view.kind === "formula-uncached") uncachedFormulas++;
        viewRow.push(view);
      }
      views.push(viewRow);
    }
    return { views, displayRows, uncachedFormulas };
  }, [sheet, sheetResults, dirty]);

  const startEdit = useCallback(
    (r: number, c: number) => {
      if (!sheet) return;
      setEditing({ r, c });
      setEditValue(editSeed(sheet.cells[r][c]));
    },
    [sheet],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const { r, c } = editing;
    setWorkbook((prev) => {
      if (!prev) return prev;
      const sheetsNext = prev.sheets.slice();
      const target = { ...sheetsNext[activeSheet] };
      const rows = target.cells.slice();
      const row = rows[r].slice();
      row[c] = { ...row[c], ...parseInput(editValue) };
      rows[r] = row;
      target.cells = rows;
      sheetsNext[activeSheet] = target;
      return { sheets: sheetsNext };
    });
    setDirty(true);
    setEditing(null);
  }, [editing, activeSheet, editValue]);

  const handleDownloadOriginal = useCallback(() => {
    if (!blobUrl) return;
    triggerDownload(blobUrl, filename);
  }, [blobUrl, filename]);

  const handleDownloadEdited = useCallback(() => {
    if (!sheets || !results) return;
    setExporting(true);
    void (async () => {
      try {
        const blob = await buildEditedWorkbook(sheets, results);
        const url = URL.createObjectURL(blob);
        triggerDownload(url, editedFilename(filename));
        // Revoke after the click has had a chance to start the download.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch {
        setError("Could not build the updated file.");
      } finally {
        setExporting(false);
      }
    })();
  }, [sheets, results, filename]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/* Navbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2">
        <Table2 size={16} style={{ color: "var(--content-secondary)" }} />
        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
        >
          {filename}
        </Typography>
        <span
          className={
            dirty
              ? "rounded-full bg-[var(--tag-bg-warning,var(--tag-bg-neutral))] px-2 py-0.5 text-[var(--content-emphasised)] text-label-small-default"
              : "rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-[var(--content-tertiary)] text-label-small-default"
          }
        >
          {dirty ? "Unsaved edits" : "Editable"}
        </span>
        {blobUrl ? (
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<Download />}
            onClick={handleDownloadOriginal}
          >
            Original
          </Button>
        ) : null}
        {sheets ? (
          <Button
            variant="outlined"
            size="compact"
            leftIcon={exporting ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
            onClick={handleDownloadEdited}
            disabled={exporting}
          >
            Download updated file
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close spreadsheet"
          tooltip="Close"
        />
      </div>

      {/* Body */}
      {error ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <Typography
            variant="body-medium-lighter"
            className="text-[var(--content-tertiary)]"
          >
            {error}
          </Typography>
        </div>
      ) : !workbook || !sheet || !grid ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <SheetGrid
              sheet={sheet}
              views={grid.views}
              displayRows={grid.displayRows}
              editing={editing}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onStartEdit={startEdit}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          </div>

          {/* Footer: honesty note + editable behavior */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border-base)] px-4 py-2 text-[var(--content-tertiary)] text-label-small-default">
            {grid.uncachedFormulas > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Sigma size={12} />
                {grid.uncachedFormulas} formula
                {grid.uncachedFormulas === 1 ? "" : "s"} shown as the formula —
                uses a function Cue can't recalculate here; it resolves in Excel
                or Numbers.
              </span>
            ) : null}
            {sheet.truncated ? (
              <span>
                Showing the first {MAX_DISPLAY_ROWS.toLocaleString()} rows (all
                rows are kept in the downloaded file).
              </span>
            ) : null}
            <span className="ml-auto">
              {dirty
                ? "Edited — use “Download updated file” to save your changes."
                : "Click any cell to edit. Formulas recalculate live."}
            </span>
          </div>

          {/* Sheet tabs */}
          {workbook.sheets.length > 1 ? (
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--border-base)] px-2 py-1.5">
              {workbook.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setActiveSheet(i);
                  }}
                  className={
                    i === activeSheet
                      ? "rounded-md bg-[var(--surface-sunken)] px-3 py-1 font-medium text-[var(--content-emphasised)] text-label-small-default"
                      : "rounded-md px-3 py-1 text-[var(--content-tertiary)] text-label-small-default hover:bg-[var(--surface-sunken)]"
                  }
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

interface SheetGridProps {
  sheet: SheetModel;
  views: CellView[][];
  displayRows: number;
  editing: { r: number; c: number } | null;
  editValue: string;
  onEditValueChange: (v: string) => void;
  onStartEdit: (r: number, c: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function SheetGrid({
  sheet,
  views,
  displayRows,
  editing,
  editValue,
  onEditValueChange,
  onStartEdit,
  onCommit,
  onCancel,
}: SheetGridProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <table className="border-collapse text-body-small-default">
      <thead>
        <tr>
          {/* Corner */}
          <th className="sticky top-0 left-0 z-20 border border-[var(--border-base)] bg-[var(--surface-sunken)]" />
          {Array.from({ length: sheet.colCount }, (_, i) => (
            <th
              key={i}
              className="sticky top-0 z-10 min-w-[80px] border border-[var(--border-base)] bg-[var(--surface-sunken)] px-2 py-1 text-center font-medium text-[var(--content-tertiary)]"
            >
              {colLetter(i + 1)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {views.slice(0, displayRows).map((row, r) => {
          const isFrozenHeader = r < sheet.frozenRows;
          return (
            <tr key={r}>
              {/* Row number */}
              <td className="sticky left-0 z-10 border border-[var(--border-base)] bg-[var(--surface-sunken)] px-2 py-1 text-center text-[var(--content-tertiary)] tabular-nums">
                {r + 1}
              </td>
              {row.map((cell, c) => {
                const frozenCol = c < sheet.frozenCols;
                const isEditing = editing?.r === r && editing?.c === c;
                return (
                  <td
                    key={c}
                    onClick={() => {
                      if (!isEditing) onStartEdit(r, c);
                    }}
                    className={[
                      "max-w-[280px] cursor-text border px-2 py-1",
                      isEditing ? "border-[var(--border-focus,var(--border-base))] p-0" : "border-[var(--border-subtle)] truncate",
                      cell.align === "right" ? "text-right" : "text-left",
                      cell.bold || isFrozenHeader
                        ? "font-semibold text-[var(--content-emphasised)]"
                        : "text-[var(--content-default)]",
                      isFrozenHeader ? "bg-[var(--surface-sunken)]" : "",
                      frozenCol ? "bg-[var(--surface-base)]" : "",
                      cell.kind === "formula-uncached"
                        ? "font-mono text-[var(--content-tertiary)] italic"
                        : "",
                    ].join(" ")}
                    title={
                      cell.kind === "formula-uncached"
                        ? `${cell.text} — recalculates on open in Excel/Numbers`
                        : cell.text
                    }
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => onEditValueChange(e.target.value)}
                        onKeyDown={onKeyDown}
                        onBlur={onCommit}
                        className="w-full min-w-[72px] bg-[var(--surface-base)] px-2 py-1 font-mono text-[var(--content-emphasised)] outline-none"
                        aria-label={`Edit cell ${a1(r, c)}`}
                      />
                    ) : (
                      cell.text
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
