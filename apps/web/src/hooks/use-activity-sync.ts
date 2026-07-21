/**
 * Real-time sync for the command center (Activity + Home feed + Mission
 * Control). Subscribes to the always-on SSE stream via the event bus and
 * invalidates exactly the react-query caches the command-center surfaces read,
 * so they update the instant the daemon broadcasts — instead of waiting on a
 * 15-50s poll.
 *
 * Modeled on `hooks/use-assistant-resource-sync.ts` and
 * `hooks/use-conversation-sync.ts`: stateless one-liner invalidations routed
 * off `sse.event`, plus a reconnect catch-up on `sse.opened` (non-fresh) for
 * events missed during a transport gap.
 *
 * Event routing is split two ways because the typed `AssistantEvent` Zod union
 * (`@vellumai/assistant-api`) only covers SOME of the events the daemon emits:
 *
 * - Typed events (`event.type`): `home_feed_updated`, `confirmation_request`,
 *   `interaction_resolved`, `subagent_status_changed`, `subagent_event`.
 * - Untyped events — not (yet) in the union, so the parser wraps them as
 *   `{ type: "unknown", rawType, data }` (see `lib/streaming/parse-helpers.ts`).
 *   We route those off `rawType`: `work_item_status_changed`,
 *   `work_item_assessed` (the pre-run verdict), `work_item_completed`
 *   (P2 contract), `tasks_changed`, `task_run_conversation_created`,
 *   `surface_action_completed`.
 *
 * Invalidation targets generated query keys by their `_id` discriminator
 * (the first key part `{ _id }`, set by the SDK's `createQueryKey`) rather than
 * a fully-built key, so EVERY status variant of an endpoint
 * (`workitemsGet?status=running|pending|done`) is refreshed in one shot,
 * regardless of the exact `query` params the calling section used. The two
 * Activity-only custom keys (watchers, sequences) are matched by prefix.
 *
 * References:
 * - docs/MISSION_CONTROL.md §2.4 (real-time wiring table)
 * - EVENT_BUS.md — bus subscription contract
 */

import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  parseWorkItemCompleted,
  useWorkItemResultsStore,
} from "@/stores/work-item-results-store";
import type { AssistantEvent } from "@/types/event-types";

/** First-key-part `_id` match for SDK-generated query keys. */
function isGeneratedQueryKey(
  queryKey: readonly unknown[],
  id: string,
): boolean {
  const first = queryKey[0];
  return (
    first !== null &&
    typeof first === "object" &&
    (first as { _id?: unknown })._id === id
  );
}

/** Prefix match for the Activity page's two hand-rolled query keys. */
function isCustomActivityKey(
  queryKey: readonly unknown[],
  domain: "watchers" | "sequences",
): boolean {
  return queryKey[0] === "activity" && queryKey[1] === domain;
}

/**
 * Subscribes the command center to live SSE events. Side-effect only — mount it
 * once per surface that reads these caches (Activity page, Home feed, Mission
 * Control). React Query dedupes the invalidations, so mounting it on more than
 * one visible surface is harmless.
 *
 * @param assistantId active assistant, or null while resolving
 * @param isAssistantActive gate so we don't churn caches for a backgrounded
 *   assistant (mirrors the resource/conversation sync hooks)
 */
export function useActivitySync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) return;
    // The bus types `message` as the package event union, but the parser
    // (`lib/streaming/event-parser.ts`) actually delivers the client union —
    // which adds the `unknown` fallback carrying `rawType` for events not yet
    // in the package's Zod union (the work-item / task events we route below).
    // Cast to the client type so those narrow correctly.
    const event = envelope.message as AssistantEvent;

    const invalidateGenerated = (id: string): void => {
      void queryClient.invalidateQueries({
        predicate: (q) => isGeneratedQueryKey(q.queryKey, id),
      });
    };

    // The unified Mission Control read model (`activity_list`) backs the header
    // tally + lane counts. It's a superset of every store below, so refresh it
    // on any command-center event.
    const refreshActivityList = (): void => invalidateGenerated("activityGet");
    // Work-items move between the running / queued / done lanes. Refresh all
    // status buckets in one shot.
    const refreshWorkItems = (): void => {
      invalidateGenerated("workitemsGet");
      refreshActivityList();
    };
    // Pending interactions = the "Needs you" / "Awaiting you" lane.
    const refreshInteractions = (): void => {
      invalidateGenerated("pendinginteractionsGet");
      refreshActivityList();
    };
    // Live subagents = the In-progress lane's agent rows.
    const refreshSubagents = (): void => {
      invalidateGenerated("subagentsGet");
      invalidateGenerated("subagentsReconcileGet");
      refreshActivityList();
    };

    switch (event.type) {
      case "home_feed_updated":
        invalidateGenerated("homeFeedGet");
        refreshActivityList();
        return;

      case "confirmation_request":
        refreshInteractions();
        return;

      case "interaction_resolved":
        // An approval was consumed (allow/deny) — drop it from Awaiting you.
        refreshInteractions();
        return;

      case "subagent_status_changed":
      case "subagent_event":
        refreshSubagents();
        return;

      case "unknown": {
        switch (event.rawType) {
          case "work_item_status_changed":
            refreshWorkItems();
            // A status flip can also flip the Done lane's heartbeat
            // companions; cheap to keep them honest.
            invalidateGenerated("heartbeatRunsGet");
            // The runner broadcasts this on every distinct progress note, and
            // each of those also appends a `run_step` row — so an open task
            // trail grows as the run happens instead of on the next poll.
            invalidateGenerated("workitemsByIdEventsGet");
            return;
          case "work_item_assessed":
            // The pre-run verdict (what Cue understood / the one question it
            // needs answered). The values live on the work item itself, so the
            // honest move is to refetch the item rather than trust the push
            // payload — a client that missed this event is still correct.
            refreshWorkItems();
            invalidateGenerated("projectsByIdWorkitemsGet");
            invalidateGenerated("workitemsByIdEventsGet");
            return;
          case "work_item_completed": {
            // P2 contract: terminal transition carrying the result inline.
            // Stash the result so the Done lane renders summary + highlights
            // with ZERO extra fetch, then invalidate so the work-item lists
            // rebalance (running → done).
            const parsed = parseWorkItemCompleted(event.data);
            if (parsed) {
              useWorkItemResultsStore
                .getState()
                .setResult(parsed.workItemId, parsed.result);
            }
            refreshWorkItems();
            invalidateGenerated("heartbeatRunsGet");
            return;
          }
          case "tasks_changed":
          case "task_run_conversation_created":
            // Tasks back the queued / in-progress work-item runs.
            refreshWorkItems();
            return;
          case "surface_action_completed":
            invalidateGenerated("homeFeedGet");
            refreshWorkItems();
            refreshActivityList();
            return;
          default:
            return;
        }
      }

      default:
        // Watchers/sequences (the `["activity","watchers"|"sequences"]` custom
        // keys matched by `isCustomActivityKey`) have no dedicated push event
        // yet — the 60s safety-net poll + the reconnect catch-up below keep
        // them fresh.
        return;
    }
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) return;
    if (cause === "fresh") return;
    // Reconnect — the client may have missed events during the transport gap.
    // Refresh every command-center cache once so no lane is left stale.
    void queryClient.invalidateQueries({
      predicate: (q) =>
        isGeneratedQueryKey(q.queryKey, "activityGet") ||
        isGeneratedQueryKey(q.queryKey, "workitemsGet") ||
        // Assessment verdicts ride on the item and its trail, so a gap must
        // not leave a task showing a question it has already been answered.
        isGeneratedQueryKey(q.queryKey, "projectsByIdWorkitemsGet") ||
        isGeneratedQueryKey(q.queryKey, "workitemsByIdEventsGet") ||
        isGeneratedQueryKey(q.queryKey, "pendinginteractionsGet") ||
        isGeneratedQueryKey(q.queryKey, "schedulesGet") ||
        isGeneratedQueryKey(q.queryKey, "subagentsGet") ||
        isGeneratedQueryKey(q.queryKey, "subagentsReconcileGet") ||
        isGeneratedQueryKey(q.queryKey, "heartbeatRunsGet") ||
        isGeneratedQueryKey(q.queryKey, "homeFeedGet") ||
        isCustomActivityKey(q.queryKey, "watchers") ||
        isCustomActivityKey(q.queryKey, "sequences"),
    });
  });
}
