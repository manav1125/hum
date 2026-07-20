/**
 * Registry for the active conversation's reconcile function.
 *
 * `reconcileActiveConversation` is created inside `useMessageReconciliation`
 * (a hook instance owned by `ActiveChatView` → `useMessageLifecycle`), but
 * two consumers need to trigger it from OUTSIDE that hook tree:
 *
 *   1. The mobile live-activity watchdog ("Still working — check status"):
 *      an in-flight turn with no events for a long stretch offers a manual
 *      re-sync affordance that must reach the real reconcile path, not a
 *      bespoke refetch.
 *   2. The app-foreground reconcile in `useMessageLifecycle` itself uses
 *      the function directly, but registers it here so (1) works.
 *
 * Same shape as the chat debug-api registration pattern: the owning hook
 * registers on mount and unregisters on unmount; requesters no-op safely
 * when nothing is registered (e.g. before the chat view mounts).
 */

import { useLiveStatusStore } from "@/domains/chat/live-status-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { conversationsByIdGet } from "@/generated/daemon/sdk.gen";
import { recordDiagnostic } from "@/lib/diagnostics";
import { useConversationStore } from "@/stores/conversation-store";

import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

type ActiveReconciler = () => Promise<ReconcileActiveConversationResult>;

let currentReconciler: ActiveReconciler | null = null;

/** Register the live reconcile function. Returns the unregister cleanup. */
export function registerActiveReconciler(fn: ActiveReconciler): () => void {
  currentReconciler = fn;
  return () => {
    if (currentReconciler === fn) currentReconciler = null;
  };
}

/**
 * Run the registered reconcile (fetch latest messages + turn state for the
 * active conversation; rescues a silently-completed turn). Resolves `null`
 * when no chat view is mounted. Never throws — callers are UI affordances
 * that must not surface a transient fetch failure as an unhandled rejection.
 */
export async function requestActiveReconcile(): Promise<ReconcileActiveConversationResult | null> {
  if (!currentReconciler) return null;
  try {
    return await currentReconciler();
  } catch {
    return null;
  }
}

/** Don't liveness-settle a turn younger than this — a fresh send can be
 *  locally "sending" before the daemon marks the conversation processing. */
const LIVENESS_MIN_TURN_AGE_MS = 10_000;

/** Don't liveness-settle while live signal (thinking/tool events) arrived
 *  this recently — an actively-streaming turn is self-evidently alive. */
const LIVENESS_QUIET_MS = 5_000;

/**
 * Foreground/watchdog rescue for the lost-terminal-event family.
 *
 * `reconcileActiveConversation`'s silent-stall rescue only fires when the
 * message reconcile finds STRUCTURAL drift (`changed && assistantProgress`).
 * The common backgrounded-mobile case defeats it: the reply's deltas all
 * arrived before the SSE died and only the terminal `message_complete` was
 * lost — local messages exactly match the server, `changed` is false, and
 * the turn spins forever ("Still working…" with the reply already on
 * screen). Observed live 2026-07-20 (`reconciliation_applied` with
 * `changed:false, assistantProgress:true`, phase stuck "thinking").
 *
 * This settle closes it with the daemon's authoritative per-conversation
 * `isProcessing` flag: after the messages reconcile, if the local turn
 * still claims to be in flight, fetch the conversation row; if the server
 * says it is NOT processing, end the turn (which also clears the
 * conversation-level processing mirror and, via the turn-store
 * subscription, the live-activity slice).
 *
 * Safety guards (all must hold before ending anything):
 *   - local turn is old enough and event-quiet (see constants above);
 *   - server row definitively reports `isProcessing === false`
 *     (`undefined`/missing — pre-0.8.7 daemons — never settles);
 *   - after the fetch resolves, the active conversation is unchanged and
 *     the phase is STILL sending (a terminal event that raced us wins).
 */
export async function settleTurnLivenessAgainstServer(): Promise<void> {
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) return;
  if (!isSending(useTurnStore.getState().phase)) return;
  if (useConversationStore.getState().activeConversationId !== ctx.conversationId)
    return;

  const live = useLiveStatusStore.getState().byConversation[ctx.conversationId];
  const now = Date.now();
  const startedAt = live?.turnStartedAt ?? null;
  if (startedAt !== null && now - startedAt < LIVENESS_MIN_TURN_AGE_MS) return;
  const lastSignalAt = Math.max(
    live?.lastEventAt ?? 0,
    live?.thinkingAt ?? 0,
  );
  if (lastSignalAt > 0 && now - lastSignalAt < LIVENESS_QUIET_MS) return;

  // Scope the rescue to THIS turn — if a new send lands while the fetch is
  // in flight, `endTurn`'s rescuedTurnId guard makes the settle a no-op.
  const snapshotTurnId = useTurnStore.getState().activeTurnId;

  let processing: boolean | undefined;
  try {
    const { data, response } = await conversationsByIdGet({
      path: { assistant_id: ctx.assistantId, id: ctx.conversationId },
      throwOnError: false,
    });
    if (!response?.ok) return;
    processing = data?.conversation?.isProcessing;
  } catch {
    return;
  }
  if (processing !== false) return;

  // Re-check after the await — a racing terminal event or a conversation
  // switch makes this settle stale.
  if (useConversationStore.getState().activeConversationId !== ctx.conversationId)
    return;
  if (!isSending(useTurnStore.getState().phase)) return;

  recordDiagnostic("turn_liveness_settled", {
    conversationId: ctx.conversationId,
    turnId: snapshotTurnId,
  });
  endTurn({
    conversationId: ctx.conversationId,
    reason: "rescued",
    rescuedTurnId: snapshotTurnId,
  });
}

/**
 * The full manual/foreground re-sync: messages reconcile first (renders any
 * missed reply), then the turn-liveness settle (clears a spinner whose
 * terminal event was lost even when the transcript already matched).
 */
export async function requestActiveReconcileAndSettle(): Promise<ReconcileActiveConversationResult | null> {
  const result = await requestActiveReconcile();
  try {
    await settleTurnLivenessAgainstServer();
  } catch {
    // Best-effort — the polling loop and next SSE reopen are the fallbacks.
  }
  return result;
}
