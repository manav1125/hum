import { SourceTag, type MemoryType } from "@vellumai/design-library";

import { formatRelativeDate } from "@/utils/format-date";

import { sourceTypeLabel, type MemoryItem } from "./types";

interface MemoryRowProps {
  item: MemoryItem;
}

/**
 * One memory item: the `statement` as the primary text, `subject` as a
 * secondary line, a `SourceTag` colored by the memory `kind`, and the
 * relative time the memory was last seen. Confidence / importance are shown
 * subtly when present.
 *
 * Colors come exclusively from tokens / `SourceTag` — no hard-coded hex.
 */
export function MemoryRow({ item }: MemoryRowProps) {
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
      className="flex flex-col gap-1.5 rounded-lg px-4 py-3"
      style={{ backgroundColor: "var(--surface-lift)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className="min-w-0 flex-1 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {item.statement}
        </p>
        <SourceTag
          memoryType={item.kind as MemoryType}
          className="shrink-0"
        />
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
