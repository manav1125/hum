/**
 * Approval-timeout surfacing for headless work-item runs.
 *
 * A permission prompt that nobody answers times out (default 1h) and resolves
 * DENY so the run can finish instead of blocking forever. In an interactive
 * chat that's visible — the user sees the denied step in the thread. In a
 * headless background work-item run it's a silent failure hole: the run
 * "completes", the item lands `awaiting_review` and LOOKS fine, but the
 * side-effect step (send/publish/…) never happened.
 *
 * This module records those timeouts against the owning work item so they
 * surface everywhere the item does:
 *
 *   - a `lastProgressNote` marker is stamped immediately ("⏸ Step skipped …")
 *     so live surfaces show it mid-run;
 *   - an `approval_timeout` event lands in the work-item audit trail (the
 *     durable record — the expired pending interaction itself is consumed by
 *     the prompter's timeout handler and vanishes from the awaiting-you lane,
 *     so the item must carry the full context);
 *   - the runner consumes the recorded timeouts at the terminal transition
 *     and persists a "finished with skipped steps" note instead of clearing
 *     the progress note, so the reviewed item still says what was skipped.
 *
 * The deny outcome itself is untouched — runs must never block forever — and
 * interactive prompts are unaffected: the conversation→work-item lookup only
 * matches a `running` item whose `lastRunConversationId` is the prompting
 * conversation, which is only ever true for headless runs.
 *
 * The prompter reaches this module via a lazy dynamic import (see
 * permissions/prompter.ts) so the permissions layer takes no static dependency
 * on the work-items graph.
 */

import { getLogger } from "../util/logger.js";
import { recordWorkItemEvent } from "./work-item-events.js";
import {
  findRunningWorkItemByRunConversationId,
  updateWorkItem,
} from "./work-item-store.js";

const log = getLogger("work-item-approval-timeouts");

export interface ApprovalTimeoutRecord {
  toolName: string;
  at: number;
}

/**
 * In-memory per-run registry of timed-out approvals, keyed by work-item id.
 * In-memory is sufficient: the run loop that consumes it lives in the same
 * process, and a daemon crash mid-run strands the item `running`, which the
 * startup watchdog requeues anyway (the run restarts from scratch).
 */
const pendingTimeouts = new Map<string, ApprovalTimeoutRecord[]>();

/** Mid-run marker stamped the moment a prompt expires. */
export function approvalTimeoutNote(toolName: string): string {
  return `⏸ Step skipped — approval for "${toolName}" timed out; approve and re-run to complete.`;
}

/**
 * Terminal note persisted on the item when its run finishes having skipped
 * steps. Replaces the runner's usual note-clearing so the reviewed item keeps
 * saying what silently didn't happen.
 */
export function buildSkippedStepsNote(
  records: readonly ApprovalTimeoutRecord[],
): string {
  const tools = [...new Set(records.map((r) => r.toolName))];
  const list = tools.map((t) => `"${t}"`).join(", ");
  const plural = tools.length > 1 ? "approvals" : "approval";
  return `⏸ Finished with skipped steps — ${plural} for ${list} timed out; approve and re-run to complete.`;
}

/**
 * Record a timed-out approval against the work item whose headless run owns
 * `conversationId`. Best-effort and non-throwing; returns the matched work
 * item id, or null when the conversation isn't a live work-item run (i.e. an
 * interactive prompt — deliberately a no-op).
 */
export function recordApprovalTimeoutForConversation(
  conversationId: string | undefined,
  toolName: string,
): string | null {
  if (!conversationId) return null;
  try {
    const item = findRunningWorkItemByRunConversationId(conversationId);
    if (!item) return null;

    const records = pendingTimeouts.get(item.id) ?? [];
    records.push({ toolName, at: Date.now() });
    pendingTimeouts.set(item.id, records);

    // Durable audit record — survives the run and the in-memory registry.
    recordWorkItemEvent({
      workItemId: item.id,
      kind: "approval_timeout",
      actor: "timeout",
    });

    // Immediate mid-run marker so live surfaces show the skip as it happens.
    updateWorkItem(
      item.id,
      { lastProgressNote: approvalTimeoutNote(toolName) },
      { actor: "timeout" },
    );
    // Best-effort live broadcast. Dynamic import: the runner's static import
    // graph reaches back into daemon/conversation, and this module is loaded
    // lazily from the permissions layer — keep that edge lazy too.
    void import("./work-item-runner.js")
      .then((m) => m.broadcastWorkItemStatus(item.id))
      .catch(() => {});

    log.warn(
      { workItemId: item.id, conversationId, toolName },
      "approval timed out during a headless work-item run; step skipped",
    );
    return item.id;
  } catch (err) {
    log.warn(
      { err: String(err), conversationId, toolName },
      "failed to record approval timeout on work item (ignored)",
    );
    return null;
  }
}

/**
 * Drain the recorded timeouts for a work item. The runner calls this at the
 * terminal transition to build the persistent skipped-steps note; it also
 * clears the registry so a later re-run starts clean.
 */
export function consumeApprovalTimeouts(
  workItemId: string,
): ApprovalTimeoutRecord[] {
  const records = pendingTimeouts.get(workItemId) ?? [];
  pendingTimeouts.delete(workItemId);
  return records;
}

/** Discard any stale records (called at run start so re-runs start clean). */
export function clearApprovalTimeouts(workItemId: string): void {
  pendingTimeouts.delete(workItemId);
}
