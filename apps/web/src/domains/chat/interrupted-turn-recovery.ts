/**
 * Client-side recovery for turns killed by a daemon restart.
 *
 * The daemon's per-conversation message queue is in-memory only (messages
 * are persisted at drain time, not enqueue time), so when a deploy/crash
 * kills an in-flight turn every message queued behind it evaporates
 * server-side. This client still holds those messages as optimistic
 * transcript rows (`queueStatus: "queued"`, never echoed back), so we can
 * re-enqueue them: each re-POST carries the row's original
 * `clientMessageId`, which the daemon dedupes on the
 * `(conversationId, clientMessageId)` unique index — if the message *did*
 * land before the crash the daemon returns the existing row instead of
 * duplicating it, making the resend idempotent.
 *
 * Triggered from two places:
 *   - `handleTurnInterrupted` (SSE `turn_interrupted`) for clients that were
 *     connected when the recovered daemon broadcast the event, and
 *   - `useInterruptedTurnRecovery` for the common case where the client
 *     reconnects *after* boot recovery ran and discovers the interruption
 *     via the refetched transcript (`DisplayMessage.interrupted`).
 *
 * `markMessageInterrupted` is the shared transcript updater both paths use.
 */

import { postChatMessage } from "@/domains/chat/api/messages";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { clearQueueStatus } from "@/domains/chat/utils/stream-updaters/shared";
import { recordDiagnostic } from "@/lib/diagnostics";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Rows whose re-enqueue has already been attempted this session, keyed by
 * `clientMessageId` (falling back to the row id). Guards against resend
 * loops when the interruption signal fires more than once (SSE event +
 * refetch discovery, or repeated reconnects while the daemon flaps).
 */
const attemptedResends = new Set<string>();

/** Test-only: reset the per-session resend guard. */
export function _resetAttemptedResendsForTesting(): void {
  attemptedResends.clear();
}

/** Mark the transcript row for an interrupted turn. Pure updater. */
export function markMessageInterrupted(
  messages: DisplayMessage[],
  messageId: string,
): DisplayMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== messageId && !m.mergedMessageIds?.includes(messageId)) {
      return m;
    }
    if (m.interrupted) return m;
    changed = true;
    return { ...m, interrupted: true };
  });
  return changed ? next : messages;
}

/** The stale-queued predicate: a user row still optimistically queued. */
function isStaleQueuedRow(m: DisplayMessage): boolean {
  return m.role === "user" && m.queueStatus === "queued";
}

/**
 * Re-enqueue every stale queued row for the active conversation. Safe to
 * call repeatedly — rows are attempted at most once per session and the
 * daemon dedupes on `clientMessageId`. Rows are re-POSTed in queue order so
 * the daemon processes them in the order the user sent them.
 */
export async function resendStaleQueuedMessages(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const store = useChatSessionStore.getState();
  const staleRows = store.messages
    .filter(isStaleQueuedRow)
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  if (staleRows.length === 0) return;

  for (const row of staleRows) {
    const resendKey = row.clientMessageId ?? row.id;
    if (attemptedResends.has(resendKey)) continue;
    attemptedResends.add(resendKey);

    const content = messagePlainText(row);
    const attachmentIds = (row.attachments ?? [])
      .map((a) => a.id)
      .filter((id): id is string => Boolean(id));
    if (!content.trim() && attachmentIds.length === 0) continue;

    try {
      const result = await postChatMessage(
        assistantId,
        conversationId,
        content,
        attachmentIds,
        undefined,
        row.clientMessageId,
      );
      if (!result.ok) {
        recordDiagnostic("interrupted_queue_resend_failed", {
          assistantId,
          conversationId,
          code: result.error.code,
        });
        continue;
      }
      recordDiagnostic("interrupted_queue_resend", {
        assistantId,
        conversationId,
        queued: result.queued,
      });
      if (result.queued && result.requestId) {
        // Re-key the row to its fresh daemon request id so the normal
        // dequeue/delete SSE flow drives it from here.
        useChatSessionStore
          .getState()
          .setRequestIdMapping(result.requestId, row.id);
      } else {
        // The daemon was idle and started processing immediately — the row
        // is no longer queued. The SSE stream delivers the turn.
        useChatSessionStore
          .getState()
          .setMessages((prev) => clearQueueStatus(prev, row.id));
      }
    } catch (err) {
      captureError(err, { context: "interrupted_queue_resend" });
    }
  }
}
