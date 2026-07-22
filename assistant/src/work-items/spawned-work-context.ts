/**
 * The `<spawned_work>` turn-context block: what THIS conversation already
 * started.
 *
 * A commitment captured in a thread becomes a work item that runs in its own
 * run conversation. That separation is right — a long research run must not
 * block or flood a live thread — but it left the thread blind. Asked "where are
 * the results", the thread agent had no idea the work existed, apologised, and
 * re-did the whole research inline, badly. The same request executed twice, in
 * two places, at different quality.
 *
 * This block is the fix: before the agent answers, it is told what the
 * conversation spawned, what state each item is in, and — for finished items —
 * the result that already exists. So "where are the results" is answered by
 * reading, not by running the work a second time.
 *
 * Honesty rules baked into the render:
 *   - Only states the store can back up. `running` says running; it never
 *     claims a result that does not exist yet.
 *   - A finished item's summary is the run's ACTUAL final assistant text
 *     (via {@link extractWorkItemResult}); when extraction yields nothing the
 *     block says the result could not be read rather than inventing one.
 *   - Nothing is emitted when the conversation spawned nothing.
 */

import { truncate } from "../util/truncate.js";
import { extractWorkItemResult } from "./work-item-run-result.js";
import {
  listWorkItemsByOriginConversation,
  type WorkItem,
} from "./work-item-store.js";

/** Opening tag — also the strip/compaction matcher prefix. */
export const SPAWNED_WORK_BLOCK_PREFIX = "<spawned_work>";
/** Closing tag — paired with the prefix so user-authored text can't match. */
export const SPAWNED_WORK_BLOCK_SUFFIX = "</spawned_work>";

/**
 * Most items rendered in one block. A thread that spawned more than this is
 * pathological; the cap bounds per-turn tokens. Newest first, so the cut falls
 * on the stalest items.
 */
const MAX_ITEMS = 8;

/**
 * Cap on a single finished item's result summary. Long enough for the agent to
 * answer from it directly, short enough that several finished items don't
 * dominate the turn.
 */
const MAX_SUMMARY_CHARS = 700;

/** Statuses whose result is worth pulling out of the run conversation. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_review",
  "done",
]);

/** Statuses that mean work is in flight right now. */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

/** Keep untrusted item text from breaking out of the wrapper. */
function escapeBlockTag(s: string): string {
  return s.replace(/<\/spawned_work\s*>/gi, "&lt;/spawned_work&gt;");
}

/** Plain-words state line for one item — never more than the store knows. */
function stateLine(item: WorkItem): string {
  switch (item.status) {
    case "queued":
      return "queued — not started yet";
    case "running":
      return item.lastProgressNote
        ? `running now — ${escapeBlockTag(item.lastProgressNote)}`
        : "running now";
    case "awaiting_review":
      return "finished — the result is waiting in the user's Review lane";
    case "done":
      return "finished and reviewed";
    case "failed":
      return "the run FAILED — no usable result";
    case "cancelled":
      return "cancelled before it produced anything";
    default:
      return escapeBlockTag(item.status.replace(/_/g, " "));
  }
}

/**
 * Build the `<spawned_work>` block for a conversation, or `null` when it
 * spawned nothing (the quiet case — no tokens spent, no block emitted).
 *
 * `readResult` is injected for tests; production uses the same extraction the
 * Review lane and the completion event use, so the thread and the Review card
 * never disagree about what the run produced.
 */
export function buildSpawnedWorkBlock(
  conversationId: string,
  readResult: (runConversationId: string) => { summary: string } = (id) =>
    extractWorkItemResult(id),
): string | null {
  const items = listWorkItemsByOriginConversation(conversationId).slice(
    0,
    MAX_ITEMS,
  );
  if (items.length === 0) return null;

  const lines: string[] = [SPAWNED_WORK_BLOCK_PREFIX];
  lines.push(
    "Work THIS conversation already started. Each item runs in its own background run, not in this thread.",
  );
  lines.push("");

  for (const item of items) {
    lines.push(`- "${escapeBlockTag(item.title)}" — ${stateLine(item)}`);

    if (!FINISHED_STATUSES.has(item.status)) continue;

    const runConversationId = item.lastRunConversationId;
    let summary = "";
    if (runConversationId) {
      try {
        summary = readResult(runConversationId).summary.trim();
      } catch {
        summary = "";
      }
    }
    if (summary) {
      lines.push(
        `  Result: ${escapeBlockTag(truncate(summary, MAX_SUMMARY_CHARS, "…"))}`,
      );
    } else {
      // Honest degradation: the item IS finished, but the text could not be
      // read back. Say that rather than implying there is nothing.
      lines.push(
        "  Result: recorded, but could not be read back here — point the user at the Review lane instead of redoing the work.",
      );
    }
  }

  lines.push("");
  lines.push(
    "Rules: do NOT redo any of this work in this thread. If the user asks where the results are, answer from the results above and say they are in the Review lane.",
  );
  if (items.some((i) => IN_FLIGHT_STATUSES.has(i.status))) {
    lines.push(
      "For anything still queued or running, say plainly that it is still going — do not start a second copy of it.",
    );
  }
  lines.push(
    "Only start fresh work if the user asks for something these items do not already cover, or explicitly asks you to redo one.",
  );
  lines.push(SPAWNED_WORK_BLOCK_SUFFIX);

  return lines.join("\n");
}
