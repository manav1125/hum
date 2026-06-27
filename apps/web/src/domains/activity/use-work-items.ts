/**
 * Work-items query + defensive narrowing for the Activity surface.
 *
 * `workitemsGet` types its `items` as `unknown[]` (see types.gen.ts), so every
 * row is narrowed here into a stable `WorkItemView`. Provenance is derived from
 * whatever trigger/origin/source field the payload actually carries — never
 * fabricated: when nothing readable is present we return `provenance: null` and
 * the row simply omits the chip.
 */

import { useQuery } from "@tanstack/react-query";

import { workitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { WorkitemsGetData } from "@/generated/daemon/types.gen";

import { asRecord, num, str } from "./theme";

type WorkItemStatus = NonNullable<WorkitemsGetData["query"]>["status"];

export interface WorkItemView {
  id: string;
  title: string;
  status: string;
  /** Honest trigger label or null when the payload doesn't say. */
  provenance: string | null;
  /** Best-effort created/updated epoch for a "12m ago" meta line. */
  at: number | null;
}

/**
 * Map a raw origin/source/trigger token onto a friendly provenance label.
 * Only returns a label for tokens we recognise; unknown non-empty tokens are
 * surfaced verbatim, and missing tokens yield null (chip omitted).
 */
function provenanceFor(rec: Record<string, unknown>): string | null {
  const token =
    str(rec.origin) ??
    str(rec.source) ??
    str(rec.trigger) ??
    str(rec.triggeredBy) ??
    str(rec.createdBy) ??
    str(rec.reason);
  if (!token) return null;
  const t = token.toLowerCase();
  if (t.includes("watch")) return "watcher event";
  if (t.includes("schedul") || t.includes("cron")) return "schedule";
  if (t.includes("heartbeat") || t.includes("proactiv")) return "Cue’s heartbeat";
  if (t.includes("user") || t.includes("chat") || t.includes("manual")) return "you, in chat";
  if (t.includes("sequence") || t.includes("drip")) return "sequence";
  if (t.includes("agent") || t.includes("subagent")) return "an agent";
  // Unknown but present — surface it honestly rather than dropping it.
  return token;
}

function narrow(raw: unknown): WorkItemView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = str(rec.id) ?? str(rec.workItemId) ?? str(rec.uuid);
  if (!id) return null;
  const title =
    str(rec.title) ?? str(rec.name) ?? str(rec.summary) ?? "Untitled work item";
  const status = str(rec.status) ?? "open";
  const at =
    num(rec.updatedAt) ??
    num(rec.startedAt) ??
    num(rec.createdAt) ??
    num(rec.completedAt) ??
    null;
  return { id, title, status, provenance: provenanceFor(rec), at };
}

export interface WorkItemsResult {
  items: WorkItemView[];
  /** Raw row count from the daemon — used to detect "opaque, nothing narrowed". */
  rawCount: number;
  isLoading: boolean;
  isError: boolean;
}

/** Query a single work-item status bucket, narrowed + provenance-tagged. */
export function useWorkItems(
  assistantId: string,
  status: WorkItemStatus,
): WorkItemsResult {
  const query = useQuery({
    // SSE (`useActivitySync`) drives freshness off `work_item_status_changed` /
    // `work_item_completed` / `tasks_changed`; poll is a 60s safety-net.
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status },
    }),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const raw = query.data?.items ?? [];
  const items: WorkItemView[] = [];
  for (const row of raw) {
    const v = narrow(row);
    if (v) items.push(v);
  }
  return {
    items,
    rawCount: raw.length,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
