/**
 * While a turn is running and nothing is on screen to answer, keep asking the
 * daemon whether it is actually waiting on the user.
 *
 * An approval reaches the client as a `confirmation_request` SSE event, and
 * the prompt is rendered from that event alone. When the event does not land,
 * the run sits on "Working" with nothing to click and no way back: the two
 * existing repair passes both fire on transitions the user is not making.
 * `restorePendingInteractions` runs when a conversation's history loads and
 * when the stream reopens — neither happens to someone already sitting in the
 * conversation watching it — and the message-reconciliation loop gives up
 * after 60 seconds and reconciles messages, not interactions. A missed
 * approval is precisely the case where the message list is correct and
 * unchanging while the daemon waits.
 *
 * So the stall outlives every repair we had, and the only recovery was to open
 * the conversation somewhere else — which is exactly what people were doing,
 * after however long it took them to notice.
 *
 * This closes that: a small poll, alive only for as long as a turn is actually
 * running with no prompt showing. It is a fallback for a dropped event, not
 * the delivery path — when SSE works, the tick finds nothing and costs one
 * small request.
 */

import { useEffect } from "react";

import { restorePendingInteractions } from "@/domains/chat/utils/restore-pending-interactions";
import {
  hasActiveInteraction,
  useInteractionStore,
} from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * How often to re-ask while a turn is running.
 *
 * Slow enough to be invisible next to a turn that legitimately takes minutes,
 * fast enough that a dropped approval costs seconds rather than the half-hour
 * it took to notice one by hand.
 */
export const PENDING_INTERACTION_POLL_MS = 15_000;

export interface PendingInteractionWatchdogOptions {
  assistantId: string | null | undefined;
  activeConversationId: string | null | undefined;
  /** Only "active" assistants have a daemon to ask. */
  assistantStateKind: string;
}

/**
 * True when the daemon is worth asking: a turn is in flight for this
 * conversation and the user has nothing in front of them to answer.
 *
 * Exported for tests — the decision is the whole behaviour, and driving it
 * through a real timer would test the clock instead.
 */
export function shouldPollForPendingInteraction(state: {
  activeTurnId: string | null;
  hasPrompt: boolean;
  activeConversationId: string | null;
  conversationId: string;
}): boolean {
  // No turn running: nothing is stuck, and a prompt that arrives outside a
  // turn still comes through the paths that already work.
  if (state.activeTurnId == null) return false;
  // Something is already on screen. Re-asking could only replace a live
  // prompt with a copy of itself.
  if (state.hasPrompt) return false;
  // The view moved on while the timer was pending.
  if (state.activeConversationId !== state.conversationId) return false;
  return true;
}

/**
 * Poll for a pending interaction the client never heard about.
 *
 * One timer per mounted conversation view. The tick reads store state through
 * `getState()` rather than subscribing, so a turn starting or a prompt
 * appearing does not tear the timer down and rebuild it.
 */
export function usePendingInteractionWatchdog({
  assistantId,
  activeConversationId,
  assistantStateKind,
}: PendingInteractionWatchdogOptions): void {
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }

    const conversationId = activeConversationId;
    const timer = setInterval(() => {
      const ok = shouldPollForPendingInteraction({
        activeTurnId: useTurnStore.getState().activeTurnId,
        hasPrompt: hasActiveInteraction(useInteractionStore.getState()),
        activeConversationId:
          useConversationStore.getState().activeConversationId,
        conversationId,
      });
      if (!ok) return;
      // Swallows its own failures and re-checks the active conversation
      // before applying anything.
      void restorePendingInteractions(assistantId, conversationId);
    }, PENDING_INTERACTION_POLL_MS);

    return () => clearInterval(timer);
  }, [assistantId, activeConversationId, assistantStateKind]);
}
