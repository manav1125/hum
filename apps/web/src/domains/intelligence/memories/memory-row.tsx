import { Trash2 } from "lucide-react";

import { SourceTag, type MemoryType } from "@vellumai/design-library";

import { formatRelativeDate } from "@/utils/format-date";

import { sourceTypeLabel, type MemoryItem } from "./types";

interface MemoryRowProps {
  item: MemoryItem;
  /**
   * Forget (delete) this memory. Invoked when the user clicks the row's
   * trash affordance — the page owns confirmation + the delete mutation.
   */
  onForget: (item: MemoryItem) => void;
  /** True while this row's delete request is in flight; disables the button. */
  isForgetting?: boolean;
}

/**
 * One memory item: the `statement` as the primary text, `subject` as a
 * secondary line, a `SourceTag` colored by the memory `kind`, and the
 * relative time the memory was last seen. Confidence / importance are shown
 * subtly when present.
 *
 * Rows are forgettable: a `Trash2` affordance is revealed on hover/focus and
 * calls `onForget(item)`, fulfilling the header's "forget anything" promise.
 *
 * Colors come exclusively from tokens / `SourceTag` — no hard-coded hex.
 */
export function MemoryRow({ item, onForget, isForgetting = false }: MemoryRowProps) {
  const lastSeen = Number.isFinite(item.lastSeenAt)
    ? formatRelativeDate(new Date(item.lastSeenAt).toISOString())
    : "—";

  const source = sourceTypeLabel(item.sourceType);
  const confidencePct =
    typeof item.confidence === "number"
      ? Math.round(item.confidence * 100)
      : null;

  return (
    <div
      className="group flex flex-col gap-1.5 rounded-lg px-4 py-3"
      style={{ backgroundColor: "var(--surface-lift)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className="min-w-0 flex-1 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {item.statement}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <SourceTag memoryType={item.kind as MemoryType} />
          <button
            type="button"
            onClick={() => onForget(item)}
            disabled={isForgetting}
            aria-label={`Forget memory: ${item.statement}`}
            title="Forget this memory"
            className="rounded-md p-1 text-[var(--content-tertiary)] opacity-0 outline-none transition-opacity hover:bg-[var(--surface-sunken)] hover:text-[var(--content-default)] focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={15} className={isForgetting ? "animate-pulse" : undefined} />
          </button>
        </div>
      </div>

      {item.subject ? (
        <p
          className="text-body-small-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {item.subject}
        </p>
      ) : null}

      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-medium-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        <span>{lastSeen}</span>
        {source ? (
          <>
            <span aria-hidden>·</span>
            <span>{source}</span>
          </>
        ) : null}
        {confidencePct !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>{confidencePct}% confidence</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
