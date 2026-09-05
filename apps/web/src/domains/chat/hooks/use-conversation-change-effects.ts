/**
 * Consolidates side effects that fire when `activeConversationId` changes:
 *
 * - Reset subagent tracking state (needed for URL-navigation paths that
 *   bypass the `switchConversation` / `startNewConversation` wrappers)
 * - Auto-fetch detail for subagents reconstructed from conversation history
 *   (entries with a `conversationId` but no events yet)
 * - Refresh the conversation's list row from the server, so run state
 *   (`isProcessing`) is re-derived on every entry rather than trusted from
 *   the cache
 *
 * Note: interaction store cleanup (`dismissQuestion`, `resetAll`) is NOT
 * handled here — `switchToConversation()` in `chat-session-store` already
 * calls `useInteractionStore.getState().resetAll()` on every conversation
 * switch, covering both wrapper-initiated and URL-navigation paths.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { captureError } from "@/lib/sentry/capture-error";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { findConversation } from "@/utils/conversation-cache";
import { refreshConversationRow } from "@/utils/conversation-cache-mutations";

export function useConversationChangeEffects(
  assistantId: string | null,
  activeConversationId: string | null,
): void {
  const queryClient = useQueryClient();

  // Reset subagent tracking on conversation change. The wrapper-initiated
  // path (`switchConversation` / `startNewConversation`) also resets eagerly
  // to prevent stale UI flashes — the double-reset is harmless (idempotent).
  // This effect catches the URL-navigation path where wrappers don't run.
  useEffect(() => {
    useSubagentStore.getState().reset();
  }, [activeConversationId]);

  // Re-derive the conversation's run state from the server on every entry.
  // The cached row's `isProcessing` flag is kept fresh by the SSE turn
  // lifecycle ONLY while a consumer for this conversation is mounted — a
  // terminal event that lands while the user is on the chats list (or while
  // the stream is down) is dropped, latching `isProcessing: true` in the
  // cache. The Working banner derives from that flag (`fallbackActive` via
  // `useActiveConversationIsProcessing`), so without this refresh a
  // re-opened conversation shows a live-looking spinner for a run that
  // already finished. Best-effort: a failure keeps the cached row, and the
  // SSE reconcile paths remain the primary catch-up while connected.
  useEffect(() => {
    if (!assistantId || !activeConversationId) return;
    // Only a CACHED row can be stale. When no cache holds the row (a
    // background/scheduled deep-link, or a brand-new draft key that has no
    // server row at all), `useActiveConversation` fetches it fresh from the
    // server already — and refreshing a draft key here would 404 and evict
    // the optimistic sidebar row.
    const cached = findConversation(
      queryClient,
      assistantId,
      activeConversationId,
    );
    if (!cached || cached.draft === true) return;
    void refreshConversationRow(
      queryClient,
      assistantId,
      activeConversationId,
    ).catch((error) => {
      captureError(error, {
        context: "useConversationChangeEffects.refreshRow",
        bestEffort: true,
      });
    });
  }, [assistantId, activeConversationId, queryClient]);

  // Stable signal: changes only when the set of subagent IDs that need a
  // detail fetch changes (entry appears with conversationId + no events,
  // or an entry receives events). Immune to loadDetail calls that update
  // status/objective without changing events, preventing retrigger loops.
  const unfetchedSubagentKey = useSubagentStore((s) => {
    const ids: string[] = [];
    for (const entry of Object.values(s.byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        ids.push(entry.subagentId);
      }
    }
    return ids.sort().join(",");
  });

  // Auto-fetch details for subagents reconstructed from history
  useEffect(() => {
    if (!assistantId || !unfetchedSubagentKey) return;
    for (const entry of Object.values(useSubagentStore.getState().byId)) {
      if (entry.conversationId && entry.events.length === 0) {
        void useSubagentStore
          .getState()
          .fetchDetailIfNeeded(assistantId, entry.subagentId);
      }
    }
  }, [assistantId, unfetchedSubagentKey]);
}
