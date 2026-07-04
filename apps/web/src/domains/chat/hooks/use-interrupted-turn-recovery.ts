/**
 * Refetch-path discovery of interrupted turns.
 *
 * The daemon's boot-recovery sweep broadcasts `turn_interrupted` when it
 * runs, but the common client was disconnected at that moment (its SSE
 * dropped with the dying daemon) — it learns about the interruption from
 * the refetched transcript instead: the recovered assistant row comes back
 * with `interrupted: true` (see `map-runtime-message.ts`).
 *
 * When that discovery lands and the conversation's tail is the interrupted
 * row, any local rows still marked `queueStatus: "queued"` are stranded —
 * the daemon's in-memory queue died with the old process — so re-enqueue
 * them (idempotent via `clientMessageId`; see
 * `interrupted-turn-recovery.ts`).
 *
 * Gating:
 *  - the LAST assistant message must be the interrupted one (an interrupted
 *    row deeper in history means the conversation already moved on — its
 *    queue state belongs to the live daemon, never resend then), and
 *  - no turn may be in flight locally.
 */

import { useEffect } from "react";

import { resendStaleQueuedMessages } from "@/domains/chat/interrupted-turn-recovery";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

export function useInterruptedTurnRecovery({
  assistantId,
  activeConversationId,
  messages,
}: {
  assistantId: string | null;
  activeConversationId: string | null;
  messages: DisplayMessage[];
}): void {
  useEffect(() => {
    if (!assistantId || !activeConversationId) return;
    if (isSending(useTurnStore.getState().phase)) return;

    const lastAssistant = messages.findLast((m) => m.role === "assistant");
    if (!lastAssistant?.interrupted) return;

    const hasStaleQueued = messages.some(
      (m) => m.role === "user" && m.queueStatus === "queued",
    );
    if (!hasStaleQueued) return;

    void resendStaleQueuedMessages(assistantId, activeConversationId);
  }, [assistantId, activeConversationId, messages]);
}
