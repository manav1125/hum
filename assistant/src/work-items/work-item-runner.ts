/**
 * Module-level runner for executing work items from tool context.
 *
 * Imports conversation-store and the assistant event hub directly — no
 * daemon-server callback registration needed.
 */

import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { buildAgentToolScopeFilter } from "../guardrails/agent-tool-scopes.js";
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
import {
  recordActForCompletedRun,
  reverseLatestActForWorkItem,
} from "./agent-act-store.js";
import { getAgentByAssignee } from "./agent-store.js";
import {
  ensureProjectKnowledgeFiles,
  type MaterializedProjectKnowledge,
} from "./project-knowledge-store.js";
import { getProject } from "./project-store.js";
import { resolveRequiredTools } from "./resolve-required-tools.js";
import { recordWorkItemEvent } from "./work-item-events.js";
import {
  getWorkItem,
  updateWorkItem,
  type WorkItem,
  type WorkItemStatus,
} from "./work-item-store.js";
import { registerOutputsForCompletedRun } from "./work-output-store.js";

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
        lastProgressNote: item.lastProgressNote,
        updatedAt: item.updatedAt,
      },
    } as ServerMessage);
    // Couple the feed lifecycle: a terminal work-item dismisses its matching
    // "Run it" card so it stops lingering in the Inbound lane.
    reconcileFeedForWorkItemStatus(item);
  }
}

// ── Mid-run progress notes ───────────────────────────────────────────

/**
 * Human-readable one-liner for a tool that just started, mirroring the chat
 * client's live-status vocabulary ("Searching …", "Reading example.com") so
 * the Activity board's running rows read like the thread would.
 */
export function progressNoteForToolStart(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "web_search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return "Searching the web";
    const truncated = query.length > 60 ? `${query.slice(0, 57)}...` : query;
    return `Searching "${truncated}"`;
  }
  if (toolName === "web_fetch") {
    if (typeof input.url === "string") {
      try {
        return `Reading ${new URL(input.url).hostname}`;
      } catch {
        // fall through to the generic label
      }
    }
    return "Reading a page";
  }
  if (
    toolName === "skill_execute" &&
    typeof input.activity === "string" &&
    input.activity.trim().length > 0
  ) {
    return input.activity.trim();
  }
  return `Running ${toolName.replace(/_/g, " ")}`;
}

/**
 * Stamp the latest activity line onto a running work item, deduplicated so a
 * burst of identical tool starts doesn't spam DB writes. Best-effort — a
 * failed stamp never breaks the run.
 */
function stampProgressNote(
  workItemId: string,
  note: string,
  lastNoteRef: { current: string | null },
): void {
  if (note === lastNoteRef.current) return;
  lastNoteRef.current = note;
  try {
    updateWorkItem(workItemId, { lastProgressNote: note });
    broadcastWorkItemStatus(workItemId);
  } catch (err) {
    log.debug(
      { err: String(err), workItemId },
      "failed to stamp work-item progress note (ignored)",
    );
  }
}

export interface RunWorkItemResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

function formatKnowledgeSize(sizeBytes: number | null): string {
  if (sizeBytes == null) return "";
  if (sizeBytes < 1024) return `, ${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `, ${(sizeBytes / 1024).toFixed(1)} KB`;
  return `, ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the project-knowledge section of the run preamble: attached files
 * (already materialized inside the agent's sandbox boundary, listed with the
 * exact paths its file tools can read) plus reference links. Returns "" when
 * the project has no knowledge.
 */
function buildProjectKnowledgeSection(
  entries: MaterializedProjectKnowledge[],
): string {
  const files = entries.filter((e) => e.kind === "file" && e.absPath);
  const links = entries.filter((e) => e.kind === "link" && e.url);
  if (files.length === 0 && links.length === 0) return "";

  const lines: string[] = ["### Project knowledge"];
  if (files.length > 0) {
    lines.push(
      "The project has reference files attached. They are on disk at the paths below — read them with the file_read tool (or bash) whenever they are relevant to the task:",
      ...files.map(
        (f) =>
          `- ${f.label} — ${f.absPath}${
            f.mimeType
              ? ` (${f.mimeType}${formatKnowledgeSize(f.sizeBytes)})`
              : ""
          }`,
      ),
    );
  }
  if (links.length > 0) {
    if (files.length > 0) lines.push("");
    lines.push(
      "Reference links attached to the project:",
      ...links.map((l) => `- ${l.label} — ${l.url}`),
    );
  }
  return lines.join("\n");
}

/**
 * Build the cowork context preamble prepended to a work item's run message.
 * This is how cowork "extends context per project/task": before the agent
 * sees the task template, it reads (a) the parent project's brief/instructions
 * that apply to every task in the project, (b) the project's knowledge — file
 * attachments materialized into the sandbox so the agent can actually read
 * them, plus reference links — and (c) the task's own user-added context.
 * Returns "" when the item carries none of these, so plain items run exactly
 * as before.
 */
export function buildWorkItemContextPreamble(item: WorkItem): string {
  const sections: string[] = [];

  if (item.projectId) {
    const project = getProject(item.projectId);
    if (project) {
      const header = `## Project: ${project.title}`;
      const brief = project.context?.trim();
      sections.push(brief ? `${header}\n${brief}` : header);

      // Project knowledge — never let a knowledge failure break the run.
      try {
        const knowledge = buildProjectKnowledgeSection(
          ensureProjectKnowledgeFiles(project.id),
        );
        if (knowledge) sections.push(knowledge);
      } catch (err) {
        log.warn(
          { err: String(err), projectId: project.id, workItemId: item.id },
          "failed to resolve project knowledge for run preamble (skipped)",
        );
      }
    }
  }

  const taskContext = item.context?.trim();
  if (taskContext) {
    sections.push(`## Task context\n${taskContext}`);
  }

  if (sections.length === 0) return "";
  return [
    "You are working a task inside a project. Use the following context to inform how you carry it out.",
    "",
    sections.join("\n\n"),
    "",
    "---",
    "",
  ].join("\n");
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

  // Act-ledger redo signal: re-running an item that already reached
  // awaiting_review/done means the earlier completed act wasn't accepted —
  // mark that act reversed before this run overwrites the item's state.
  // Sits in the runner (not the HTTP route) so chat-tool and CLI redos count
  // too. Observation-only: reverseLatestActForWorkItem never throws.
  if (workItem.status === "awaiting_review" || workItem.status === "done") {
    reverseLatestActForWorkItem(workItem.id);
  }

  // Cowork context: the parent project's brief + the task's own context,
  // computed once up front and prepended to the run message so the agent reads
  // per-project/per-task instructions before executing.
  const contextPreamble = buildWorkItemContextPreamble(workItem);

  // Guardrails per-agent model pin: a background run executes as the item's
  // assignee; when that agent pins a model, the run conversation is created
  // with the existing `modelOverride` mechanism — an explicit per-call model
  // that wins over profile/call-site resolution in the provider layer
  // (RetryProvider.normalizeSendMessageOptions treats config.model as
  // authoritative). Null assignee = the house agent "cue" (never pinned).
  // Resolved once up front so every turn of the run uses the same model.
  const runAgent = getAgentByAssignee(workItem.assignee);
  const pinnedModel = runAgent?.model ?? null;
  // Guardrails agent tool scopes: when the run agent carries `tool_scopes`,
  // the run conversation gets a tool filter — out-of-scope domain tools are
  // dropped from the wire definitions and rejected at execution time. Null
  // scopes (and the implicit house agent) = unrestricted.
  const toolScopeFilter = runAgent?.toolScopes
    ? buildAgentToolScopeFilter(runAgent.toolScopes)
    : null;

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
  // Latest stamped progress note, so identical consecutive tool starts don't
  // trigger redundant DB writes/broadcasts.
  const lastProgressNote: { current: string | null } = { current: null };
  // Distinct tool names the run's agent loop started — the tool-mix signal
  // the act ledger's minutes-saved heuristic reads at completion.
  const toolsUsed = new Set<string>();
  void (async () => {
    try {
      const result = await runTask(
        { taskId: workItem.taskId, workingDir: process.cwd(), approvedTools },
        async (conversationId, message, taskRunId) => {
          if (!conversation) {
            updateWorkItem(workItemId, {
              lastRunConversationId: conversationId,
            });
            conversation = await getOrCreateConversation(
              conversationId,
              pinnedModel ? { modelOverride: pinnedModel } : undefined,
            );

            broadcastMessage({
              type: "task_run_conversation_created",
              conversationId,
              workItemId,
              title: workItem.title,
            } as ServerMessage);
            conversation.taskRunId = taskRunId;
            conversation.headlessLock = true;
            if (toolScopeFilter) {
              conversation.toolScopeFilter = toolScopeFilter;
            }
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
            content: contextPreamble ? `${contextPreamble}${message}` : message,
            attachments: [],
            onEvent: (event) => {
              broadcastMessage(event);
              // Surface mid-run progress: each tool start becomes the item's
              // live activity line ("Searching the web…") so the Activity/
              // Projects boards show what a running task is actually doing.
              const e = event as {
                type?: string;
                toolName?: string;
                input?: Record<string, unknown>;
              };
              if (
                e.type === "tool_use_start" &&
                typeof e.toolName === "string"
              ) {
                toolsUsed.add(e.toolName);
                stampProgressNote(
                  workItemId,
                  progressNoteForToolStart(e.toolName, e.input ?? {}),
                  lastProgressNote,
                );
              }
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
            // The run is over — a stale "Searching the web…" line must not
            // linger on a finished item.
            lastProgressNote: null,
          },
          { actor: "runner" },
        );
        recordWorkItemEvent({
          workItemId,
          kind: "run_finished",
          toStatus: finalStatus,
          actor: "runner",
        });

        // Sprint-outputs capture: a completed run's tool-produced attachments
        // are already linked to the run conversation's assistant messages, so
        // register them as first-class work outputs here — the one place that
        // knows the work item ↔ run conversation binding AND the terminal
        // status. Failed runs are skipped (half-baked artifacts aren't
        // deliverables). registerOutputsForCompletedRun never throws and is
        // idempotent per (work item, attachment).
        let outputCount = 0;
        if (finalStatus !== "failed" && result.conversationId) {
          const outputs = registerOutputsForCompletedRun(
            current ?? workItem,
            result.conversationId,
          );
          outputCount = outputs.length;
          if (outputs.length > 0) {
            log.info(
              { workItemId, outputCount: outputs.length },
              "registered work outputs for completed run",
            );
          }
        }

        // Act ledger: a non-failed terminal run is one completed autonomous
        // act — record it beside the outputs registration with a conservative
        // minutes-saved estimate from the run's tool-mix + deliverables, the
        // item's title (so the ledger names what was done), and the run
        // conversation id (the cost/model attribution key).
        // Failed runs are not acts (nothing was accomplished to reverse).
        // Observation-only: recordActForCompletedRun never throws.
        if (finalStatus !== "failed") {
          recordActForCompletedRun(current ?? workItem, {
            toolsUsed,
            outputCount,
            runConversationId: result.conversationId ?? null,
          });
        }
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
          lastProgressNote: null,
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
