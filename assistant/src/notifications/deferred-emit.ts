/**
 * Per-conversation notification buffer used to keep a background job's
 * "success" notification from racing the runner's `activity.failed` when
 * the job times out after the model already invoked `notifications send`.
 *
 * `registerDeferredConversation` arms the buffer before the LLM turn.
 * `bufferIfDeferred` is called from the IPC route handler — it buffers when
 * armed, swallows when tombstoned (post-discard grace window), and returns
 * null otherwise so the route emits normally.
 * `commitDeferredConversation` flushes on success; `discardDeferredConversation`
 * withholds on failure — returning the signals so the runner can fold them into
 * the failure notice rather than losing them — and tombstones briefly to catch
 * late tool calls that arrive after `processMessage` keeps running past the
 * runner's timeout.
 */

import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import {
  emitNotificationSignal,
  type EmitSignalParams,
  type EmitSignalResult,
} from "./emit-signal.js";

const log = getLogger("notifications-deferred-emit");

// How long after the last observed late notification we keep the tombstone
// alive. `work` in `runBackgroundJob` is not cancelled on timeout — it can
// continue running and emit skill calls indefinitely. We refresh the timer
// on every late arrival, so the tombstone persists as long as the turn is
// still draining and only expires once the conversation has been quiet for
// this long.
const TOMBSTONE_TTL_MS = 5 * 60 * 1000;

type BufferEntry =
  | { state: "buffered"; items: EmitSignalParams<string>[] }
  | { state: "tombstoned"; timer: ReturnType<typeof setTimeout> };

const buffers = new Map<string, BufferEntry>();

function scheduleTombstoneEviction(
  conversationId: string,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const cur = buffers.get(conversationId);
    if (cur?.state === "tombstoned") buffers.delete(conversationId);
  }, TOMBSTONE_TTL_MS);
  timer.unref?.();
  return timer;
}

export function registerDeferredConversation(conversationId: string): void {
  buffers.set(conversationId, { state: "buffered", items: [] });
}

/**
 * Buffer the signal when the originating conversation is armed, swallow it
 * when tombstoned, otherwise return null so the caller emits normally.
 */
export function bufferIfDeferred(
  originatingConversationId: string | undefined,
  params: EmitSignalParams<string>,
): EmitSignalResult | null {
  if (!originatingConversationId) return null;
  const entry = buffers.get(originatingConversationId);
  if (!entry) return null;
  if (entry.state === "tombstoned") {
    // Refresh the eviction timer so the tombstone outlives any continuing
    // turn activity. Otherwise a long-running orphan `processMessage` could
    // emit a `notifications send` after the fixed TTL elapsed and bypass
    // buffering, recreating the "success + activity.failed" contradiction.
    clearTimeout(entry.timer);
    entry.timer = scheduleTombstoneEviction(originatingConversationId);
    return {
      signalId: uuid(),
      deduplicated: false,
      dispatched: false,
      reason: "Notification dropped: background job did not complete",
      deliveryResults: [],
    };
  }
  entry.items.push(params);
  return {
    signalId: uuid(),
    deduplicated: false,
    dispatched: false,
    reason: "Notification deferred until background job completes",
    deliveryResults: [],
  };
}

export async function commitDeferredConversation(
  conversationId: string,
): Promise<void> {
  const entry = buffers.get(conversationId);
  if (!entry || entry.state !== "buffered") return;
  buffers.delete(conversationId);
  for (const params of entry.items) {
    try {
      await emitNotificationSignal(params);
    } catch (err) {
      log.warn(
        { err, conversationId },
        "Buffered notification failed to emit on commit",
      );
    }
  }
}

/**
 * Withhold any buffered signals and tombstone the conversation, returning the
 * withheld signals to the caller. The tombstone persists until the turn has
 * been quiet for `TOMBSTONE_TTL_MS`; each late notification observed via
 * `bufferIfDeferred` refreshes the timer.
 *
 * The signals are returned rather than simply dropped because dropping them
 * outright loses information the user needs. A job can finish real work — send
 * the email, file the report — announce it via `notifications send`, and only
 * then time out on a later step. Emitting the announcement as-is would claim a
 * success that did not happen; silently discarding it leaves the user unaware
 * that the email went out at all, which is how you get it sent twice. The
 * caller folds these into the failure notification instead, so one message
 * carries both facts: the job did not finish, and this is what it reported
 * before it stopped.
 */
export function discardDeferredConversation(
  conversationId: string,
): EmitSignalParams<string>[] {
  const entry = buffers.get(conversationId);
  if (!entry) return [];
  const withheld = entry.state === "buffered" ? entry.items : [];
  if (entry.state === "tombstoned") clearTimeout(entry.timer);
  buffers.set(conversationId, {
    state: "tombstoned",
    timer: scheduleTombstoneEviction(conversationId),
  });
  if (withheld.length > 0) {
    log.info(
      { conversationId, withheldCount: withheld.length },
      "Withheld buffered notifications for failed background job",
    );
  }
  return withheld;
}

/**
 * Best-effort human-readable lines for what a job reported before it failed.
 * Bounded in both count and length — this rides along in a notification
 * payload, not a log. Falls back to the event name when the payload carries no
 * recognisable text, so a signal is never represented as nothing at all.
 */
export function summarizeWithheldSignals(
  signals: EmitSignalParams<string>[],
  limit = 3,
): string[] {
  return signals.slice(0, limit).map((signal) => {
    const payload = signal.contextPayload as
      | Record<string, unknown>
      | undefined;
    // `requestedTitle` / `requestedMessage` are what the notifications skill
    // actually writes (cli/commands/notifications.ts) and what the decision
    // engine reads back as the verbatim body; the rest are fallbacks for other
    // producers.
    for (const key of [
      "requestedTitle",
      "requestedMessage",
      "title",
      "summary",
      "body",
      "message",
      "text",
    ]) {
      const value = payload?.[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, 200);
      }
    }
    return signal.sourceEventName;
  });
}

/** @internal Test-only reset hook. */
export function resetDeferredForTest(): void {
  buffers.clear();
}
