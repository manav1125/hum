import { ArrowUpRight, Sigma, Table2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { useViewerStore } from "@/stores/viewer-store";

interface SheetSummary {
  name: string;
  rows: number;
  formulaCells: number;
}

interface SpreadsheetPreviewSurfaceData {
  filename: string;
  attachmentId: string;
  sheets: SheetSummary[];
  totalFormulaCells: number;
}

interface SpreadsheetPreviewSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onOpenSpreadsheet?: (attachmentId: string, filename: string) => void;
}

/**
 * In-chat card for a generated .xlsx. Clicking opens the native spreadsheet
 * viewer — the same clickable-preview pattern as `DocumentPreviewSurface`.
 */
export function SpreadsheetPreviewSurface({
  surface,
  onAction,
  onOpenSpreadsheet,
}: SpreadsheetPreviewSurfaceProps) {
  const data: SpreadsheetPreviewSurfaceData = {
    filename: (surface.data.filename as string) ?? "Spreadsheet",
    attachmentId: (surface.data.attachmentId as string) ?? "",
    sheets: Array.isArray(surface.data.sheets)
      ? (surface.data.sheets as SheetSummary[])
      : [],
    totalFormulaCells: (surface.data.totalFormulaCells as number) ?? 0,
  };

  // Clickable whenever we have an attachment to open. Prefer the threaded
  // prop, but fall back to the viewer store directly so the card opens the
  // native grid even if the prop chain isn't wired on this render path.
  const isClickable = data.attachmentId !== "";

  const handleClick = () => {
    if (!isClickable) return;
    if (onOpenSpreadsheet) {
      onOpenSpreadsheet(data.attachmentId, data.filename);
    } else {
      useViewerStore.getState().loadSpreadsheet(data.attachmentId, data.filename);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  const sheetCount = data.sheets.length;
  const meta = [
    sheetCount > 0
      ? `${sheetCount} sheet${sheetCount === 1 ? "" : "s"}`
      : null,
    data.totalFormulaCells > 0
      ? `${data.totalFormulaCells} formula${data.totalFormulaCells === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  const surfaceWithoutTitle = { ...surface, title: undefined };

  return (
    <div className="max-w-sm">
      <SurfaceContainer surface={surfaceWithoutTitle} onAction={onAction}>
        <div
          role={isClickable ? "button" : undefined}
          tabIndex={isClickable ? 0 : undefined}
          onClick={isClickable ? handleClick : undefined}
          onKeyDown={isClickable ? handleKeyDown : undefined}
          className={
            isClickable ? "-m-2 cursor-pointer rounded-lg p-2" : undefined
          }
        >
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 shrink-0 text-[var(--content-quiet)]" />
            <h3 className="min-w-0 flex-1 truncate text-title-small text-[var(--content-strong)]">
              {data.filename}
            </h3>
            {isClickable && (
              <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--content-faint)]" />
            )}
          </div>

          {meta.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)]">
              {data.totalFormulaCells > 0 && (
                <Sigma className="h-3 w-3 shrink-0" />
              )}
              <span>{meta.join(" · ")}</span>
            </div>
          )}
        </div>
      </SurfaceContainer>
    </div>
  );
}
