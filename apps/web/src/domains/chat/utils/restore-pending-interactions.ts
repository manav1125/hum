/**
 * Reconcile the client's pending-interaction prompts against the daemon.
 *
 * The daemon announces approvals over SSE (`confirmation_request`), and the
 * client renders the prompt from that event. When the event doesn't land the
 * prompt never appears and the run sits "Working" with nothing to click; when
 * the interaction is resolved or swept server-side while a prompt is already
 * on screen, the button stays live and answering it 404s ("That didn't go
 * through"). Both are the same failure — a client view that only ever moves
 * forward on events — so both are fixed by re-asking the daemon what is
 * actually pending and matching it.
 *
 * Pending interactions live in an in-memory map on the daemon
 * (`runtime/pending-interactions.ts`), so a daemon restart drops every
 * in-flight approval. This pass is what makes that legible to the user: the
 * orphaned prompt is cleared rather than left as a button that cannot work.
 *
 * Safe to call repeatedly. Bails if the user switched conversations while the
 * fetch was in flight, and never clears a prompt other than the one it saw.
 */

import { getPendingInteractions } from "@/domains/chat/api/interactions";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/utils/send-message-utils";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Pull the daemon's pending interactions for `conversationId` and make the
 * local prompt state match. Never throws — a failed pass leaves the current
 * prompts (and the conversation's attention key) exactly as they were, so a
 * transient fetch error can't dismiss a live approval.
 */
export async function restorePendingInteractions(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  try {
    const interactions = await getPendingInteractions(
      assistantId,
      conversationId,
    );
    // The user may have moved on while this was in flight; applying it now
    // would show one conversation's approval on top of another.
    if (
      useConversationStore.getState().activeConversationId !== conversationId
    ) {
      return;
    }

    const parsedSecret = interactions.pendingSecret
      ? parsePendingSecretState(
          interactions.pendingSecret as Record<string, unknown>,
        )
      : null;
    if (parsedSecret) {
      useInteractionStore.getState().showSecret(parsedSecret);
    }

    const shownConfirmation =
      useInteractionStore.getState().pendingConfirmation;
    if (interactions.pendingConfirmation) {
      if (!shownConfirmation) {
        const { state } = parsePendingConfirmationData(
          interactions.pendingConfirmation as Record<string, unknown>,
        );
        useInteractionStore.getState().showConfirmation(state);
      }
    } else if (shownConfirmation) {
      // The daemon has no record of this approval — it was resolved
      // elsewhere, swept, or lost to a restart. Leaving the button up would
      // give the user a control whose only outcome is a 404.
      useInteractionStore
        .getState()
        .dismissConfirmationIfMatches(shownConfirmation.requestId);
    }

    if (!interactions.pendingSecret && !interactions.pendingConfirmation) {
      useConversationStore
        .getState()
        .removeAttentionConversationId(conversationId);
    }
  } catch {
    // Keep the attention key and any on-screen prompt on failure.
  }
}
