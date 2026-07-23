/**
 * Native in-Cue spreadsheet viewer.
 *
 * Opens a generated .xlsx (by attachment id) as a real, reviewable surface —
 * sheet tabs, a scrollable grid with A/B/C column headers and row numbers,
 * frozen header rows, number formats, and computed formula values. This mirrors
 * the document viewer (`document-viewer-container.tsx`): an in-chat surface that
 * fetches a stored artifact, renders it, and (in a later slice) writes edits
 * back.
 *
 * Scope — SLICE 1 (VIEW), read-only. Editing (write-back + recompute) is a
 * deferred slice; the UI says so plainly rather than presenting an editable
 * grid that silently discards changes.
 *
 * Honesty contract (load-bearing):
 *   • A formula cell WITH a cached result renders that result (formatted).
 *   • A formula cell WITHOUT a cached result renders the FORMULA TEXT, visibly
 *     marked, never a blank or a made-up number. Generated workbooks now cache
 *     results daemon-side, but files produced before that (or formulas the
 *     daemon evaluator couldn't resolve) legitimately arrive uncached, and we
 *     show them honestly.
 *
 * ExcelJS is the same library the daemon writes the file with, so the read is
 * byte-for-byte faithful. It is imported dynamically so its weight lands in a
 * separate chunk loaded only when a spreadsheet is opened.
 */

import { useCallback, useEffect, useState } from "react";

import { Button, Typography } from "@vellumai/design-library";
import { Download, Loader2, Sigma, Table2, X } from "lucide-react";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import {
  coerceCell,
  type CellView,
} from "@/domains/chat/utils/spreadsheet-cell";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface SheetView {
  name: string;
  /** Number of frozen header rows (0 or 1 in practice). */
  frozenRows: number;
  /** Number of frozen leading columns. */
  frozenCols: number;
  rows: CellView[][];
  colCount: number;
  /** True when the sheet was truncated for display. */
  truncated: boolean;
  /** Count of formula cells that had no cached value. */
  uncachedFormulas: number;
}

interface WorkbookView {
  sheets: SheetView[];
}

export interface SpreadsheetViewerContainerProps {
  attachmentId: string;
  filename: string;
  assistantId: string;
  onClose: () => void;
}

const MAX_DISPLAY_ROWS = 1000;

// ---------------------------------------------------------------------------
// Cell coercion
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

// ---------------------------------------------------------------------------
// Parse the workbook into a view model (dynamic ExcelJS import)
// ---------------------------------------------------------------------------

async function parseWorkbook(buffer: ArrayBuffer): Promise<WorkbookView> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheets: SheetView[] = wb.worksheets.map((ws) => {
    let frozenRows = 0;
    let frozenCols = 0;
    const view = ws.views?.[0];
    if (view && view.state === "frozen") {
      frozenRows = view.ySplit ?? 0;
      frozenCols = view.xSplit ?? 0;
    }

    const colCount = Math.max(ws.columnCount, 1);
    const totalRows = ws.rowCount;
    const displayRows = Math.min(totalRows, MAX_DISPLAY_ROWS);

    let uncachedFormulas = 0;
    const rows: CellView[][] = [];
    for (let r = 1; r <= displayRows; r++) {
      const row = ws.getRow(r);
      const cells: CellView[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        const effectiveFmt =
          (cell.numFmt as string | undefined) ||
          (ws.getColumn(c).numFmt as string | undefined);
        const bold = Boolean(cell.font?.bold);
        const cellView = coerceCell(cell.value, effectiveFmt, bold);
        if (cellView.kind === "formula-uncached") uncachedFormulas++;
        cells.push(cellView);
      }
      rows.push(cells);
    }

    return {
      name: ws.name,
      frozenRows,
      frozenCols,
      rows,
      colCount,
      truncated: totalRows > displayRows,
      uncachedFormulas,
    };
  });

  return { sheets: sheets.length > 0 ? sheets : [] };
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
  const [workbook, setWorkbook] = useState<WorkbookView | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setWorkbook(null);
    setError(null);
    setActiveSheet(0);

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

  const handleDownload = useCallback(() => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [blobUrl, filename]);

  const sheet = workbook?.sheets[activeSheet];

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
        <span className="rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-[var(--content-tertiary)] text-label-small-default">
          Read-only preview
        </span>
        {blobUrl ? (
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<Download />}
            onClick={handleDownload}
          >
            Download
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
      ) : !workbook || !sheet ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <SheetGrid sheet={sheet} />
          </div>

          {/* Honesty footer: uncached-formula note + read-only boundary */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border-base)] px-4 py-2 text-[var(--content-tertiary)] text-label-small-default">
            {sheet.uncachedFormulas > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Sigma size={12} />
                {sheet.uncachedFormulas} formula
                {sheet.uncachedFormulas === 1 ? "" : "s"} shown as the formula —
                value recalculates when you open the file in Excel or Numbers.
              </span>
            ) : null}
            {sheet.truncated ? (
              <span>
                Showing the first {MAX_DISPLAY_ROWS.toLocaleString()} rows.
              </span>
            ) : null}
            <span className="ml-auto">
              Editing in Cue is coming soon — download to change values today.
            </span>
          </div>

          {/* Sheet tabs */}
          {workbook.sheets.length > 1 ? (
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--border-base)] px-2 py-1.5">
              {workbook.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setActiveSheet(i)}
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

function SheetGrid({ sheet }: { sheet: SheetView }) {
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
        {sheet.rows.map((row, r) => {
          const isFrozenHeader = r < sheet.frozenRows;
          return (
            <tr key={r}>
              {/* Row number */}
              <td className="sticky left-0 z-10 border border-[var(--border-base)] bg-[var(--surface-sunken)] px-2 py-1 text-center text-[var(--content-tertiary)] tabular-nums">
                {r + 1}
              </td>
              {row.map((cell, c) => {
                const frozenCol = c < sheet.frozenCols;
                return (
                  <td
                    key={c}
                    className={[
                      "max-w-[280px] truncate border border-[var(--border-subtle)] px-2 py-1",
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
                    {cell.text}
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
