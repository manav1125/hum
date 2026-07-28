/**
 * Shared read model for "one work item's run stream".
 *
 * The step stream a watch-live surface shows is entirely derived from two
 * daemon reads — the typed work-item bucket (`workitemsGet`, via
 * `useHqWorkItems`) and that item's event trail (`workitemsByIdEventsGet`).
 * Both the phone's frame-17 page and the desktop watch panel need exactly the
 * same derivation, so it lives here once rather than in each renderer.
 *
 * Honesty: every node in the returned trail is a row the daemon actually
 * wrote. Nothing is synthesised, and the "still to come" tail is left to the
 * renderer, which may only draw it from the item's real status.
 *
 * NOTE: `mobile-v3/watch/watch-live-page.tsx` still carries its own inline
 * copy of `stepLabel`/`dedupeTrail` (that file sits outside this change's
 * scope). Point it at this module when it is next touched — the logic here is
 * the canonical one.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { workitemsByIdEventsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { WorkitemsByIdEventsGetResponses } from "@/generated/daemon/types.gen";
import { useHqWorkItems, type HqWorkItem } from "@/pages/hq/use-missions";

export type WorkItemEvent =
  WorkitemsByIdEventsGetResponses[200]["events"][number];

/** How often a running item's trail is re-read (idle items poll lazily). */
const LIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/** Human line for a work-item trail event. */
export function stepLabel(e: {
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
}): string {
  if (e.kind === "created") return "Captured the task";
  switch (e.toStatus) {
    case "queued":
    case "pending":
      return "Queued for a run";
    case "running":
      return "Started the run";
    case "awaiting_review":
      return "Finished — ready for your review";
    case "done":
      return "Approved";
    case "failed":
      return "Hit an error";
    case "cancelled":
      return "Stopped";
    default:
      return e.kind.replaceAll("_", " ");
  }
}

/**
 * Collapse consecutive trail events that render the same label — the daemon
 * writes both a `status_changed` and a `run_started` event on run start, so
 * without this the checklist shows "Started the run" twice.
 */
export function dedupeTrail<
  T extends { kind: string; fromStatus: string | null; toStatus: string | null },
>(trail: T[], label: (e: T) => string): T[] {
  const out: T[] = [];
  for (const e of trail) {
    const prev = out[out.length - 1];
    if (prev && label(prev) === label(e)) continue;
    out.push(e);
  }
  return out;
}

export interface WorkItemStream {
  /** The item, or null when it isn't in the bucket (archived/deleted). */
  item: HqWorkItem | null;
  /** True only while the bucket read is still in flight. */
  isLoading: boolean;
  /** Deduped, oldest-first event trail. */
  trail: WorkItemEvent[];
  running: boolean;
  /** Best-effort epoch the current run started at. */
  runStart: number;
}

/**
 * The item + its deduped event trail. `now` is passed in (rather than read
 * from the clock here) so a renderer's elapsed label and this hook's run-start
 * fallback agree on the same instant.
 */
export function useWorkItemStream(
  assistantId: string,
  workItemId: string,
  now: number,
): WorkItemStream {
  const all = useHqWorkItems(assistantId);
  const item = all.items.find((i) => i.id === workItemId) ?? null;
  const running = item?.status === "running";

  const eventsQuery = useQuery({
    ...workitemsByIdEventsGetOptions({
      path: { assistant_id: assistantId, id: workItemId },
    }),
    refetchInterval: running ? LIVE_POLL_MS : IDLE_POLL_MS,
    staleTime: 3_000,
    enabled: Boolean(assistantId && workItemId),
  });

  const trail = useMemo(
    () =>
      dedupeTrail(
        [...(eventsQuery.data?.events ?? [])].sort((a, b) => a.at - b.at),
        stepLabel,
      ),
    [eventsQuery.data?.events],
  );

  const runStart =
    [...trail].reverse().find((e) => e.toStatus === "running")?.at ??
    item?.lastActivityAt ??
    item?.updatedAt ??
    now;

  return { item, isLoading: all.isLoading, trail, running, runStart };
}
