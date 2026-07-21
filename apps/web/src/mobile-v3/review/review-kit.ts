/**
 * Review-queue shared logic — stale detection + the round-4 frame 55 index
 * partition, extracted so the pager (frame 16) and the index list (frame 55)
 * read the SAME truth about what counts as stale.
 */
import type { HqWorkItem } from "@/pages/hq/use-missions";

/** Items untouched for this long read as stale even without a due date. */
export const STALE_AGE_MS = 7 * 86_400_000;

/** Rows younger than this keep the violet ◱ border (frame 55's fresh rows). */
export const FRESH_BORDER_MS = 24 * 3_600_000;

/**
 * Stale detection (UAT P1-3): an awaiting-review card whose task date passed
 * (dueAt before today) or that has sat untouched for a week gets a quiet
 * amber "From Jul 4 — likely stale" marker so a 17-day-old deliverable can't
 * masquerade as fresh work.
 */
export function staleLabel(item: HqWorkItem, now = Date.now()): string | null {
  const duePassed = item.dueAt != null && item.dueAt < now - 86_400_000;
  const aged = item.updatedAt < now - STALE_AGE_MS;
  if (!duePassed && !aged) return null;
  const fromMs = duePassed ? item.dueAt! : item.updatedAt;
  const from = new Date(fromMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `From ${from} — likely stale`;
}

/**
 * Frame 55 partition: newest-first, stale rows dropped below the mono
 * "OLDER — LIKELY STALE" divider (each half keeps newest-first order).
 */
export function partitionReview(
  items: HqWorkItem[],
  now = Date.now(),
): { fresh: HqWorkItem[]; stale: HqWorkItem[] } {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  const fresh: HqWorkItem[] = [];
  const stale: HqWorkItem[] = [];
  for (const item of sorted) {
    (staleLabel(item, now) ? stale : fresh).push(item);
  }
  return { fresh, stale };
}

/** Violet-border freshness (frame 55: hours-old rows keep the ◱ border). */
export function hasFreshBorder(item: HqWorkItem, now = Date.now()): boolean {
  return item.updatedAt >= now - FRESH_BORDER_MS;
}
