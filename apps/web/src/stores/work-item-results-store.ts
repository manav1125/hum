/**
 * Inline-results cache for completed work-items (P2 contract).
 *
 * The daemon's `work_item_completed` SSE event carries the result inline:
 * `{ workItemId, status, result: { summary, highlights[], conversationId? },
 * completedAt }`. The `workitemsGet?status=done` list does NOT (it's a thin row
 * list), so to render the Done lane's result summary WITHOUT an extra
 * `getWorkItemOutput` fetch we stash the event's `result` here, keyed by
 * workItemId, the moment it streams in.
 *
 * Kept as a tiny zustand store (not react-query) because it's a push-only
 * side-channel — there's no endpoint to invalidate, the data only ever arrives
 * via SSE. The Done section subscribes; `use-activity-sync` writes.
 *
 * Bounded so a long session can't grow it unbounded — we only ever show the
 * most-recent handful of done items anyway.
 */

import { create } from "zustand";

export interface WorkItemResult {
  status: "done" | "awaiting_review" | "failed" | string;
  summary: string;
  highlights: string[];
  conversationId?: string;
  completedAt?: string;
}

const MAX_ENTRIES = 50;

interface WorkItemResultsState {
  byId: Record<string, WorkItemResult>;
  setResult: (workItemId: string, result: WorkItemResult) => void;
}

export const useWorkItemResultsStore = create<WorkItemResultsState>(
  (set, get) => ({
    byId: {},
    setResult: (workItemId, result) => {
      const current = get().byId;
      const next: Record<string, WorkItemResult> = {
        ...current,
        [workItemId]: result,
      };
      // Evict oldest insertion-order keys if we blow past the cap.
      const keys = Object.keys(next);
      if (keys.length > MAX_ENTRIES) {
        for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
          delete next[stale];
        }
      }
      set({ byId: next });
    },
  }),
);

/**
 * Best-effort parse of a `work_item_completed` event payload (the `unknown`
 * fallback's `data` bag) into a `{ workItemId, result }` pair. Returns null if
 * the payload doesn't carry the contract shape, so callers can ignore
 * malformed / partial events without crashing.
 */
export function parseWorkItemCompleted(
  data: Record<string, unknown>,
): { workItemId: string; result: WorkItemResult } | null {
  const workItemId =
    typeof data.workItemId === "string"
      ? data.workItemId
      : typeof data.id === "string"
        ? data.id
        : null;
  if (!workItemId) return null;

  const rawResult =
    typeof data.result === "object" && data.result !== null
      ? (data.result as Record<string, unknown>)
      : {};

  const summary =
    typeof rawResult.summary === "string" ? rawResult.summary : "";
  const highlights = Array.isArray(rawResult.highlights)
    ? rawResult.highlights.filter((h): h is string => typeof h === "string")
    : [];
  const conversationId =
    typeof rawResult.conversationId === "string"
      ? rawResult.conversationId
      : undefined;
  const status = typeof data.status === "string" ? data.status : "done";
  const completedAt =
    typeof data.completedAt === "string" ? data.completedAt : undefined;

  // Nothing useful to show — skip so we don't stash an empty card.
  if (!summary && highlights.length === 0) return null;

  return {
    workItemId,
    result: { status, summary, highlights, conversationId, completedAt },
  };
}
