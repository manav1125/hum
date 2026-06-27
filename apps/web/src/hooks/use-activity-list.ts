/**
 * Typed client binding for the unified Mission Control read model
 * (`GET /v1/assistants/{assistant_id}/activity`, op `activity_list`).
 *
 * The daemon route returns its result as `unknown` in the generated SDK (it
 * declares no `responseBody` schema), so this hook is the single place that
 * names the wire shape for the web app. One call replaces the seven separate
 * lane/tally queries (work-items × status, schedules, pending-interactions, …)
 * — the server unions the stores once (docs/MISSION_CONTROL.md §3 P3).
 *
 * Real-time: `useActivitySync` invalidates the `activityGet` query key off the
 * SSE stream, so polling is just a 60s safety-net.
 */

import { useQuery } from "@tanstack/react-query";

import { activityGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

/** Server-side `ActivityLane` (docs/MISSION_CONTROL.md §2.2). */
export type ActivityLane =
  | "inbound"
  | "awaiting_you"
  | "in_progress"
  | "scheduled"
  | "done";

export type ActivityKind =
  | "work_item"
  | "feed"
  | "interaction"
  | "schedule"
  | "watcher"
  | "sequence"
  | "subagent"
  | "heartbeat";

export type ActivityUrgency = "critical" | "high" | "medium" | "low";

export interface ActivityControl {
  id: string;
  label: string;
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
}

export interface ActivityResult {
  summary: string;
  highlights: string[];
  conversationId?: string;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  lane: ActivityLane;
  title: string;
  summary?: string;
  source: {
    channel?: string;
    provenance: string;
    conversationId?: string;
  };
  status: string;
  urgency: ActivityUrgency;
  controls: ActivityControl[];
  result?: ActivityResult;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityListResult {
  items: ActivityItem[];
  counts: Record<ActivityLane, number>;
}

const SAFETY_NET_MS = 60_000;

/**
 * Fetch the whole Mission Control board in one call. SSE drives freshness; the
 * poll is a 60s safety-net.
 */
export function useActivityList(assistantId: string) {
  const query = useQuery({
    ...activityGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 10_000,
    enabled: Boolean(assistantId),
  });

  return query.data as ActivityListResult | undefined;
}
