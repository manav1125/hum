/**
 * Typed client binding for the AI chief-of-staff "Your next move" endpoint
 * (`GET /v1/assistants/{assistant_id}/next-move`).
 *
 * This route is being built by a parallel agent and is NOT yet in the generated
 * daemon SDK, so — exactly like {@link @/lib/budget-api} does for the gateway's
 * budget route — this hook names the wire shape by hand and calls the route
 * through the already-configured, authed daemon `client` (`client.get`), which
 * carries the same base URL + session cookie every generated daemon call uses.
 * When the route lands in `daemon.json` and codegen runs, the body type below
 * can be swapped for the generated one with no call-site churn.
 *
 * Real-time: like {@link @/hooks/use-activity-list}, the next move is derived
 * from the same stores the command center reads (approvals, work-items, feed),
 * so it must refresh on the same SSE events `use-activity-sync` invalidates.
 * Rather than thread a second predicate through that hook, this hook subscribes
 * to the bus itself and invalidates its own query on every command-center event
 * — the daemon recomputes the single best move and the focus card re-reveals.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import type { AssistantEvent } from "@/types/event-types";

/** The action a focus card offers. `endpoint`/`method` come from the daemon so
 * the surface stays declarative — it POSTs/GETs whatever the move attached,
 * with `open_thread` handled client-side as a navigation. */
export type NextMoveActionKind =
  | "approve"
  | "decline"
  | "run"
  | "open_thread"
  | "snooze";

export interface NextMoveAction {
  id: string;
  label: string;
  kind: NextMoveActionKind;
  /** Daemon-relative path to call for this action (absent for open_thread). */
  endpoint?: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
}

/** Which store the move was sourced from — drives the eyebrow accent. */
export type NextMoveKind = "approval" | "work_item" | "feed" | null;

export interface NextMove {
  hasMove: boolean;
  itemId: string | null;
  kind: NextMoveKind;
  headline: string;
  reasoning: string;
  actions: NextMoveAction[];
  sourceConversationId?: string;
  generatedAt?: string;
}

/** Stable query key — invalidated by this hook's own SSE subscription. */
export function nextMoveQueryKey(assistantId: string): readonly unknown[] {
  return ["command-center", "next-move", assistantId];
}

const SAFETY_NET_MS = 60_000;

/** Default while loading / on a soft failure: a calm, honest "all caught up". */
const CAUGHT_UP: NextMove = {
  hasMove: false,
  itemId: null,
  kind: null,
  headline: "",
  reasoning: "",
  actions: [],
};

/** Best-effort narrow of the daemon's opaque body into the typed contract. */
function normalize(raw: unknown): NextMove {
  if (!raw || typeof raw !== "object") return CAUGHT_UP;
  const r = raw as Record<string, unknown>;
  const hasMove = r.hasMove === true;
  const actions = Array.isArray(r.actions)
    ? (r.actions as unknown[]).flatMap((a): NextMoveAction[] => {
        if (!a || typeof a !== "object") return [];
        const o = a as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.label !== "string") return [];
        const kind = o.kind;
        const valid: NextMoveActionKind[] = [
          "approve",
          "decline",
          "run",
          "open_thread",
          "snooze",
        ];
        if (typeof kind !== "string" || !valid.includes(kind as NextMoveActionKind))
          return [];
        return [
          {
            id: o.id,
            label: o.label,
            kind: kind as NextMoveActionKind,
            endpoint: typeof o.endpoint === "string" ? o.endpoint : undefined,
            method:
              o.method === "POST" ||
              o.method === "GET" ||
              o.method === "PATCH" ||
              o.method === "DELETE"
                ? o.method
                : undefined,
          },
        ];
      })
    : [];

  return {
    hasMove,
    itemId: typeof r.itemId === "string" ? r.itemId : null,
    kind:
      r.kind === "approval" || r.kind === "work_item" || r.kind === "feed"
        ? r.kind
        : null,
    headline: typeof r.headline === "string" ? r.headline : "",
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    actions,
    sourceConversationId:
      typeof r.sourceConversationId === "string"
        ? r.sourceConversationId
        : undefined,
    generatedAt:
      typeof r.generatedAt === "string" ? r.generatedAt : undefined,
  };
}

async function fetchNextMove(assistantId: string): Promise<NextMove> {
  const { data, error, response } = await client.get<
    Record<string, unknown>,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/next-move",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  // The route may not exist yet (parallel build) — treat any non-OK as a calm
  // "caught up" rather than throwing into an error card. A real move only ever
  // comes from a 200 body.
  if (error || !response || !response.ok) return CAUGHT_UP;
  return normalize(data);
}

export interface UseNextMoveResult {
  move: NextMove;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetch the single highest-value next move. SSE drives freshness; the poll is a
 * 60s safety-net. Returns a calm caught-up default while loading or on a soft
 * failure so the hero never flashes an empty void.
 */
export function useNextMove(assistantId: string): UseNextMoveResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: nextMoveQueryKey(assistantId),
    queryFn: () => fetchNextMove(assistantId),
    enabled: Boolean(assistantId),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 10_000,
    retry: false,
  });

  // Mirror the events `use-activity-sync` reacts to: any command-center change
  // (an approval arriving/resolving, work moving lanes, the feed updating) can
  // change what the single best move is, so recompute on each.
  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId) return;
    const event = envelope.message as AssistantEvent;
    const recompute = (): void =>
      void queryClient.invalidateQueries({
        queryKey: nextMoveQueryKey(assistantId),
      });

    switch (event.type) {
      case "home_feed_updated":
      case "confirmation_request":
      case "interaction_resolved":
      case "subagent_status_changed":
      case "subagent_event":
        recompute();
        return;
      case "unknown":
        switch (event.rawType) {
          case "work_item_status_changed":
          case "work_item_completed":
          case "tasks_changed":
          case "task_run_conversation_created":
          case "surface_action_completed":
            recompute();
            return;
          default:
            return;
        }
      default:
        return;
    }
  });

  // Reconnect catch-up — the move may have changed during a transport gap.
  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || cause === "fresh") return;
    void queryClient.invalidateQueries({
      queryKey: nextMoveQueryKey(assistantId),
    });
  });

  return {
    move: query.data ?? CAUGHT_UP,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
