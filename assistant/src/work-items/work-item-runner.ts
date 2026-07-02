/**
 * Module-level runner for executing work items from tool context.
 *
 * Imports conversation-store and the assistant event hub directly — no
 * daemon-server callback registration needed.
 */

import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { reconcileFeedForWorkItemStatus } from "../home/feed-writer.js";
import { recordImpact } from "../home/impact-store.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import {
  extractWorkItemResult,
  resolveWorkItemRunConversationId,
} from "../runtime/routes/work-items-routes.js";
import { runTask } from "../tasks/task-runner.js";
import { getTask } from "../tasks/task-store.js";
import {
  getRegisteredToolNames,
  sanitizeToolList,
} from "../tasks/tool-sanitizer.js";
import { getLogger } from "../util/logger.js";
import { resolveRequiredTools } from "./resolve-required-tools.js";
import { recordWorkItemEvent } from "./work-item-events.js";
import {
  getWorkItem,
  updateWorkItem,
  type WorkItem,
  type WorkItemStatus,
} from "./work-item-store.js";

const log = getLogger("work-item-runner");

/** Terminal statuses we surface a `work_item_completed` event + impact for. */
type TerminalWorkItemStatus = "done" | "awaiting_review" | "failed";

/**
 * Conservative estimate of the operator time a hands-off background work-item
 * run saves: roughly the minutes it would have taken to do the task manually.
 * Kept modest and consistent with `impact-store`'s other estimates so the
 * hours-saved recap stays honest.
 */
const WORK_ITEM_MINUTES_SAVED = 8;

/**
 * Emit the inline-result completion event and record impact for a work item
 * that just reached a terminal state. Idempotency is the caller's concern —
 * see `broadcastWorkItemCompleted` usage in the runner, which fires exactly
 * once per terminal transition.
 */
function broadcastWorkItemCompleted(
  item: WorkItem,
  status: TerminalWorkItemStatus,
): void {
  const { conversationId } = resolveWorkItemRunConversationId(item);
  let summary = "";
  let highlights: string[] = [];
  if (conversationId) {
    try {
      const extracted = extractWorkItemResult(conversationId);
      summary = extracted.summary;
      highlights = extracted.highlights;
    } catch (err) {
      log.warn(
        { err: String(err), workItemId: item.id },
        "failed to extract work item result for completion event",
      );
    }
  }

  broadcastMessage({
    type: "work_item_completed",
    workItemId: item.id,
    status,
    result: {
      summary,
      highlights,
      ...(conversationId ? { conversationId } : {}),
    },
    completedAt: new Date().toISOString(),
  } as ServerMessage);

  // Record background completions in the impact recap too. Interactive actions
  // record their own impact elsewhere; background work-item runs did not, so a
  // hands-off task that finished overnight never showed up in "your week with
  // Cue". Only successful completions count — a failed run saved no time, so
  // crediting it would inflate the hours-saved number. Fire-and-forget:
  // recordImpact never throws.
  if (status !== "failed") {
    recordImpact({
      type: "work_item_completed",
      category: "other",
      minutesSaved: WORK_ITEM_MINUTES_SAVED,
      detail: `Cue handled: ${item.title}`,
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────

export function broadcastWorkItemStatus(id: string): void {
  const item = getWorkItem(id);
  if (item) {
    broadcastMessage({
      type: "work_item_status_changed",
      item: {
        id: item.id,
        taskId: item.taskId,
        title: item.title,
        status: item.status,
        lastRunId: item.lastRunId,
        lastRunConversationId: item.lastRunConversationId,
        lastRunStatus: item.lastRunStatus,
        updatedAt: item.updatedAt,
      },
    } as ServerMessage);
    // Couple the feed lifecycle: a terminal work-item dismisses its matching
    // "Run it" card so it stops lingering in the Inbound lane.
    reconcileFeedForWorkItemStatus(item);
  }
}

export interface RunWorkItemResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Run a work item in the background. Returns immediately after validation.
 * The actual execution happens asynchronously.
 *
 * When called from a chat tool (e.g. Telegram), required tools are
 * auto-approved since the user explicitly requested execution.
 */
export function runWorkItemInBackground(workItemId: string): RunWorkItemResult {
  const workItem = getWorkItem(workItemId);
  if (!workItem) {
    return {
      success: false,
      error: "Work item not found",
      errorCode: "not_found",
    };
  }

  if (workItem.status === "running") {
    return {
      success: false,
      error: "Work item is already running",
      errorCode: "already_running",
    };
  }

  const NON_RUNNABLE_STATUSES: readonly string[] = ["archived"];
  if (NON_RUNNABLE_STATUSES.includes(workItem.status)) {
    return {
      success: false,
      error: `Work item has status '${workItem.status}' and cannot be run`,
      errorCode: "invalid_status",
    };
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    return {
      success: false,
      error: `Associated task not found: ${workItem.taskId}`,
      errorCode: "no_task",
    };
  }

  // Resolve required tools — falls back to task-level tools when the
  // snapshot is empty, preventing an empty-snapshot permission bypass.
  const taskRequiredTools = task.requiredTools
    ? sanitizeToolList(JSON.parse(task.requiredTools))
    : getRegisteredToolNames();
  const requiredTools = resolveRequiredTools(
    workItem.requiredTools,
    taskRequiredTools,
  );

  // Auto-approve all required tools for chat-initiated runs.
  // The user explicitly asked to run the task, so we treat that as consent.
  const approvedTools = requiredTools;

  // Set status to running
  updateWorkItem(workItemId, { status: "running" }, { actor: "runner" });
  recordWorkItemEvent({
    workItemId,
    kind: "run_started",
    fromStatus: "queued",
    toStatus: "running",
    actor: "runner",
  });

  broadcastWorkItemStatus(workItemId);
  broadcastMessage({ type: "tasks_changed" } as ServerMessage);

  // Execute asynchronously
  let conversation: Awaited<ReturnType<typeof getOrCreateConversation>> | null =
    null;
  void (async () => {
    try {
      const result = await runTask(
        { taskId: workItem.taskId, workingDir: process.cwd(), approvedTools },
        async (conversationId, message, taskRunId) => {
          if (!conversation) {
            updateWorkItem(workItemId, {
              lastRunConversationId: conversationId,
            });
            conversation = await getOrCreateConversation(conversationId);

            broadcastMessage({
              type: "task_run_conversation_created",
              conversationId,
              workItemId,
              title: workItem.title,
            } as ServerMessage);
            conversation.taskRunId = taskRunId;
            conversation.headlessLock = true;
            // Work items are captured from the owner's own surfaces (chat,
            // voice, meetings, the web UI) — running one executes the owner's
            // request, so the run carries guardian trust, matching the
            // scheduler/watcher precedent for owner-initiated background work.
            // Without this the run's tools hit the unverified-channel guardian
            // gate and every side-effect tool is denied, so background runs
            // "complete" having done nothing. Risk gates, trust rules, and the
            // per-category autonomy policy still apply to each tool call.
            conversation.setTrustContext({
              sourceChannel: "vellum",
              trustClass: "guardian",
            });
          }
          await conversation.processMessage({
            content: message,
            attachments: [],
            onEvent: (event) => {
              broadcastMessage(event);
            },
            isInteractive: false,
          });
        },
      );

      // TS can't track that conversation is mutated inside the closure above
      const doneConversation = conversation as { headlessLock: boolean } | null;
      if (doneConversation) {
        doneConversation.headlessLock = false;
      }

      const current = getWorkItem(workItemId);
      let terminalStatus: TerminalWorkItemStatus | null = null;
      if (current?.status !== "cancelled") {
        const finalStatus: WorkItemStatus =
          result.status === "completed" ? "awaiting_review" : "failed";
        terminalStatus = finalStatus;
        updateWorkItem(
          workItemId,
          {
            status: finalStatus,
            lastRunId: result.taskRunId,
            lastRunConversationId: result.conversationId,
            lastRunStatus: result.status,
          },
          { actor: "runner" },
        );
        recordWorkItemEvent({
          workItemId,
          kind: "run_finished",
          toStatus: finalStatus,
          actor: "runner",
        });
      }

      broadcastWorkItemStatus(workItemId);
      broadcastMessage({ type: "tasks_changed" } as ServerMessage);

      // After the status change, carry the result inline so the UI doesn't
      // have to poll getWorkItemOutput(). Skip when the run was cancelled —
      // there was no terminal completion to report.
      if (terminalStatus) {
        const completed = getWorkItem(workItemId);
        if (completed) {
          broadcastWorkItemCompleted(completed, terminalStatus);
        }
      }
    } catch (err) {
      const errConversation = conversation as { headlessLock: boolean } | null;
      if (errConversation) {
        errConversation.headlessLock = false;
      }
      log.error({ err, workItemId }, "work item background run failed");
      updateWorkItem(
        workItemId,
        {
          status: "failed",
          lastRunStatus: "failed",
        },
        { actor: "runner" },
      );
      recordWorkItemEvent({
        workItemId,
        kind: "run_finished",
        toStatus: "failed",
        actor: "runner",
      });
      broadcastWorkItemStatus(workItemId);
      broadcastMessage({ type: "tasks_changed" } as ServerMessage);

      const failed = getWorkItem(workItemId);
      if (failed) {
        broadcastWorkItemCompleted(failed, "failed");
      }
    }
  })();

  return { success: true };
}
