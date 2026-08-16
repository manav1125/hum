/**
 * Boot-time recovery for assistant turns that were in flight when the
 * previous daemon process died (deploy restart, crash, OOM kill).
 *
 * A turn reserves an empty assistant row (`reserveMessage`, content `"[]"`)
 * before streaming and finalizes it via `updateMessageContent` at
 * `message_complete`. While the LLM call is live the row carries
 * `metadata.turnInFlight = true` (stamped in `handleLlmCallStarted`,
 * cleared on every finalize/terminal path). If the process dies mid-turn,
 * the marker — and any partially-flushed content — survives in SQLite while
 * the in-memory turn machinery (abort controllers, the per-conversation
 * message queue) is gone. The result before this module existed: a
 * conversation stuck forever with an empty assistant bubble and no error.
 *
 * `recoverInterruptedTurns()` runs once at daemon startup (after DB init,
 * see `lifecycle.ts`) and:
 *
 *   1. Marks every orphaned in-flight assistant row with
 *      `metadata.interrupted = true` (+ `interruptedAt`), preserving any
 *      partially-streamed content that the debounced partial flush already
 *      persisted. Legacy orphans from before the marker existed are caught
 *      by their reserved-but-never-finalized `content === "[]"` shape.
 *   2. Broadcasts a `turn_interrupted` SSE event and a
 *      conversation-messages sync invalidation per affected conversation so
 *      connected clients refetch and render the interrupted affordance.
 *   3. Unsticks conversations whose title is still the "Generating title..."
 *      placeholder (the title sidechain died with the turn): writes the
 *      stable fallback immediately and queues an LLM regeneration pass.
 *
 * NOTE on the queued-message backlog: messages queued behind the dead turn
 * lived only in the in-memory `MessageQueue` (they are persisted to the DB
 * at drain time, not enqueue time), so the daemon cannot replay them. The
 * originating client still holds them as optimistic transcript rows keyed
 * by `clientMessageId` and re-enqueues them when it detects the
 * interruption — re-POSTing is idempotent thanks to the
 * `(conversationId, clientMessageId)` unique index.
 *
 * Startup philosophy: best-effort, never throws — a recovery failure logs
 * and the daemon continues (see assistant/CLAUDE.md).
 */

import { and, eq, isNull, like, not, or } from "drizzle-orm";

import type { TurnInterruptedEvent } from "../api/events/turn-interrupted.js";
import {
  getConversation,
  updateConversationTitle,
  updateMessageMetadata,
} from "../memory/conversation-crud.js";
import {
  AUTO_TITLE_DETERMINISTIC,
  GENERATING_TITLE,
  queueRegenerateConversationTitle,
} from "../memory/conversation-title-service.js";
import { getDb } from "../memory/db-connection.js";
import { messages } from "../memory/schema/conversations.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  publishConversationMessagesChanged,
  publishConversationTitleChanged,
} from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import {
  INTERRUPTED_METADATA_KEY,
  isUnfinalizedTurnRow,
  RESERVED_EMPTY_CONTENT,
  TURN_IN_FLIGHT_METADATA_KEY,
} from "./turn-recovery-markers.js";

const log = getLogger("turn-recovery");

export { INTERRUPTED_METADATA_KEY, TURN_IN_FLIGHT_METADATA_KEY };

/** Stable fallback used to unstick a dead "Generating title..." placeholder. */
const UNTITLED_FALLBACK_TITLE = "Untitled Conversation";

export interface TurnRecoveryResult {
  /** Assistant rows stamped `interrupted` in this sweep. */
  recoveredMessages: number;
  /** Distinct conversations that had at least one recovered row. */
  conversationIds: string[];
}

export interface RecoverInterruptedTurnsOptions {
  /**
   * Event sink for the per-conversation `turn_interrupted` broadcast.
   * Defaults to the shared `assistantEventHub`; tests inject a collector.
   */
  publishEvent?: (event: TurnInterruptedEvent) => void;
  /**
   * Whether to unstick "Generating title..." placeholders on recovered
   * conversations (fallback write + queued LLM regeneration). Defaults to
   * true; tests disable it to avoid provider lookups.
   */
  regenerateTitles?: boolean;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

/**
 * Find and mark every assistant row orphaned by a dead turn. Returns what
 * was recovered; never throws.
 */
export function recoverInterruptedTurns(
  options: RecoverInterruptedTurnsOptions = {},
): TurnRecoveryResult {
  const {
    publishEvent = (event) => {
      void assistantEventHub
        .publish(buildAssistantEvent(event, event.conversationId))
        .catch((err) =>
          log.warn(
            { err, conversationId: event.conversationId },
            "Failed to publish turn_interrupted event (non-fatal)",
          ),
        );
    },
    regenerateTitles = true,
    now = Date.now,
  } = options;

  const empty: TurnRecoveryResult = {
    recoveredMessages: 0,
    conversationIds: [],
  };

  let candidates: Array<{
    id: string;
    conversationId: string;
    content: string;
    metadata: string | null;
  }>;
  try {
    const db = getDb();
    candidates = db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        content: messages.content,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(
        and(
          eq(messages.role, "assistant"),
          or(
            // In-flight marker from handleLlmCallStarted (current daemons).
            like(messages.metadata, `%"${TURN_IN_FLIGHT_METADATA_KEY}":true%`),
            // Legacy orphans: reserved row that never received content.
            eq(messages.content, RESERVED_EMPTY_CONTENT),
          ),
          // Idempotency across restarts: skip rows already marked.
          or(
            isNull(messages.metadata),
            not(
              like(messages.metadata, `%"${INTERRUPTED_METADATA_KEY}":true%`),
            ),
          ),
        ),
      )
      .all();
  } catch (err) {
    log.warn({ err }, "Hung-turn recovery query failed — skipping sweep");
    return empty;
  }

  const interruptedAt = now();
  const recoveredByConversation = new Map<string, string[]>();

  for (const row of candidates) {
    // LIKE is an indexable prefilter only — confirm against parsed metadata
    // so a message that merely *quotes* the marker string can't be marked.
    if (!isOrphanedInFlightRow(row)) continue;
    try {
      updateMessageMetadata(row.id, {
        [TURN_IN_FLIGHT_METADATA_KEY]: undefined,
        [INTERRUPTED_METADATA_KEY]: true,
        interruptedAt,
      });
    } catch (err) {
      log.warn(
        { err, messageId: row.id, conversationId: row.conversationId },
        "Failed to mark interrupted assistant row (non-fatal)",
      );
      continue;
    }
    const ids = recoveredByConversation.get(row.conversationId) ?? [];
    ids.push(row.id);
    recoveredByConversation.set(row.conversationId, ids);
  }

  let recoveredMessages = 0;
  for (const [conversationId, messageIds] of recoveredByConversation) {
    recoveredMessages += messageIds.length;
    log.info(
      { conversationId, messageIds },
      "Recovered interrupted in-flight turn → marked assistant row(s) interrupted",
    );

    // SSE-visible signals: the explicit event for connected clients, plus a
    // messages sync invalidation so clients that reconnect later refetch the
    // transcript (and see the durable `interrupted` metadata).
    for (const messageId of messageIds) {
      try {
        publishEvent({
          type: "turn_interrupted",
          conversationId,
          messageId,
          interruptedAt,
          reason: "daemon_restart",
        });
      } catch (err) {
        log.warn(
          { err, conversationId, messageId },
          "turn_interrupted publish threw (non-fatal)",
        );
      }
    }
    try {
      publishConversationMessagesChanged(conversationId);
    } catch {
      // Best-effort — clients still catch up via normal refetch.
    }

    if (regenerateTitles) {
      unstickGeneratingTitle(conversationId);
    }
  }

  return {
    recoveredMessages,
    conversationIds: [...recoveredByConversation.keys()],
  };
}

/** Confirm a LIKE-prefiltered candidate is genuinely an orphaned row. */
function isOrphanedInFlightRow(row: {
  content: string;
  metadata: string | null;
}): boolean {
  let meta: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed metadata — fall through to the content check.
    }
  }
  if (meta[INTERRUPTED_METADATA_KEY] === true) return false;
  // The query already restricted to assistant rows.
  return isUnfinalizedTurnRow({ ...row, role: "assistant", metadata: meta });
}

/**
 * A turn that died before its first assistant text also killed the title
 * sidechain, leaving the conversation stuck on the "Generating title..."
 * placeholder forever. Write the stable fallback now (deterministic, so a
 * later pass may still upgrade it) and queue an LLM regeneration.
 */
function unstickGeneratingTitle(conversationId: string): void {
  try {
    const conversation = getConversation(conversationId);
    if (!conversation || conversation.title !== GENERATING_TITLE) return;
    updateConversationTitle(
      conversationId,
      UNTITLED_FALLBACK_TITLE,
      AUTO_TITLE_DETERMINISTIC,
    );
    publishConversationTitleChanged(conversationId, UNTITLED_FALLBACK_TITLE);
    queueRegenerateConversationTitle({ conversationId });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to unstick placeholder title on recovered conversation (non-fatal)",
    );
  }
}
