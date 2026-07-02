/**
 * Route handlers for work item (task queue) operations.
 *
 * Exposes all work item CRUD and lifecycle operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/work-items.ts`.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { reconcileFeedForWorkItemStatus } from "../../home/feed-writer.js";
import { getMessages } from "../../memory/conversation-crud.js";
import { check, classifyRisk } from "../../permissions/checker.js";
import { getSubagentManager } from "../../subagent/index.js";
import { getTask, getTaskRun } from "../../tasks/task-store.js";
import {
  getRegisteredToolNames,
  getToolDescription,
  sanitizeToolList,
} from "../../tasks/tool-sanitizer.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { truncate } from "../../util/truncate.js";
import { resolveRequiredTools } from "../../work-items/resolve-required-tools.js";
import {
  cycleTimeMs,
  listWorkItemEvents,
  recordWorkItemEvent,
} from "../../work-items/work-item-events.js";
import { runWorkItemInBackground } from "../../work-items/work-item-runner.js";
import {
  deleteWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItemStatus,
} from "../../work-items/work-item-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

/**
 * Typed wire shape for a work item — shared by the work-items and projects
 * routes so the generated web SDK gets real fields instead of `unknown`.
 */
export const workItemSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  priorityTier: z.number().int(),
  sortIndex: z.number().int().nullable(),
  projectId: z.string().nullable(),
  dueAt: z.number().int().nullable().describe("Due deadline, epoch ms"),
  labels: z.string().nullable().describe("JSON array string of labels"),
  assignee: z
    .string()
    .nullable()
    .describe('"cue" | "you" | contact name; null reads as "cue"'),
  lastRunId: z.string().nullable(),
  lastRunConversationId: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  approvalStatus: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

function broadcastWorkItemStatus(id: string): void {
  const item = getWorkItem(id);
  if (item) {
    publishEvent({
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
    });
    // Couple the feed lifecycle: a terminal work-item dismisses its matching
    // "Run it" card so it stops lingering in the Inbound lane.
    reconcileFeedForWorkItemStatus(item);
  }
}

// ---------------------------------------------------------------------------
// Shared business logic: extracting output from a work item run
// ---------------------------------------------------------------------------

/**
 * Extract only the latest assistant text block from stored content.
 * Consolidation merges multiple assistant messages into one DB row; scanning
 * from the end keeps task output focused on the final assistant response.
 */
function extractLatestTextFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const block = parsed[i] as { type?: unknown; text?: unknown };
        if (block.type !== "text") continue;
        if (typeof block.text !== "string") continue;
        if (!block.text.trim()) continue;
        return block.text;
      }
      return "";
    }
  } catch {
    // Plain text content — use as-is
  }
  return content;
}

/** Extract tool_result blocks from a user message's content. */
function extractToolResults(
  content: string,
): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === "tool_result")
        .map(
          (b: {
            tool_use_id: string;
            content?: string | Array<{ type: string; text?: string }>;
            is_error?: boolean;
          }) => {
            let text = "";
            if (typeof b.content === "string") {
              text = b.content;
            } else if (Array.isArray(b.content)) {
              text = b.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!)
                .join("\n");
            }
            return {
              tool_use_id: b.tool_use_id,
              content: text,
              is_error: b.is_error,
            };
          },
        );
    }
  } catch {
    // Not JSON — no tool_result blocks
  }
  return [];
}

/**
 * Build highlights from tool outcomes in the conversation. Scans for
 * tool_use (assistant) and tool_result (user) pairs, extracting concrete
 * outcomes like errors, file paths, and URLs.
 */
function extractToolHighlights(
  msgs: Array<{ role: string; content: string }>,
  maxHighlights: number,
): string[] {
  const highlights: string[] = [];

  // Build a map of tool_use_id -> tool name from assistant messages
  const toolNameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed)) {
        for (const block of parsed) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolNameById.set(block.id, block.name);
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Scan tool_result messages in reverse order (most recent first)
  for (
    let i = msgs.length - 1;
    i >= 0 && highlights.length < maxHighlights;
    i--
  ) {
    const m = msgs[i];
    if (m.role !== "user") continue;

    const results = extractToolResults(m.content);
    for (const result of results) {
      if (highlights.length >= maxHighlights) break;

      const toolName = toolNameById.get(result.tool_use_id) ?? "tool";
      const resultText = result.content.trim();

      if (result.is_error) {
        // Always surface errors
        const errorSnippet = truncate(resultText, 200, "...");
        highlights.push(`- ${toolName}: Error — ${errorSnippet}`);
      } else if (resultText) {
        // Extract notable signal from successful results: file paths, URLs, or
        // a short summary of what happened
        const firstLine = resultText.split("\n")[0].trim();
        if (firstLine.length > 0 && firstLine.length <= 200) {
          highlights.push(`- ${toolName}: ${firstLine}`);
        } else if (firstLine.length > 200) {
          highlights.push(`- ${toolName}: ${truncate(firstLine, 200, "...")}`);
        }
      }
    }
  }

  return highlights;
}

// ---------------------------------------------------------------------------
// Shared business logic functions (exported for handler reuse)
// ---------------------------------------------------------------------------

export interface WorkItemOutputResult {
  success: boolean;
  error?: string;
  output?: {
    title: string;
    status: string;
    runId: string | null;
    conversationId: string | null;
    completedAt: number | null;
    summary: string;
    highlights: string[];
  };
}

/**
 * The extracted result of a work-item run: the latest assistant summary plus
 * bullet highlights, anchored to the run conversation. Shared by the
 * `getWorkItemOutput` route (poll-based) and the `work_item_completed` event
 * emitted by the runner (push-based) so both surfaces report the same thing.
 */
export interface WorkItemRunResult {
  conversationId: string;
  summary: string;
  highlights: string[];
}

/**
 * Resolve the authoritative conversation id for a work item's most recent run.
 * Prefers the task run's recorded conversationId, falling back to the work
 * item's stored `lastRunConversationId`.
 */
export function resolveWorkItemRunConversationId(workItem: {
  lastRunId: string | null;
  lastRunConversationId: string | null;
}): { conversationId: string | null; completedAt: number | null } {
  let conversationId: string | null = null;
  let completedAt: number | null = null;

  if (workItem.lastRunId) {
    const run = getTaskRun(workItem.lastRunId);
    if (run) {
      conversationId = run.conversationId;
      completedAt =
        run.finishedAt != null ? Math.floor(run.finishedAt / 1000) : null;
    }
  }

  if (!conversationId) {
    conversationId = workItem.lastRunConversationId;
  }

  return { conversationId, completedAt };
}

/**
 * Extract the summary + highlights for a completed run conversation. This is
 * the single source of truth for work-item result extraction: scan the run's
 * messages for the latest assistant text (summary) and bullet highlights,
 * supplementing with tool outcomes when the prose is thin.
 */
export function extractWorkItemResult(
  conversationId: string,
): WorkItemRunResult {
  let summary = "";
  let highlights: string[] = [];

  const msgs = getMessages(conversationId);

  // Find the last assistant message with text content
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;

    const text = extractLatestTextFromContent(m.content);
    if (!text.trim()) continue;

    summary = truncate(text, 2000, "");

    // Extract bullet points from the assistant's prose
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith("-") || trimmed.startsWith("*")) &&
        trimmed.length > 2
      ) {
        highlights.push(trimmed);
        if (highlights.length >= 5) break;
      }
    }
    break;
  }

  // Supplement with tool outcomes
  if (highlights.length < 5) {
    const toolHighlights = extractToolHighlights(msgs, 5 - highlights.length);
    highlights = [...highlights, ...toolHighlights];
  }

  // Synthesize from tool results if no assistant summary
  if (!summary && msgs.length > 0) {
    const toolHighlights = extractToolHighlights(msgs, 10);
    if (toolHighlights.length > 0) {
      summary = "Task completed. Tool outcomes:\n" + toolHighlights.join("\n");
      highlights = toolHighlights.slice(0, 5);
    }
  }

  return { conversationId, summary, highlights };
}

function getWorkItemOutput(id: string): WorkItemOutputResult {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  const { conversationId, completedAt } =
    resolveWorkItemRunConversationId(workItem);

  if (!conversationId) {
    return {
      success: false,
      error: "This task has not been run yet. No output is available.",
    };
  }

  const { summary, highlights } = extractWorkItemResult(conversationId);

  return {
    success: true,
    output: {
      title: workItem.title,
      status: workItem.lastRunStatus ?? workItem.status,
      runId: workItem.lastRunId,
      conversationId,
      completedAt,
      summary,
      highlights,
    },
  };
}

export interface WorkItemPreflightResult {
  success: boolean;
  error?: string;
  permissions?: Array<{
    tool: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    currentDecision: "allow" | "deny" | "prompt";
  }>;
}

export async function preflightWorkItem(
  id: string,
): Promise<WorkItemPreflightResult> {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  const task = getTask(workItem.taskId);
  if (!task) {
    return {
      success: false,
      error: `Associated task not found: ${workItem.taskId}`,
    };
  }
  const taskRequiredTools = task.requiredTools
    ? sanitizeToolList(JSON.parse(task.requiredTools))
    : getRegisteredToolNames();
  let requiredTools = resolveRequiredTools(
    workItem.requiredTools,
    taskRequiredTools,
  );

  if (requiredTools.length === 0) {
    return { success: true, permissions: [] };
  }

  // Filter out already-approved tools
  if (workItem.approvedTools) {
    const approvedSet = new Set<string>(JSON.parse(workItem.approvedTools));
    requiredTools = requiredTools.filter((t) => !approvedSet.has(t));
    if (requiredTools.length === 0) {
      return { success: true, permissions: [] };
    }
  }

  const workingDir = process.cwd();
  const policyContext = { executionContext: "headless" as const };
  const permissions = await Promise.all(
    requiredTools.map(async (tool) => {
      const { level: risk } = await classifyRisk(tool, {}, workingDir);
      const result = await check(tool, {}, workingDir, policyContext);
      return {
        tool,
        description: getToolDescription(tool),
        riskLevel: risk.toLowerCase() as "low" | "medium" | "high",
        currentDecision: result.decision as "allow" | "deny" | "prompt",
      };
    }),
  );

  return { success: true, permissions };
}

export interface ApprovePermissionsResult {
  success: boolean;
  error?: string;
}

function approveWorkItemPermissions(
  id: string,
  approvedTools: string[],
): ApprovePermissionsResult {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  const existingApproved: string[] = workItem.approvedTools
    ? JSON.parse(workItem.approvedTools)
    : [];
  const newApproved = sanitizeToolList(approvedTools);
  const merged = [...new Set([...existingApproved, ...newApproved])];

  updateWorkItem(id, {
    approvedTools: JSON.stringify(sanitizeToolList(merged)),
    approvalStatus: "approved",
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Transport-agnostic routes (served by both HTTP and IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listWorkItems",
    endpoint: "work-items",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List work items",
    description: "Return work items, optionally filtered by status.",
    tags: ["work-items"],
    queryParams: [
      {
        name: "status",
        description: "Filter by work item status",
        schema: {
          type: "string",
          enum: [
            "pending",
            "running",
            "awaiting_review",
            "done",
            "failed",
            "cancelled",
            "archived",
          ],
        },
      },
      {
        name: "projectId",
        description: "Filter to a single project",
        schema: { type: "string" },
      },
    ],
    responseBody: z.object({
      items: z.array(workItemSchema),
    }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status ?? undefined;
      // The public API exposes "pending" as the queued bucket — the Activity
      // "Queued" section filters on `?status=pending`. The store column, though,
      // only ever holds "queued": created work items start "queued" and nothing
      // writes "pending". Without this alias translation the query runs
      // `WHERE status = 'pending'`, matches zero rows, and a just-enqueued
      // "Run it" / needs_you work item silently vanishes from Activity even
      // though the daemon is holding it. Map the alias so the surface matches.
      const resolvedStatus: WorkItemStatus | undefined =
        status === "pending"
          ? "queued"
          : (status as WorkItemStatus | undefined);
      const projectId = queryParams?.projectId ?? undefined;
      const items = listWorkItems({
        ...(resolvedStatus ? { status: resolvedStatus } : {}),
        ...(projectId ? { projectId } : {}),
      });
      return { items };
    },
  },

  {
    operationId: "getWorkItem",
    endpoint: "work-items/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a work item",
    description: "Return a single work item by ID.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const item = getWorkItem(pathParams!.id) ?? null;
      if (!item) {
        throw new NotFoundError("Work item not found");
      }
      return { item };
    },
  },

  {
    operationId: "updateWorkItem",
    endpoint: "work-items/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a work item",
    description:
      "Partially update a work item's title, notes, status, or priority.",
    tags: ["work-items"],
    additionalResponses: {
      "404": { description: "Work item not found" },
    },
    requestBody: z.object({
      title: z.string(),
      notes: z.string(),
      status: z.string(),
      priorityTier: z.number().int(),
      sortIndex: z.number().int(),
      projectId: z.string().nullable().describe("null clears the project"),
      dueAt: z.number().int().nullable().describe("null clears the deadline"),
      labels: z.array(z.string()).describe("Freeform labels"),
      assignee: z.string().describe('"cue" | "you" | contact name'),
    }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;

      // 404 on unknown ids — previously this fell through to
      // `updateWorkItem` (a no-op on a missing row) and returned
      // 200 {"item": null}, so callers patching a stale/deleted id never
      // learned the item was gone.
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError("Work item not found");
      }

      const { title, notes, status, priorityTier, sortIndex } = (body ??
        {}) as {
        title?: string;
        notes?: string;
        status?: string;
        priorityTier?: number;
        sortIndex?: number;
      };
      const { projectId, dueAt, labels, assignee } = (body ?? {}) as {
        projectId?: string | null;
        dueAt?: number | null;
        labels?: string[];
        assignee?: string;
      };

      if (
        status !== undefined &&
        existing.status === "cancelled" &&
        status !== "cancelled"
      ) {
        return { item: existing };
      }

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;
      if (priorityTier !== undefined) updates.priorityTier = priorityTier;
      if (sortIndex !== undefined) updates.sortIndex = sortIndex;
      if (projectId !== undefined) updates.projectId = projectId;
      if (dueAt !== undefined) updates.dueAt = dueAt;
      if (labels !== undefined) updates.labels = JSON.stringify(labels);
      if (assignee !== undefined) updates.assignee = assignee;

      const item = updateWorkItem(
        id,
        updates as Parameters<typeof updateWorkItem>[1],
        { actor: "user" },
      );

      // The row existed at the pre-check above, so a null here means it was
      // deleted while the update was in flight — same outcome for the caller.
      if (!item) {
        throw new NotFoundError("Work item not found");
      }

      broadcastWorkItemStatus(item.id);
      publishEvent({ type: "tasks_changed" });

      return { item };
    },
  },

  {
    operationId: "completeWorkItem",
    endpoint: "work-items/:id/complete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Complete a work item",
    description: "Transition a work item from awaiting_review to done.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError(`Work item not found: ${id}`);
      }
      if (existing.status !== "awaiting_review") {
        throw new ConflictError(
          `Cannot complete work item: status is '${existing.status}', expected 'awaiting_review'`,
        );
      }

      const item =
        updateWorkItem(id, { status: "done" }, { actor: "user" }) ?? null;
      if (item) {
        recordWorkItemEvent({
          workItemId: id,
          kind: "approved",
          fromStatus: "awaiting_review",
          toStatus: "done",
          actor: "user",
        });
        broadcastWorkItemStatus(item.id);
        publishEvent({ type: "tasks_changed" });
      }
      return { item };
    },
  },

  {
    operationId: "getWorkItemEvents",
    endpoint: "work-items/:id/events",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Work item history",
    description:
      "Return the audit trail of lifecycle events for a work item, plus its cycle time (creation to first completion) when computable.",
    tags: ["work-items"],
    responseBody: z.object({
      events: z.array(
        z.object({
          id: z.string(),
          workItemId: z.string(),
          kind: z.string(),
          fromStatus: z.string().nullable(),
          toStatus: z.string().nullable(),
          actor: z.string().nullable(),
          at: z.number().int(),
        }),
      ),
      cycleTimeMs: z.number().int().nullable(),
    }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError(`Work item not found: ${id}`);
      }
      const events = listWorkItemEvents(id);
      return { events, cycleTimeMs: cycleTimeMs(events) };
    },
  },

  {
    operationId: "deleteWorkItem",
    endpoint: "work-items/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a work item",
    description: "Permanently remove a work item.",
    tags: ["work-items"],
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError("Work item not found");
      }
      deleteWorkItem(id);
      // Strip the matching feed card too — a deleted work-item must not leave
      // its "Run it" card behind in the Inbound lane.
      reconcileFeedForWorkItemStatus({ ...existing, status: "archived" });
      publishEvent({ type: "tasks_changed" });
      return { id, success: true };
    },
  },

  {
    operationId: "approveWorkItemPermissions",
    endpoint: "work-items/:id/approve-permissions",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Approve tool permissions",
    description: "Pre-approve a set of tools for a work item before it runs.",
    tags: ["work-items"],
    requestBody: z.object({
      approvedTools: z
        .array(z.unknown())
        .describe("Array of tool names to approve"),
    }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      const { approvedTools } = (body ?? {}) as {
        approvedTools?: string[];
      };
      if (!Array.isArray(approvedTools)) {
        throw new BadRequestError("approvedTools array is required");
      }
      const result = approveWorkItemPermissions(id, approvedTools);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return { id, success: true };
    },
  },

  {
    operationId: "preflightWorkItem",
    endpoint: "work-items/:id/preflight",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Preflight check",
    description: "Check tool permissions needed before running a work item.",
    tags: ["work-items"],
    responseBody: z.object({
      id: z.string(),
      success: z.boolean(),
      permissions: z.object({}).passthrough(),
    }),
    handler: async ({ pathParams }) => {
      const id = pathParams!.id;
      const result = await preflightWorkItem(id);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return {
        id,
        success: true,
        permissions: result.permissions,
      };
    },
  },

  {
    operationId: "getWorkItemOutput",
    endpoint: "work-items/:id/output",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get work item output",
    description: "Return the final output of a completed work item run.",
    tags: ["work-items"],
    responseBody: z.object({
      id: z.string(),
      success: z.boolean(),
      output: z.object({}).passthrough(),
    }),
    handler: ({ pathParams }) => {
      const id = pathParams!.id;
      const result = getWorkItemOutput(id);
      if (!result.success) {
        throw new NotFoundError(result.error!);
      }
      return {
        id,
        success: true,
        output: result.output,
      };
    },
  },

  // -- Cancel + Run --

  {
    operationId: "cancelWorkItem",
    endpoint: "work-items/:id/cancel",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Cancel a running work item",
    description: "Abort a running work item and set its status to cancelled.",
    tags: ["work-items"],
    additionalResponses: {
      "404": { description: "Work item not found" },
      "409": { description: "Work item is not running" },
    },
    handler: ({ pathParams }) => {
      const workItem = getWorkItem(pathParams!.id);
      if (!workItem) {
        throw new NotFoundError("Work item not found");
      }
      if (workItem.status !== "running") {
        throw new ConflictError(
          `Work item is not running (status: ${workItem.status})`,
        );
      }

      const conversationId = workItem.lastRunConversationId;
      if (conversationId) {
        const conversation = findConversation(conversationId);
        if (conversation) {
          conversation.headlessLock = false;
          conversation.abort(
            createAbortReason(
              "work_item_aborted",
              "work-items-routes.cancel",
              conversationId,
            ),
          );
          getSubagentManager().abortAllForParent(conversationId);
        }
      }

      updateWorkItem(pathParams!.id, {
        status: "cancelled",
        lastRunStatus: "cancelled",
      });

      broadcastWorkItemStatus(pathParams!.id);
      publishEvent({ type: "tasks_changed" });
      return { id: pathParams!.id, success: true };
    },
  },

  {
    operationId: "runWorkItem",
    endpoint: "work-items/:id/run",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Run a work item",
    description:
      "Execute the task associated with a work item. Returns immediately; execution happens in the background.",
    tags: ["work-items"],
    additionalResponses: {
      "404": { description: "Work item or associated task not found" },
      "409": { description: "Work item is already running or not runnable" },
    },
    handler: ({ pathParams }) => {
      // Delegate to the canonical background runner — the same path the
      // working `assistant task queue run` CLI command uses. Clicking
      // "Run now" is explicit user consent, so the runner auto-approves
      // the work item's required tools and executes the task in the
      // background, broadcasting status over SSE as it progresses.
      //
      // The earlier HTTP-only implementation duplicated the run logic but
      // demanded every required tool already be pre-approved (via a
      // separate preflight/approve round-trip), throwing a 403 otherwise.
      // A freshly-queued item has no approved tools and its task's
      // requiredTools default to the full registered-tool list, so that
      // gate fired on every "Run now" click. The web mutation wires only
      // `onSuccess`, so the 403 surfaced as nothing happening at all.
      const id = pathParams!.id;
      const result = runWorkItemInBackground(id);

      if (!result.success) {
        switch (result.errorCode) {
          case "not_found":
          case "no_task":
            throw new NotFoundError(result.error ?? "Work item not found");
          case "already_running":
          case "invalid_status":
            throw new ConflictError(result.error ?? "Work item cannot be run");
          default:
            throw new ConflictError(result.error ?? "Failed to run work item");
        }
      }

      return {
        id,
        success: true,
        lastRunId: "",
      };
    },
  },
];
