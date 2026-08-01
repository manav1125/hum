/**
 * Route handlers for work item (task queue) operations.
 *
 * Exposes all work item CRUD and lifecycle operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/work-items.ts`.
 */
import { z } from "zod";

import { revertConfigCommit } from "../../config-repo/index.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import { reconcileFeedForWorkItemStatus } from "../../home/feed-writer.js";
import { check, classifyRisk } from "../../permissions/checker.js";
import { getSubagentManager } from "../../subagent/index.js";
import { createTask, getTask } from "../../tasks/task-store.js";
import {
  getRegisteredToolNames,
  getToolDescription,
  sanitizeToolList,
} from "../../tasks/tool-sanitizer.js";
import { createAbortReason } from "../../util/abort-reasons.js";
import { truncate } from "../../util/truncate.js";
import { resolveRequiredTools } from "../../work-items/resolve-required-tools.js";
import { classifyTitlesForPreview } from "../../work-items/work-item-auto-file.js";
import {
  cycleTimeMs,
  listWorkItemEvents,
  recordWorkItemEvent,
} from "../../work-items/work-item-events.js";
import {
  deriveRanProvenance,
  withRanProvenance,
} from "../../work-items/work-item-provenance.js";
import {
  extractWorkItemResult,
  resolveWorkItemRunConversationId,
} from "../../work-items/work-item-run-result.js";
import { runWorkItemInBackground } from "../../work-items/work-item-runner.js";
import {
  createWorkItem,
  deleteWorkItem,
  getWorkItem,
  isWorkItemDomain,
  isWorkItemHorizon,
  listWorkItems,
  listWorkItemsByOriginConversation,
  updateWorkItem,
  type WorkItem,
  type WorkItemDomain,
  type WorkItemHorizon,
  type WorkItemStatus,
} from "../../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../../work-items/work-item-triage.js";
import { deriveWaitingState } from "../../work-items/work-item-waiting.js";
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
  context: z
    .string()
    .nullable()
    .describe("Per-task context the user adds; read by the agent before a run"),
  sourceContext: z
    .string()
    .nullable()
    .describe("JSON snapshot of where the task came from (triage-stamped)"),
  lastActivityAt: z
    .number()
    .int()
    .nullable()
    .describe("Epoch ms of last activity; drives stale-item ranking"),
  lastRunId: z.string().nullable(),
  lastRunConversationId: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  lastProgressNote: z
    .string()
    .nullable()
    .describe(
      'Live activity line ("Searching the web…") stamped by the runner while status is "running"; null otherwise',
    ),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  originConversationId: z
    .string()
    .nullable()
    .describe(
      "The conversation this item was created FROM — distinct from lastRunConversationId (where the run happened) and from sourceType/sourceId (which channel it arrived on). Lets the originating thread show what it spawned.",
    ),
  approvalStatus: z.string().nullable(),
  autoRunEligibility: z
    .string()
    .nullable()
    .describe(
      'null = eligible for policy-gated auto-run; "parked" = user parked ' +
        "this task, so it only starts on an explicit run",
    ),
  ranProvenance: z
    .enum(["auto", "you_approved", "manual"])
    .nullable()
    .describe(
      "Read-time run-provenance trust signal for Done cards: " +
        '"auto" = Cue ran it autonomously with no owner-gated approval; ' +
        '"you_approved" = the owner approved a guardian gate during the run ' +
        "or pre-approved its tool permissions; " +
        '"manual" = the owner completed it themselves (Cue never ran it, ' +
        "or the item carries the completedElsewhere marker); " +
        "null = not applicable (not yet run / not a manual completion).",
    ),
  completedElsewhere: z
    .boolean()
    .describe(
      'True when the owner marked this task done as "completed elsewhere" — ' +
        "the work happened outside Cue, so no run output is claimed. " +
        'Terminal exactly like done; never say "Cue finished this" for it.',
    ),
  autoFiledBy: z
    .string()
    .nullable()
    .describe(
      '"cue" = the background auto-filer assigned projectId (show the ' +
        'auto-filed chip); "user_unfiled" = the user deliberately unfiled ' +
        "the item (the auto-filer will not re-file it); null = user-filed " +
        "or never filed.",
    ),
  autoFileConfidence: z
    .number()
    .nullable()
    .describe(
      'The auto-filer\'s 0-1 confidence. With autoFiledBy = "cue" it is the ' +
        "provenance of a filing; on an UNFILED item (projectId and " +
        "autoFiledBy both null) it is the below-confidence stamp — the " +
        "sweep scored the item but was not sure (clients render the amber " +
        '"?" triage card).',
    ),
  // --- Pre-run assessment (work-items/work-item-assessment.ts) -------------
  // Written before the execution turn: what Cue understood the task to be, and
  // whether it can actually do it with the context this item carries. All null
  // on an item that has never been dispatched (never assessed = runs as before).
  assessmentVerdict: z
    .enum(["execute", "clarify", "not_ai_task", "blocked"])
    .nullable()
    .describe(
      '"execute" = Cue understands it and has what it needs (see ' +
        'assessmentPlan); "clarify" = under-specified, surface ' +
        "assessmentQuestion and let the answer land as task context; " +
        '"not_ai_task" = a human action — do NOT offer a Run affordance as ' +
        'the primary action; "blocked" = assessmentMissing names the one ' +
        "thing Cue lacks (offer the fix, e.g. link the connector or attach " +
        "the file). null = not assessed.",
    ),
  assessmentUnderstanding: z
    .string()
    .nullable()
    .describe(
      "One plain sentence naming what Cue understood the task to be — show " +
        "this so the user can catch a misread before the work happens.",
    ),
  assessmentPlan: z
    .string()
    .nullable()
    .describe(
      "1-2 lines, plain words, of what Cue will actually do. Set with " +
        'verdict "execute"; shown as/just before the run starts.',
    ),
  assessmentQuestion: z
    .string()
    .nullable()
    .describe(
      'Exactly ONE question. Set with verdict "clarify"; the item is parked ' +
        "until answered (answering it as task context re-opens assessment).",
    ),
  assessmentMissing: z
    .string()
    .nullable()
    .describe(
      "The one specific missing thing — a connector, a file, an access. Set " +
        'with verdict "blocked".',
    ),
  assessmentConfidence: z
    .number()
    .nullable()
    .describe("The assessor's 0-1 confidence in its verdict."),
  assessmentAt: z
    .number()
    .int()
    .nullable()
    .describe("Epoch ms the stored verdict was produced."),
  // --- Life lens (317) ----------------------------------------------------
  domain: z
    .enum(["work", "life"])
    .describe(
      'Which lens the item lives in. "work" groups by mission (why); "life" ' +
        "groups by horizon (when) — same rows, same engine, different " +
        "organising axis. Also the privacy boundary: hiding personal work for " +
        'a screen-share is this one predicate. Every item defaults to "work".',
    ),
  horizon: z
    .enum(["this_week", "soon", "someday"])
    .nullable()
    .describe(
      "When a life item wants attention. Always null on work items, which " +
        "group by mission instead.",
    ),
  // --- Waiting on a person (317) ------------------------------------------
  waitingOn: z
    .string()
    .nullable()
    .describe(
      "contacts.id of the person this item is blocked on. Distinct from " +
        "assignee, which says who OWNS the item — an item you own can still " +
        "be waiting on somebody else's reply. null = not waiting on anybody.",
    ),
  lastChasedAt: z
    .number()
    .int()
    .nullable()
    .describe(
      "Epoch ms of the last nudge sent about this item. null = never chased, " +
        'which reads differently from "chased a while ago".',
    ),
  waitingState: z
    .enum(["on_time", "already_chased", "going_cold"])
    .nullable()
    .describe(
      "Read-time derivation over waitingOn + lastChasedAt, computed here so " +
        "every surface draws the same line: " +
        '"on_time" = waiting, nothing has gone quiet — forget it, Cue will ' +
        'chase; "already_chased" = a nudge went out recently, so the next ' +
        'move is to escalate rather than nudge again; "going_cold" = the ' +
        "silence has outlasted the chase window (5 days). null = the item is " +
        "not waiting on a person, or it is already finished.",
    ),
  // --- Arrival provenance (318) -------------------------------------------
  arrivalId: z
    .string()
    .nullable()
    .describe(
      "The arrivals.id this item was surfaced from — set only for watcher " +
        "hits that went through the relevance gate, i.e. things Cue looked at " +
        "and decided you need to see. Fetch GET arrivals/:id for the reason. " +
        "null on everything captured any other way (quick-add, chat, voice, " +
        "mission cycles) and on every item that predates the gate. This is " +
        "NOT autoFiledBy/autoFileConfidence, which mean 'assigned to a " +
        "project' — a different axis entirely.",
    ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/**
 * Attach the read-time `ranProvenance` trust signal to a single work item for
 * the route response, and convert the stored 0/1 `completedElsewhere` marker
 * to the wire boolean. List endpoints use {@link annotateWorkItems} instead.
 */
function annotateWorkItem(item: WorkItem) {
  return {
    ...item,
    completedElsewhere: item.completedElsewhere === 1,
    ranProvenance: deriveRanProvenance(item),
    waitingState: deriveWaitingState(item),
  };
}

/**
 * Batched wire-shaping for list endpoints: `ranProvenance` via a single
 * guardian-ledger query plus the 0/1 → boolean `completedElsewhere` mapping.
 * Shared with the projects routes so every surface returns one DTO shape.
 */
export function annotateWorkItems(items: WorkItem[]) {
  // One clock for the whole page, so two rows chased a millisecond apart can
  // never land on opposite sides of the going-cold boundary in one response.
  const now = Date.now();
  return withRanProvenance(items).map((item) => ({
    ...item,
    completedElsewhere: item.completedElsewhere === 1,
    waitingState: deriveWaitingState(item, now),
  }));
}

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
        lastProgressNote: item.lastProgressNote,
        updatedAt: item.updatedAt,
      },
    });
    // Couple the feed lifecycle: a terminal work-item dismisses its matching
    // "Run it" card so it stops lingering in the Inbound lane.
    reconcileFeedForWorkItemStatus(item);
  }
}

// ---------------------------------------------------------------------------
// Shared business logic functions (exported for handler reuse)
// ---------------------------------------------------------------------------

// Run-result extraction lives in the work-items domain (three consumers, only
// one of them an HTTP handler); re-exported here so existing importers of this
// module keep working.
export { extractWorkItemResult, resolveWorkItemRunConversationId };
export type { WorkItemRunResult } from "../../work-items/work-item-run-result.js";

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
 * Config-repo (WS5) review items have no run conversation — their "output"
 * is the config diff itself, carried in `notes` at creation time. Synthesize
 * the standard output shape (summary + highlights) from those notes so the
 * awaiting-review card renders them unchanged: bullet lines become
 * highlights, the surrounding prose becomes the summary.
 */
function synthesizeConfigRepoOutput(workItem: {
  title: string;
  status: string;
  notes: string | null;
}): WorkItemOutputResult {
  const lines = (workItem.notes ?? "").split("\n");
  const highlights = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .slice(0, 8);
  const summary =
    truncate(
      lines
        .filter((l) => !l.trim().startsWith("- "))
        .join("\n")
        .trim(),
      2000,
      "",
    ) || "Configuration change recorded in the local config repo.";

  return {
    success: true,
    output: {
      title: workItem.title,
      status: workItem.status,
      runId: null,
      conversationId: null,
      completedAt: null,
      summary,
      highlights,
    },
  };
}

function getWorkItemOutput(id: string): WorkItemOutputResult {
  const workItem = getWorkItem(id);
  if (!workItem) {
    return { success: false, error: "Work item not found" };
  }

  // Config-repo review items never have a run — answer from notes instead of
  // failing the "has not been run yet" check below.
  if (workItem.sourceType === "config_repo") {
    return synthesizeConfigRepoOutput(workItem);
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
      {
        name: "originConversationId",
        description:
          "Filter to the items a single conversation spawned (work_items.origin_conversation_id). Lets a thread show the work it started.",
        schema: { type: "string" },
      },
      {
        name: "domain",
        description:
          'Filter to one lens: "work" (grouped by mission) or "life" ' +
          "(grouped by horizon). Omit for both — a client that does not know " +
          "about lenses sees every item, exactly as before. This is also the " +
          'privacy switch: "hide Life" for a screen-share is ?domain=work.',
        schema: { type: "string", enum: ["work", "life"] },
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
      const originConversationId =
        queryParams?.originConversationId ?? undefined;
      // The lens switch. An unknown value is rejected rather than ignored:
      // silently widening `?domain=persona1` to "everything" would show
      // personal work on a shared screen, which is the one failure this
      // boundary exists to prevent.
      const domainParam = queryParams?.domain ?? undefined;
      if (domainParam !== undefined && !isWorkItemDomain(domainParam)) {
        throw new BadRequestError(
          `domain must be "work" or "life" (got "${domainParam}")`,
        );
      }
      const domain: WorkItemDomain | undefined = domainParam;
      // The origin filter is a dedicated indexed lookup rather than another
      // `listWorkItems` predicate: it is read per conversation render, and it
      // deliberately drops archived items (see the store) so a thread never
      // re-surfaces work the owner filed away.
      let items = originConversationId
        ? listWorkItemsByOriginConversation(originConversationId)
        : listWorkItems({
            ...(resolvedStatus ? { status: resolvedStatus } : {}),
            ...(projectId ? { projectId } : {}),
            ...(domain ? { domain } : {}),
          });
      if (originConversationId) {
        if (resolvedStatus)
          items = items.filter((i) => i.status === resolvedStatus);
        if (projectId) items = items.filter((i) => i.projectId === projectId);
        if (domain) items = items.filter((i) => i.domain === domain);
      }
      return { items: annotateWorkItems(items) };
    },
  },

  {
    operationId: "createWorkItem",
    endpoint: "work-items",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a work item",
    description:
      "Create a queued work item directly (e.g. the project-board quick-add). " +
      "Mints the backing task template, stamps a manual source context, and " +
      "runs triage without auto-running — a manually filed task waits for the " +
      "user (or an explicit run) to start it.",
    tags: ["work-items"],
    additionalResponses: {
      "400": { description: "Missing or empty title" },
    },
    requestBody: z.object({
      title: z.string().min(1),
      notes: z.string().optional(),
      projectId: z
        .string()
        .optional()
        .describe("File the new task into this project"),
      dueAt: z.number().int().optional().describe("Due deadline, epoch ms"),
      context: z
        .string()
        .optional()
        .describe("Per-task context the agent reads before a run"),
      originConversationId: z
        .string()
        .optional()
        .describe(
          "The conversation this was started from. Set it when the caller is a " +
            "thread (e.g. the composer's 'run in the background'), so the item " +
            "shows up in that thread's spawned-work strip and its provenance " +
            "survives. Omit for surfaces with no originating conversation.",
        ),
      domain: z
        .enum(["work", "life"])
        .optional()
        .describe(
          'Which lens to file the item in. Defaults to "work" when omitted, ' +
            "so a caller that knows nothing about lenses behaves as before.",
        ),
      horizon: z
        .enum(["this_week", "soon", "someday"])
        .optional()
        .describe(
          'When a life item wants attention. Ignored unless domain is "life" ' +
            "— work items group by mission.",
        ),
      waitingOn: z
        .string()
        .optional()
        .describe("contacts.id of the person this item is blocked on"),
      lastChasedAt: z
        .number()
        .int()
        .optional()
        .describe("Epoch ms of the last nudge sent about this item"),
    }),
    responseBody: z.object({ item: workItemSchema }),
    handler: ({ body }) => {
      const {
        title,
        notes,
        projectId,
        dueAt,
        context,
        originConversationId,
        domain,
        horizon,
        waitingOn,
        lastChasedAt,
      } = (body ?? {}) as {
        title?: string;
        notes?: string;
        projectId?: string;
        dueAt?: number;
        context?: string;
        originConversationId?: string;
        domain?: unknown;
        horizon?: unknown;
        waitingOn?: string;
        lastChasedAt?: number;
      };
      if (typeof title !== "string" || !title.trim()) {
        throw new BadRequestError("title is required");
      }
      if (domain !== undefined && !isWorkItemDomain(domain)) {
        throw new BadRequestError('domain must be "work" or "life"');
      }
      if (horizon !== undefined && !isWorkItemHorizon(horizon)) {
        throw new BadRequestError(
          'horizon must be "this_week", "soon" or "someday"',
        );
      }
      const trimmedTitle = title.trim();

      // `work_items.taskId` requires a real tasks row — mint a lightweight
      // template per item, mirroring the ad-hoc enqueue tool. The notes (when
      // present) are the richer instruction sent to the model at run time.
      const template = notes?.trim() || trimmedTitle;
      const task = createTask({ title: trimmedTitle, template });

      // Stamp the manual origin at creation so triage's blank-fill pass leaves
      // it alone: a quick-add is user-typed, not captured from a channel.
      const snippet =
        template.length > 500 ? `${template.slice(0, 500)}…` : template;
      const item = createWorkItem({
        taskId: task.id,
        title: trimmedTitle,
        notes,
        projectId,
        dueAt,
        context,
        // Carry the originating thread when the caller supplied one, so a run
        // started from a conversation appears in that thread's spawned-work
        // strip instead of vanishing into the queue with a null origin.
        ...(originConversationId?.trim()
          ? { originConversationId: originConversationId.trim() }
          : {}),
        // The lens and the waiting target, when the caller named them. Left
        // off entirely otherwise, so the store's "work, no horizon, not
        // waiting" default is what an unaware caller gets.
        ...(domain ? { domain } : {}),
        ...(horizon ? { horizon } : {}),
        ...(waitingOn?.trim() ? { waitingOn: waitingOn.trim() } : {}),
        ...(typeof lastChasedAt === "number" ? { lastChasedAt } : {}),
        sourceContext: JSON.stringify({
          origin: "manual",
          snippet,
          capturedAt: Date.now(),
        }),
        // Durable parked marker: `skipAutoRun` below only skips the
        // capture-time evaluation — the periodic queue drainer re-evaluates
        // the queued lane later and would otherwise auto-start this under a
        // permissive autonomy policy. 'parked' makes "waits for the user"
        // hold at every auto-run entry point until an explicit run clears it.
        autoRunEligibility: "parked",
        actor: "user",
      });

      // Triage fills the blanks (tier / sortIndex / dueAt) but never
      // auto-runs: a manually filed task waits for the user to say go. The
      // caller-supplied projectId is already set, so triage won't reassign it.
      void triageAndMaybeAutoRunWorkItem(item.id, { skipAutoRun: true });

      broadcastWorkItemStatus(item.id);
      publishEvent({ type: "tasks_changed" });

      return { item: annotateWorkItem(item) };
    },
  },

  {
    operationId: "classifyPreviewWorkItems",
    endpoint: "work-items/classify-preview",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Preview project classification for titles",
    description:
      "Score task titles against active projects with the SAME batch scorer " +
      "the background auto-filer uses (same flash call site, same prompt " +
      "shape) — no persistence, no side effects: nothing is created, filed, " +
      "or stamped. Backs the batch-add surfaces' per-row suggestions. Blank " +
      "and duplicate titles are dropped and the batch is capped at 30; " +
      "scorer failures/timeouts return an empty suggestions array, never an " +
      "error.",
    tags: ["work-items"],
    additionalResponses: {
      "400": { description: "titles must be an array of strings" },
    },
    requestBody: z.object({
      titles: z.array(z.string()).describe(
        // Cap mirrors MAX_CLASSIFY_PREVIEW_TITLES (not interpolated: this
        // module and work-item-auto-file.ts import-cycle through the
        // runner, so a load-time const access would hit the TDZ).
        "Task titles to classify (blank/duplicate entries dropped; first 30 scored)",
      ),
    }),
    responseBody: z.object({
      suggestions: z.array(
        z.object({
          title: z.string(),
          projectId: z.string().nullable(),
          confidence: z.number(),
        }),
      ),
    }),
    handler: async ({ body }) => {
      const { titles } = (body ?? {}) as { titles?: unknown };
      if (!Array.isArray(titles) || titles.some((t) => typeof t !== "string")) {
        throw new BadRequestError("titles must be an array of strings");
      }
      // Read-only despite the POST verb (a query with a request body); all
      // hardening (empty/dup filtering, the 30-title cap, the shared 90s
      // scorer deadline, failure → []) lives in classifyTitlesForPreview.
      const suggestions = await classifyTitlesForPreview(titles as string[]);
      return { suggestions };
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
      return { item: annotateWorkItem(item) };
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
      projectId: z
        .string()
        .nullable()
        .describe("null clears the project; a value moves the task"),
      dueAt: z.number().int().nullable().describe("null clears the deadline"),
      labels: z.array(z.string()).describe("Freeform labels"),
      assignee: z.string().describe('"cue" | "you" | contact name'),
      context: z
        .string()
        .nullable()
        .describe("Per-task context the agent reads before a run"),
      // Optional, unlike the fields above them. This is a PATCH: the handler
      // has always applied only the keys present in the body, and a caller
      // that has never heard of lenses must keep compiling and keep behaving
      // exactly as it did. (The older fields are declared required here, so
      // the generated client forces every caller to pass all ten to change
      // one — a pre-existing wart, not something to spread further.)
      domain: z
        .enum(["work", "life"])
        .optional()
        .describe(
          'Move the item between lenses. Moving to "work" also clears ' +
            "horizon (work groups by mission, so a horizon would be dead " +
            "data) unless a horizon is set in the same request.",
        ),
      horizon: z
        .enum(["this_week", "soon", "someday"])
        .nullable()
        .optional()
        .describe("null clears the horizon; only meaningful for life items"),
      waitingOn: z
        .string()
        .nullable()
        .optional()
        .describe(
          "contacts.id of the person this item is blocked on; null clears it " +
            "(the reply landed, or it was never really a wait)",
        ),
      lastChasedAt: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Epoch ms of the last nudge; set it when a chase goes out, null " +
            "resets the item to never-chased",
        ),
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
      const { projectId, dueAt, labels, assignee, context } = (body ?? {}) as {
        projectId?: string | null;
        dueAt?: number | null;
        labels?: string[];
        assignee?: string;
        context?: string | null;
      };
      const { domain, horizon, waitingOn, lastChasedAt } = (body ?? {}) as {
        domain?: unknown;
        horizon?: unknown;
        waitingOn?: string | null;
        lastChasedAt?: number | null;
      };
      if (domain !== undefined && !isWorkItemDomain(domain)) {
        throw new BadRequestError('domain must be "work" or "life"');
      }
      if (
        horizon !== undefined &&
        horizon !== null &&
        !isWorkItemHorizon(horizon)
      ) {
        throw new BadRequestError(
          'horizon must be "this_week", "soon" or "someday" (or null)',
        );
      }

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
      if (projectId !== undefined) {
        updates.projectId = projectId;
        // A user's filing decision must stick. Moving/filing clears any
        // auto-filed provenance (the chip disappears — it's user-filed now);
        // a deliberate unfile (projectId: null) stamps the 'user_unfiled'
        // guard so the background auto-filer never re-files this item.
        updates.autoFiledBy = projectId === null ? "user_unfiled" : null;
        updates.autoFileConfidence = null;
      }
      if (dueAt !== undefined) updates.dueAt = dueAt;
      if (labels !== undefined) updates.labels = JSON.stringify(labels);
      if (assignee !== undefined) updates.assignee = assignee;
      if (context !== undefined) updates.context = context;
      // The lens move. `updateWorkItem` drops a stale horizon when the item
      // lands back in "work", so the invariant holds wherever the move came
      // from — this route, a tool, or the agent.
      if (domain !== undefined) updates.domain = domain as WorkItemDomain;
      if (horizon !== undefined) {
        updates.horizon = horizon as WorkItemHorizon | null;
      }
      if (waitingOn !== undefined) updates.waitingOn = waitingOn;
      if (lastChasedAt !== undefined) updates.lastChasedAt = lastChasedAt;

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

      return { item: annotateWorkItem(item) };
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
    description:
      "Transition a work item to done. Without a body this is the review " +
      "sign-off path (awaiting_review → done, recorded as 'approved'). With " +
      "completedElsewhere: true the owner is saying the work happened " +
      "outside Cue — the item is marked done from queued or awaiting_review " +
      "with the completedElsewhere marker stamped, no approval is recorded, " +
      "and no run output is claimed.",
    tags: ["work-items"],
    requestBody: z.object({
      completedElsewhere: z
        .boolean()
        .optional()
        .describe(
          "True = the owner completed this task outside Cue. Stamps the " +
            "durable completedElsewhere marker instead of recording a " +
            "review approval; ranProvenance reads 'manual'.",
        ),
    }),
    handler: ({ pathParams, body }) => {
      const id = pathParams!.id;
      const existing = getWorkItem(id);
      if (!existing) {
        throw new NotFoundError(`Work item not found: ${id}`);
      }

      const completedElsewhere =
        (body as { completedElsewhere?: boolean } | undefined)
          ?.completedElsewhere === true;

      if (completedElsewhere) {
        // "I did this myself" applies to a task Cue never ran (queued) as
        // well as one whose run is parked in review. Running items must be
        // cancelled first; terminal items have nothing left to complete.
        if (
          existing.status !== "queued" &&
          existing.status !== "awaiting_review"
        ) {
          throw new ConflictError(
            `Cannot complete work item as done elsewhere: status is '${existing.status}', expected 'queued' or 'awaiting_review'`,
          );
        }
        const item =
          updateWorkItem(
            id,
            { status: "done", completedElsewhere: 1 },
            { actor: "user" },
          ) ?? null;
        if (item) {
          // Deliberately NOT "approved": the owner did the work, they are not
          // signing off on a run Cue performed — the ledger must never credit
          // Cue with this outcome.
          recordWorkItemEvent({
            workItemId: id,
            kind: "completed_elsewhere",
            fromStatus: existing.status,
            toStatus: "done",
            actor: "user",
          });
          broadcastWorkItemStatus(item.id);
          publishEvent({ type: "tasks_changed" });
        }
        return { item: item ? annotateWorkItem(item) : null };
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
      return { item: item ? annotateWorkItem(item) : null };
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
          detail: z
            .string()
            .nullable()
            .describe(
              "Human-readable narration for this row, when it carries any: " +
                'the assessment verdict on an "assessed" row ("Understood: … ' +
                'Plan: …"), or one step of the run on a "run_step" row ' +
                '("Reading Q2-deck.pdf from project knowledge"). Always ' +
                "derived from something that really happened — a verdict Cue " +
                "produced or a tool call it started. null on lifecycle-only " +
                "rows (created / status_changed / run_started / …).",
            ),
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

      // Config-repo (WS5) review items: "Redo" does not re-run anything —
      // it reverts the underlying config commit in the local config repo,
      // then closes the item. Everything else falls through to the normal
      // background runner unchanged.
      const existing = getWorkItem(id);
      if (existing?.sourceType === "config_repo") {
        if (!existing.sourceId) {
          throw new ConflictError(
            "Config change item has no commit hash to revert",
          );
        }
        const revert = revertConfigCommit(existing.sourceId);
        if (!revert.success) {
          throw new ConflictError(
            `Could not revert config commit ${existing.sourceId.slice(0, 10)}: ${revert.error ?? "unknown error"}`,
          );
        }
        updateWorkItem(
          id,
          { status: "done", lastRunStatus: "reverted" },
          { actor: "user" },
        );
        recordWorkItemEvent({
          workItemId: id,
          kind: "status_changed",
          fromStatus: existing.status,
          toStatus: "done",
          actor: "user",
        });
        broadcastWorkItemStatus(id);
        publishEvent({ type: "tasks_changed" });
        return { id, success: true, lastRunId: "" };
      }

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
