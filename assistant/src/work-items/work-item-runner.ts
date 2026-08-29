/**
 * Module-level runner for executing work items from tool context.
 *
 * Imports conversation-store and the assistant event hub directly — no
 * daemon-server callback registration needed.
 */

import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  type BudgetCheckResult,
  checkRunStartBudget,
} from "../guardrails/budget-enforcement.js";
import { reconcileFeedForWorkItemStatus } from "../home/feed-writer.js";
import { recordImpact } from "../home/impact-store.js";
import { setConversationAgentId } from "../memory/conversation-crud.js";
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
import { applyAgentBinding } from "./agent-binding.js";
import { type Agent, getAgentByAssignee } from "./agent-store.js";
import {
  ensureProjectKnowledgeFiles,
  type MaterializedProjectKnowledge,
} from "./project-knowledge-store.js";
import { getProject } from "./project-store.js";
import { resolveRequiredTools } from "./resolve-required-tools.js";
import {
  buildSkippedStepsNote,
  clearApprovalTimeouts,
  consumeApprovalTimeouts,
} from "./work-item-approval-timeouts.js";
import {
  ASSESSING_PROGRESS_NOTE,
  assessWorkItem,
  buildCapabilitySnapshot,
  isAssessmentGateEnabled,
  narrationForAssessment,
  type WorkItemAssessment,
} from "./work-item-assessment.js";
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
  /**
   * Project-knowledge paths → labels for this run (see
   * {@link buildWorkItemRunContext}). Lets a file read of an attached
   * reference say WHY it is being read rather than naming a temp path.
   */
  knowledgeByPath?: ReadonlyMap<string, string>,
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
  // File reads/edits: name the file, and say where it came from when it is one
  // of the project's attached reference files. Both derived from the real tool
  // input — an unrecognized path just reads as its basename.
  if (
    toolName === "file_read" ||
    toolName === "file_edit" ||
    toolName === "file_write" ||
    toolName === "host_file_read"
  ) {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : "";
    if (path) {
      const basename = path.split("/").pop() ?? path;
      const label =
        knowledgeByPath?.get(path) ?? knowledgeByPath?.get(basename);
      const verb = toolName === "file_write" ? "Writing" : "Reading";
      return label
        ? `${verb} ${label} from project knowledge`
        : `${verb} ${basename}`;
    }
  }
  // Most tools carry an `activity` field — the agent's own one-line,
  // non-technical statement of what it is doing and why. That is strictly
  // better narration than "Running <tool name>", and it is the agent's real
  // words about a call it really made, so nothing is invented by using it.
  if (typeof input.activity === "string" && input.activity.trim().length > 0) {
    const activity = input.activity.trim();
    return activity.length > 120 ? `${activity.slice(0, 117)}...` : activity;
  }
  return `Running ${toolName.replace(/_/g, " ")}`;
}

/**
 * Most narration lines a single run may append to its trail. A long agent loop
 * must leave a readable story behind, not thousands of rows — past the cap the
 * live progress note still updates, only the durable trail stops growing.
 */
const MAX_TRAIL_STEPS_PER_RUN = 40;

/**
 * Stamp the latest activity line onto a running work item, deduplicated so a
 * burst of identical tool starts doesn't spam DB writes. Best-effort — a
 * failed stamp never breaks the run.
 *
 * Each DISTINCT line is also appended to the item's trail as a `run_step`
 * event, which is what turns "Running file read" into a readable account of
 * what the run actually did. Both the live note and the trail row are derived
 * from a tool call that really started.
 */
function stampProgressNote(
  workItemId: string,
  note: string,
  lastNoteRef: { current: string | null },
  trailRef?: { count: number },
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
  if (trailRef && trailRef.count < MAX_TRAIL_STEPS_PER_RUN) {
    trailRef.count += 1;
    recordWorkItemEvent({
      workItemId,
      kind: "run_step",
      actor: "runner",
      detail: note,
    });
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
export function buildWorkItemContextPreamble(
  item: WorkItem,
  agent?: Pick<Agent, "name" | "domain" | "charter"> | null,
): string {
  return buildWorkItemRunContext(item, agent).preamble;
}

/**
 * The run's assembled context, plus the index the run trail needs to narrate
 * honestly. Same work as {@link buildWorkItemContextPreamble} — the knowledge
 * files are materialized exactly once — with the resolved attachments handed
 * back so a mid-run `file_read` of one of those paths can be described as
 * "Reading <label> from project knowledge" instead of "Running file read".
 */
export interface WorkItemRunContext {
  preamble: string;
  /** Absolute path AND basename → the knowledge entry's display label. */
  knowledgeByPath: Map<string, string>;
}

export function buildWorkItemRunContext(
  item: WorkItem,
  agent?: Pick<Agent, "name" | "domain" | "charter"> | null,
): WorkItemRunContext {
  const sections: string[] = [];
  const knowledgeByPath = new Map<string, string>();

  // Agent mandate: when the item runs as a staffed role, lead with who it's
  // acting as and its standing charter, so the run is carried out in that
  // role's remit rather than as the generic house agent.
  if (agent && (agent.charter?.trim() || agent.domain?.trim())) {
    const domain = agent.domain?.trim();
    const header = domain
      ? `## Acting as: ${agent.name} — ${domain}`
      : `## Acting as: ${agent.name}`;
    const charter = agent.charter?.trim();
    sections.push(charter ? `${header}\nStanding mandate: ${charter}` : header);
  }

  if (item.projectId) {
    const project = getProject(item.projectId);
    if (project) {
      const header = `## Project: ${project.title}`;
      const brief = project.context?.trim();
      sections.push(brief ? `${header}\n${brief}` : header);

      // Project knowledge — never let a knowledge failure break the run.
      try {
        const entries = ensureProjectKnowledgeFiles(project.id);
        for (const entry of entries) {
          if (entry.kind !== "file" || !entry.absPath) continue;
          knowledgeByPath.set(entry.absPath, entry.label);
          const basename = entry.absPath.split("/").pop();
          if (basename) knowledgeByPath.set(basename, entry.label);
        }
        const knowledge = buildProjectKnowledgeSection(entries);
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

  if (sections.length === 0) return { preamble: "", knowledgeByPath };
  return {
    preamble: [
      "You are working a task inside a project. Use the following context to inform how you carry it out.",
      "",
      sections.join("\n\n"),
      "",
      "---",
      "",
    ].join("\n"),
    knowledgeByPath,
  };
}

interface AssessmentGate {
  assessment: WorkItemAssessment | null;
  /** True when the run must NOT proceed — the item parks with the verdict. */
  holdRun: boolean;
}

/**
 * Run the pre-run assessment and decide whether the execution turn happens.
 *
 * Two deliberate properties:
 *
 *  - **Fail open.** A missing verdict (no provider, timeout, malformed reply,
 *    assessment disabled) is never a reason to hold a run back.
 *  - **Ask once, never nag.** A non-`execute` verdict holds the run the FIRST
 *    time it is produced. Because the item then parks and only an explicit
 *    human run can un-park it, a second dispatch on unchanged inputs is the
 *    user saying "I've seen the question — go anyway", so the run proceeds
 *    (with the verdict still stamped for surfaces to show).
 */
async function evaluateAssessmentGate(
  item: WorkItem,
  contextPreamble: string,
): Promise<AssessmentGate> {
  const priorRunNote = item.lastRunStatus
    ? `the previous run of this task ${item.lastRunStatus}`
    : null;
  const { assessment, alreadySurfaced } = await assessWorkItem({
    item,
    contextPreamble,
    capabilities: buildCapabilitySnapshot(),
    priorRunNote,
  });
  if (!assessment || assessment.verdict === "execute") {
    return { assessment, holdRun: false };
  }
  return {
    assessment,
    holdRun: isAssessmentGateEnabled() && !alreadySurfaced,
  };
}

/**
 * Return an item the assessment held back to the queue, parked, with the
 * verdict already persisted by the assessor. Parking (rather than failing) is
 * the honest state: nothing went wrong, Cue simply needs something before it
 * can do this well — and parked items never auto-run, so only an explicit
 * human run restarts it.
 */
function parkForAssessment(
  workItemId: string,
  fromStatus: WorkItemStatus,
  assessment: WorkItemAssessment | null,
): void {
  // The assessment call is in-flight for a second or two; if the item was
  // cancelled meanwhile, that decision wins — never resurrect it to `queued`.
  const current = getWorkItem(workItemId);
  if (current && current.status !== "running") {
    log.info(
      { workItemId, status: current.status },
      "assessment verdict arrived after the item left the run — not parking",
    );
    return;
  }
  const note = assessment ? narrationForAssessment(assessment) : null;
  updateWorkItem(
    workItemId,
    {
      status: "queued",
      autoRunEligibility: "parked",
      lastProgressNote: note,
    },
    { actor: "assessor" },
  );
  // The status transition itself is recorded by the store's single choke point
  // (actor "assessor"); the `assessed` row the assessor already wrote carries
  // the narration, so nothing extra is appended here.
  log.info(
    { workItemId, fromStatus, verdict: assessment?.verdict },
    "work item held before its run by the pre-run assessment",
  );
  broadcastWorkItemStatus(workItemId);
  broadcastMessage({ type: "tasks_changed" } as ServerMessage);
}

/** Human one-liner for a budget hard-stop, stamped on `lastProgressNote`. */
function budgetStopReason(b: BudgetCheckResult): string {
  const usd = (c: number | null) => `$${((c ?? 0) / 100).toFixed(2)}`;
  const who = b.scope === "agent" ? `Agent "${b.label}"` : "This task";
  return `Stopped: ${who} reached its budget — ${usd(b.spentCents)} of ${usd(b.capCents)} spent. Raise the cap to continue.`;
}

/**
 * Run a work item in the background. Returns immediately after validation;
 * the execution itself happens asynchronously.
 *
 * When called from a chat tool (e.g. Telegram), required tools are
 * auto-approved since the user explicitly requested execution.
 *
 * The async phase begins with the pre-run assessment (see
 * {@link evaluateAssessmentGate}): the item is already `running` at that point,
 * and a non-`execute` verdict returns it to the queue, parked, with its
 * question / missing thing surfaced. Dispatch stays synchronous — every caller
 * gets its `{ success }` immediately, exactly as before — which is why the
 * verdict is applied one step INSIDE the run rather than before it.
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
  // Guardrails per-agent model pin: a background run executes as the item's
  // assignee; when that agent pins a model, the run conversation is created
  // with the existing `modelOverride` mechanism — an explicit per-call model
  // that wins over profile/call-site resolution in the provider layer
  // (RetryProvider.normalizeSendMessageOptions treats config.model as
  // authoritative). Null assignee = the house agent "cue" (never pinned).
  // Resolved once up front so every turn of the run uses the same model, and
  // so its charter can lead the run preamble.
  const runAgent = getAgentByAssignee(workItem.assignee);
  const { preamble: contextPreamble, knowledgeByPath } =
    buildWorkItemRunContext(workItem, runAgent);
  const pinnedModel = runAgent?.model ?? null;
  // Guardrails agent tool scopes are applied from the persisted binding by
  // `applyAgentBinding` below, so the same rules survive eviction and restart
  // rather than living only on this run's conversation object.

  // WS1 budget hard-stop (run boundary — mirrors the mission cycle-boundary
  // check in mission-orchestrator): if the item's agent (opted into hard-stop
  // via `hard_stop_enabled`) or its per-task budget is exhausted, stop BEFORE
  // spending more. Set the item `failed` with a budget reason on
  // `lastProgressNote` + a `budget_stop` event so it surfaces as a resolvable
  // incident. Advisory caps / no task budget → `ok` → today's behavior; this
  // returns early ONLY when a user opted into enforcement.
  const budget = checkRunStartBudget(workItem.assignee ?? "cue", workItemId);
  if (budget.state === "hard_stop") {
    const reason = budgetStopReason(budget);
    updateWorkItem(
      workItemId,
      { status: "failed", lastRunStatus: "failed", lastProgressNote: reason },
      { actor: "runner" },
    );
    recordWorkItemEvent({
      workItemId,
      kind: "budget_stop",
      fromStatus: workItem.status,
      toStatus: "failed",
      actor: "budget",
    });
    broadcastWorkItemStatus(workItemId);
    broadcastMessage({ type: "tasks_changed" } as ServerMessage);
    log.warn(
      {
        workItemId,
        scope: budget.scope,
        spentCents: budget.spentCents,
        capCents: budget.capCents,
      },
      "work item run blocked: budget hard-stop",
    );
    return { success: false, error: reason, errorCode: "budget_stop" };
  }
  if (budget.state === "warn") {
    log.info(
      { workItemId, scope: budget.scope, pct: budget.pct },
      "work item near budget (running anyway)",
    );
  }

  // A fresh run starts with a clean approval-timeout slate — records from an
  // earlier run of this item must not leak into this run's terminal note.
  clearApprovalTimeouts(workItemId);

  // Set status to running. Dispatch also consumes any user-parked marker:
  // reaching this point means an explicit run (Run button / came-in confirm /
  // CLI) or a gate that already ruled the item eligible, so the item is no
  // longer "parked" — and a later stranded-run recovery may retry it.
  updateWorkItem(
    workItemId,
    { status: "running", autoRunEligibility: null },
    { actor: "runner" },
  );
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
  // Narration rows this run has appended to the item's trail (capped).
  const trailSteps = { count: 0 };
  void (async () => {
    try {
      // Pre-run assessment: understand the task, decide whether Cue can
      // actually do it with the context this run will receive, and narrate the
      // plan — BEFORE spending a full agent turn. A non-`execute` verdict
      // returns the item to the queue (parked) with its question / missing
      // thing surfaced, instead of producing plausible garbage. Fails open:
      // when the assessment can't be made, the run proceeds exactly as before.
      stampProgressNote(workItemId, ASSESSING_PROGRESS_NOTE, lastProgressNote);
      const gate = await evaluateAssessmentGate(workItem, contextPreamble);
      if (gate.holdRun) {
        parkForAssessment(workItemId, workItem.status, gate.assessment);
        return;
      }
      if (gate.assessment) {
        // The plan is the item's first honest activity line: what Cue is about
        // to do, in the user's words, before any tool has run.
        stampProgressNote(
          workItemId,
          narrationForAssessment(gate.assessment),
          lastProgressNote,
        );
      }

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
            // Persist the agent on the conversation as well as applying it
            // here. Applying alone lasted only as long as this in-memory
            // object: the evictor sweeps idle conversations and a restart
            // drops them all, after which the conversation rehydrated with no
            // tool scopes at all. An agent the owner deliberately restricted
            // then answered their next message unrestricted.
            setConversationAgentId(conversationId, runAgent?.id ?? null);
            applyAgentBinding(conversation, runAgent);
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
            // Stamp the persisted user row when it carries the injected
            // project/task context preamble, so clients can collapse it into
            // a quiet "Project context" affordance instead of rendering the
            // scaffolding as a raw user bubble.
            ...(contextPreamble
              ? { persistMetadata: { taskRunContext: true } }
              : {}),
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
                  progressNoteForToolStart(
                    e.toolName,
                    e.input ?? {},
                    knowledgeByPath,
                  ),
                  lastProgressNote,
                  trailSteps,
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
      // Approval prompts that expired unanswered during this run: consumed
      // unconditionally (so a cancelled run doesn't leak registry entries) and
      // persisted as the item's terminal note — an awaiting_review item that
      // silently skipped its send/publish step must not LOOK fine.
      const skippedApprovals = consumeApprovalTimeouts(workItemId);
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
            // linger on a finished item. But a run that skipped steps because
            // approvals timed out keeps saying so, so review surfaces flag it.
            lastProgressNote:
              skippedApprovals.length > 0
                ? buildSkippedStepsNote(skippedApprovals)
                : null,
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
      // Drain the registry even on a crashed run; keep the skipped-steps note
      // when approvals timed out before the crash, so the failure record still
      // says which side-effect steps never happened.
      const skippedApprovals = consumeApprovalTimeouts(workItemId);
      updateWorkItem(
        workItemId,
        {
          status: "failed",
          lastRunStatus: "failed",
          lastProgressNote:
            skippedApprovals.length > 0
              ? buildSkippedStepsNote(skippedApprovals)
              : null,
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
