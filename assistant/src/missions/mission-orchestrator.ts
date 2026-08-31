/**
 * Mission orchestrator — the per-mission cycle runner at the heart of the
 * HQ/Missions harness (Phase 1). Modeled on HeartbeatService (guards, run
 * records, kill switch) but goal-scoped: each ACTIVE mission gets a cadenced
 * cycle that
 *
 *   (a) ASSESSES — loads the mission, its bounded continuation summary, the
 *       company profile, the linked initiative projects + their work-item
 *       state, and what landed since the last cycle;
 *   (b) PLANS — one flash/cost-optimized LLM call (the same side-chain path
 *       work-item triage uses) that decides the next concrete work items;
 *   (c) EXECUTES per the mission's autonomy mode:
 *         observe    → plan + report only, NEVER enqueues;
 *         assist     → enqueues draft-only items (they stay queued for a
 *                      human "Run it" — auto-run is skipped);
 *         autonomous → enqueues through the normal triage/auto-run path,
 *                      where the existing hard-deny guard + autonomy policy
 *                      remain authoritative;
 *   (d) REGENERATES the bounded (~8KB) continuation summary so the next
 *       cycle starts coherent instead of replaying history;
 *   (e) REPORTS — mission_events audit rows + a client-facing event;
 *   (f) TRACKS BUDGET — cycle LLM cost increments spent_cents and the
 *       mission hard-stops (status=paused + budget_stop event) at its cap.
 *
 * Exact-once decomposition: the cycle claims a (mission, plan-hash)
 * fingerprint BEFORE enqueuing, so a crashed or re-run cycle that produces
 * the same plan can never duplicate work items.
 *
 * Absorbed from Paperclip (MIT, github.com/paperclipai/paperclip):
 *   - the plan-to-tasks decomposition doctrine in the planning prompt
 *     (skills/paperclip-converting-plans-to-tasks/SKILL.md),
 *   - the exact-once fingerprint (sourceIssueId/planRevisionId + wake-queue
 *     idempotency keys → mission_plan_fingerprints),
 *   - the bounded regenerated continuation summary
 *     (server/src/services/issue-continuation-summary.ts).
 *
 * Kill switch: CUE_DISABLE_MISSION_ORCHESTRATOR skips scheduled cycles;
 * manual run-cycle triggers pass `force` and still run (heartbeat semantics).
 */

import { createHash, randomUUID } from "node:crypto";

import { getDisableMissionOrchestrator } from "../config/env-registry.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { createTask } from "../tasks/task-store.js";
import {
  buildPricingUsageFromResponse,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { getLogger } from "../util/logger.js";
import { listAgents } from "../work-items/agent-store.js";
import {
  createWorkItem,
  listWorkItems,
  type WorkItem,
} from "../work-items/work-item-store.js";
import {
  conservativeRequiredToolsForCapture,
  triageAndMaybeAutoRunWorkItem,
} from "../work-items/work-item-triage.js";
import { surfaceBlockedMission } from "./mission-blocked-surface.js";
import {
  claimMissionPlanFingerprint,
  type CompanyProfile,
  CONTINUATION_SUMMARY_MAX_CHARS,
  getCompanyProfile,
  getMission,
  listMissionProjects,
  listMissions,
  maybeEmitMissionDrift,
  type Mission,
  type MissionMode,
  recordMissionEvent,
  updateMission,
} from "./mission-store.js";

const log = getLogger("mission-orchestrator");

/** How often the scheduler sweeps for due missions. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** The planning LLM call must not dawdle — a cycle is background work. */
const PLAN_TIMEOUT_MS = 30_000;

/** Never enqueue more than this many items from one cycle. */
const MAX_ITEMS_PER_CYCLE = 5;

/** Per-section bound inside the continuation summary. */
const SUMMARY_SECTION_MAX_CHARS = 1_200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissionPlanItem {
  /** Target initiative project id (must be one of the mission's linked projects). */
  projectId: string | null;
  title: string;
  notes: string | null;
  /**
   * Staffed agent the planner assigned this item to (a roster agent name), or
   * null for the house agent. Validated against the live roster before it lands
   * on the work item's `assignee`; an unknown name falls back to the house agent.
   */
  assignee: string | null;
}

export interface MissionPlan {
  /** One-paragraph state assessment against the mission outcome. */
  assessment: string;
  /** Concrete next work items (empty = nothing worth doing this cycle). */
  items: MissionPlanItem[];
  /** The report line for the user + the seed for "Next Action". */
  report: string;
}

export interface MissionPlannerResult {
  text: string;
  /** Cycle LLM cost in cents, where trackable (0 when unpriced). */
  costCents: number;
}

export interface MissionOrchestratorDeps {
  /**
   * Planner override (tests). Production default runs the flash side-chain
   * (`runBtwSidechain`, `conversationTitle` call site — the same
   * cost-optimized path work-item triage uses) and prices the response.
   */
  planner?: (prompt: string) => Promise<MissionPlannerResult>;
  /** Scheduler sweep interval override (tests). */
  sweepIntervalMs?: number;
}

export interface MissionCycleResult {
  ran: boolean;
  reason:
    | "completed"
    | "disabled"
    | "not_found"
    | "not_active"
    | "budget_exhausted"
    | "overlap"
    | "plan_failed";
  /** Work items enqueued this cycle. */
  enqueued: number;
  /** True when the plan fingerprint was already claimed (duplicate plan). */
  duplicatePlan?: boolean;
  cycleId?: string;
}

// ---------------------------------------------------------------------------
// Plan parsing (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Every balanced `{...}` span in `text`, outermost first, in source order.
 *
 * Written as a brace scan rather than "first `{` to last `}`" because that
 * span is not the object when the reply contains more than one. A reasoning
 * model emits its thinking before the answer, and any brace in that prose —
 * a code sketch, a quoted payload, an aside — becomes the start of the slice
 * while the real plan supplies the end, producing a span that spans both and
 * parses as nothing. That is the shape of most planner parse failures.
 *
 * String literals are tracked so a brace inside `"…"` cannot open or close a
 * span, and escapes are honoured so `"\""` does not end the string early.
 */
function balancedJsonSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/** Whether a parsed object carries any field a plan is supposed to have. */
function looksLikePlan(v: unknown): boolean {
  if (typeof v !== "object" || v == null) return false;
  const o = v as Record<string, unknown>;
  return "assessment" in o || "items" in o || "report" in o;
}

/**
 * Parse the planner's JSON reply.
 *
 * Tolerant on purpose: this runs against an open-weight model, and a cycle
 * that is discarded for phrasing costs a real planning pass and leaves the
 * mission looking idle. Prod recorded 12 of 80 cycles ending in "planner
 * produced no parseable plan" — the same failure class as a strict sentinel
 * match, and the same fix: read the shape, not the exact bytes.
 *
 * Of the candidate objects in the reply, the LAST plan-shaped one wins. When
 * a model reasons before answering, its answer comes last; an object quoted
 * mid-thought is a draft, not the conclusion.
 */
export function parseMissionPlan(text: string): MissionPlan | null {
  // Fenced blocks are unwrapped first so ```json ... ``` cannot leave the
  // fence markers inside a candidate span.
  const unfenced = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const candidates = balancedJsonSpans(unfenced);
  let chosen: unknown;
  for (const span of candidates) {
    try {
      const value: unknown = JSON.parse(span);
      if (looksLikePlan(value)) chosen = value;
    } catch {
      // Not JSON, or a fragment — try the next span.
    }
  }
  if (chosen === undefined) return null;
  try {
    const parsed = chosen as {
      assessment?: unknown;
      items?: unknown;
      report?: unknown;
    };
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: MissionPlanItem[] = [];
    for (const raw of rawItems) {
      if (typeof raw !== "object" || raw == null) continue;
      const r = raw as {
        projectId?: unknown;
        title?: unknown;
        notes?: unknown;
        assignee?: unknown;
      };
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) continue;
      items.push({
        projectId: typeof r.projectId === "string" ? r.projectId : null,
        title,
        notes:
          typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : null,
        assignee:
          typeof r.assignee === "string" && r.assignee.trim()
            ? r.assignee.trim()
            : null,
      });
    }
    return {
      assessment:
        typeof parsed.assessment === "string" ? parsed.assessment.trim() : "",
      items: items.slice(0, MAX_ITEMS_PER_CYCLE),
      report: typeof parsed.report === "string" ? parsed.report.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * Stable exact-once hash over the plan's actionable content. Only the items
 * matter — two cycles that phrase the assessment differently but plan the
 * same work must collide so the second never duplicates.
 */
export function computePlanHash(items: MissionPlanItem[]): string {
  const canonical = JSON.stringify(
    items.map((i) => ({
      p: i.projectId ?? "",
      t: i.title.trim().toLowerCase(),
      n: (i.notes ?? "").trim().toLowerCase(),
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Prompt building (exported for tests)
// ---------------------------------------------------------------------------

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 2)).trimEnd()}…`;
}

interface AssessedState {
  mission: Mission;
  profile: CompanyProfile;
  mode: MissionMode;
  linkedProjects: Array<{
    id: string;
    title: string;
    emoji: string | null;
    status: string;
  }>;
  openItems: WorkItem[];
  /** Items that landed in linked projects since the last cycle (inbound). */
  inboundItems: WorkItem[];
  /** Items finished since the last cycle. */
  finishedItems: WorkItem[];
}

function assessMission(mission: Mission): AssessedState {
  const profile = getCompanyProfile();
  const mode: MissionMode = mission.mode ?? profile.workspaceMode;
  const linkedProjects = listMissionProjects(mission.id);
  const since = mission.lastCycleAt ?? mission.createdAt;

  const openItems: WorkItem[] = [];
  const inboundItems: WorkItem[] = [];
  const finishedItems: WorkItem[] = [];
  for (const project of linkedProjects) {
    for (const item of listWorkItems({ projectId: project.id })) {
      if (
        item.status === "queued" ||
        item.status === "running" ||
        item.status === "awaiting_review"
      ) {
        openItems.push(item);
      }
      if (item.createdAt > since) inboundItems.push(item);
      if (
        (item.status === "done" || item.status === "failed") &&
        item.updatedAt > since
      ) {
        finishedItems.push(item);
      }
    }
  }
  return {
    mission,
    profile,
    mode,
    linkedProjects,
    openItems,
    inboundItems,
    finishedItems,
  };
}

/**
 * Build the planning prompt for one cycle.
 *
 * The planning doctrine block is adapted from Paperclip (MIT,
 * github.com/paperclipai/paperclip), skills/paperclip-converting-plans-to-tasks/SKILL.md:
 * plan deeply, every concrete deliverable becomes a task, order-then-
 * parallelize, "enough is enough" (don't split work smaller than the split
 * costs), and surface gaps instead of papering over them.
 */
export function buildMissionPlanPrompt(state: AssessedState): string {
  const { mission, profile, mode } = state;
  const lines: string[] = [];
  lines.push(`Today is ${new Date().toString()}.`);
  lines.push("");
  lines.push(
    "You are the mission orchestrator for a founder's AI chief-of-staff. One mission, one planning cycle: assess where the mission stands and decide the next concrete work items.",
  );
  lines.push("");
  lines.push("<company>");
  if (profile.identity)
    lines.push(`Who we are: ${truncate(profile.identity, 600)}`);
  if (profile.direction) {
    lines.push(`Direction: ${truncate(profile.direction, 600)}`);
  }
  lines.push("</company>");
  if (profile.neverLines.length > 0) {
    lines.push("");
    lines.push("<hard-constraints>");
    lines.push(
      "NEVER plan, suggest, or take any action that crosses these lines. They override everything else in this prompt:",
    );
    for (const line of profile.neverLines) lines.push(`- ${line}`);
    lines.push("</hard-constraints>");
  }
  lines.push("");
  lines.push("<mission>");
  lines.push(`Title: ${mission.title}`);
  lines.push(`Outcome: ${mission.outcome}`);
  if (mission.metric) lines.push(`Metric: ${mission.metric}`);
  if (mission.horizon) {
    lines.push(`Horizon: ${new Date(mission.horizon).toDateString()}`);
  }
  if (mission.brief) lines.push(`Why: ${truncate(mission.brief, 800)}`);
  lines.push("</mission>");
  if (mission.continuationSummary) {
    lines.push("");
    lines.push("<continuation-summary>");
    lines.push(mission.continuationSummary);
    lines.push("</continuation-summary>");
  }
  lines.push("");
  lines.push("<current-state>");
  if (state.linkedProjects.length === 0) {
    lines.push("No initiative projects are linked to this mission yet.");
  } else {
    lines.push("Initiative projects (the ONLY valid projectId values):");
    for (const p of state.linkedProjects) {
      lines.push(
        `  - ${p.id}: ${p.title}${p.status !== "active" ? ` (${p.status})` : ""}`,
      );
    }
  }
  if (state.openItems.length > 0) {
    lines.push("Open work items (do NOT re-plan these):");
    for (const item of state.openItems.slice(0, 20)) {
      lines.push(`  - [${item.status}] ${truncate(item.title, 120)}`);
    }
  }
  if (state.finishedItems.length > 0) {
    lines.push("Finished since last cycle:");
    for (const item of state.finishedItems.slice(0, 10)) {
      lines.push(`  - [${item.status}] ${truncate(item.title, 120)}`);
    }
  }
  if (state.inboundItems.length > 0) {
    lines.push("New inbound since last cycle:");
    for (const item of state.inboundItems.slice(0, 10)) {
      lines.push(`  - ${truncate(item.title, 120)}`);
    }
  }
  lines.push("</current-state>");

  const roster = listAgents();
  if (roster.length > 0) {
    lines.push("");
    lines.push("<roster>");
    lines.push(
      "Staffed agents you can assign each item to — set `assignee` to the exact name, or null for the default house agent:",
    );
    for (const a of roster) {
      const head = a.domain?.trim() ? `${a.name} — ${a.domain.trim()}` : a.name;
      const charter = a.charter?.trim();
      lines.push(`  - ${head}${charter ? `: ${truncate(charter, 160)}` : ""}`);
    }
    lines.push("</roster>");
  }

  lines.push("");
  // Planning doctrine — adapted from Paperclip's converting-plans-to-tasks
  // skill (MIT, github.com/paperclipai/paperclip).
  lines.push("<planning-doctrine>");
  lines.push(
    "- Plan deeply but concretely: each item must carry enough detail in its notes that an agent can act without re-asking.",
  );
  lines.push(
    "- Every concrete deliverable becomes ONE item; independent items should be runnable in parallel.",
  );
  lines.push(
    "- Enough is enough: never split work smaller than the split costs; 0 items is a valid plan when open work already covers the next step.",
  );
  lines.push(
    "- Surface gaps (missing access, decisions the human must make, external inputs) in the report instead of papering over them.",
  );
  lines.push(
    "- Assign each item to the roster agent whose remit best fits it (set `assignee` to their exact name); use the house agent (null) only when none fits.",
  );
  lines.push("</planning-doctrine>");
  lines.push("");
  if (mode === "observe") {
    lines.push(
      "This mission is in OBSERVE mode: your plan is a recommendation only — nothing will be executed. Focus the report on what you would do and what needs the human.",
    );
    lines.push("");
  }
  lines.push("Reply with ONLY a JSON object, no prose:");
  lines.push(
    '{"assessment": "<one paragraph: where the mission stands vs the outcome>", "items": [{"projectId": "<id of an existing linked project>", "title": "<imperative task title>", "notes": "<what to do + acceptance criteria>", "assignee": "<a roster agent name, or null for the house agent>"}], "report": "<one or two sentences for the founder: what moved, what is next, what needs them>"}',
  );
  lines.push(
    `items: at most ${MAX_ITEMS_PER_CYCLE}, only genuinely-next work. projectId MUST be one of the listed project ids — never invent one. Empty items array when nothing new should start.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Continuation summary (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Regenerate the bounded continuation summary after a cycle.
 *
 * Structure (objective / recent actions / blockers / next action) adapted
 * from Paperclip's issue continuation summary (MIT,
 * github.com/paperclipai/paperclip,
 * server/src/services/issue-continuation-summary.ts): a small regenerated
 * state document — never an append-only log — hard-bounded so long-running
 * missions stay coherent without unbounded context growth.
 */
export function buildMissionContinuationSummary(input: {
  mission: Mission;
  mode: MissionMode;
  cycleId: string;
  assessment: string;
  enqueuedTitles: string[];
  openItems: WorkItem[];
  report: string;
  duplicatePlan?: boolean;
}): string {
  const { mission } = input;
  const recentActions: string[] = [
    `Cycle \`${input.cycleId}\` ran at ${new Date().toISOString()} in ${input.mode} mode.`,
  ];
  if (input.assessment) {
    recentActions.push(truncate(input.assessment, SUMMARY_SECTION_MAX_CHARS));
  }
  if (input.enqueuedTitles.length > 0) {
    recentActions.push(
      `Enqueued ${input.enqueuedTitles.length} work item(s): ${input.enqueuedTitles
        .map((t) => truncate(t, 100))
        .join("; ")}.`,
    );
  } else if (input.duplicatePlan) {
    recentActions.push(
      "Plan was an exact repeat of an earlier cycle — nothing enqueued (exact-once fingerprint).",
    );
  } else if (input.mode === "observe") {
    recentActions.push("Observe mode — plan recorded, nothing enqueued.");
  } else {
    recentActions.push("No new items planned this cycle.");
  }

  const blockers: string[] = [];
  const awaiting = input.openItems.filter(
    (i) => i.status === "awaiting_review",
  );
  if (awaiting.length > 0) {
    blockers.push(
      `${awaiting.length} item(s) awaiting human review: ${awaiting
        .slice(0, 5)
        .map((i) => truncate(i.title, 80))
        .join("; ")}.`,
    );
  }
  if (
    mission.budgetCents != null &&
    mission.spentCents >= mission.budgetCents * 0.8
  ) {
    blockers.push(
      `Budget nearly exhausted: ${mission.spentCents}¢ of ${mission.budgetCents}¢ spent.`,
    );
  }

  const bullet = (items: string[], empty: string) =>
    items.length === 0 ? `- ${empty}` : items.map((i) => `- ${i}`).join("\n");

  const body = [
    "# Mission Continuation Summary",
    "",
    `- Mission: ${mission.title}`,
    `- Outcome: ${truncate(mission.outcome, 300)}${mission.metric ? ` (metric: ${mission.metric})` : ""}`,
    `- Status: ${mission.status} · mode: ${input.mode}`,
    `- Last cycle: ${input.cycleId}`,
    "",
    "## Objective",
    "",
    truncate(mission.brief ?? mission.outcome, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## Recent Actions",
    "",
    bullet(recentActions, "No recent actions captured."),
    "",
    "## Blockers / Decisions",
    "",
    bullet(blockers, "No blockers recorded by the latest cycle."),
    "",
    "## Next Action",
    "",
    `- ${truncate(input.report || "Reassess mission state next cycle.", SUMMARY_SECTION_MAX_CHARS)}`,
  ].join("\n");

  if (body.length <= CONTINUATION_SUMMARY_MAX_CHARS) return body;
  return `${body.slice(0, CONTINUATION_SUMMARY_MAX_CHARS - 20).trimEnd()}\n[truncated]`;
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

function cadenceToMs(cadence: string | null): number {
  switch (cadence) {
    case "hourly":
      return 60 * 60 * 1000;
    case "weekly":
      return 7 * 24 * 60 * 60 * 1000;
    case "daily":
    default:
      return 24 * 60 * 60 * 1000;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "HH:mm" (24h) → hour/minute, or null for anything malformed. */
function parseSweepAt(
  sweepAt: string | null,
): { hour: number; minute: number } | null {
  if (!sweepAt) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(sweepAt.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * First occurrence of the local wall-clock time `hour:minute` STRICTLY after
 * `after` (epoch ms), computed in the daemon's timezone via local Date
 * setters — DST transitions resolve the way the wall clock does.
 *
 * @internal Exported for testing.
 */
export function nextSweepOccurrenceAfter(
  after: number,
  hour: number,
  minute: number,
): number {
  const d = new Date(after);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= after) {
    d.setDate(d.getDate() + 1);
    // Re-anchor: crossing a DST boundary with setDate can shift the
    // wall-clock time.
    d.setHours(hour, minute, 0, 0);
  }
  return d.getTime();
}

/**
 * @internal Exported for testing.
 *
 * Dueness rules:
 *  - never-ran missions are due immediately (unchanged);
 *  - hourly cadence is a rolling interval (sweepAt ignored, unchanged);
 *  - daily + sweepAt: due at the first occurrence of the sweep clock after
 *    the last cycle — one sweep per day, anchored to the wall clock in the
 *    daemon's tz rather than drifting with restarts/manual runs;
 *  - weekly + sweepAt: due at the sweep clock on the 7th day after the last
 *    cycle (anchor = lastCycleAt + 6 days, then the next clock occurrence);
 *  - null/malformed sweepAt (legacy rows): rolling interval, so old data
 *    keeps its exact pre-clock behavior.
 */
export function isMissionCycleDue(mission: Mission, now = Date.now()): boolean {
  if (mission.status !== "active") return false;
  if (mission.lastCycleAt == null) return true;
  const sweep = parseSweepAt(mission.sweepAt);
  if (sweep && mission.cadence !== "hourly") {
    const anchor =
      mission.cadence === "weekly"
        ? mission.lastCycleAt + 6 * DAY_MS
        : mission.lastCycleAt;
    return now >= nextSweepOccurrenceAfter(anchor, sweep.hour, sweep.minute);
  }
  return now - mission.lastCycleAt >= cadenceToMs(mission.cadence);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class MissionOrchestrator {
  private static instance?: MissionOrchestrator;

  /** The running orchestrator singleton (set at construction). */
  static getInstance(): MissionOrchestrator | undefined {
    return MissionOrchestrator.instance;
  }

  private readonly deps: MissionOrchestratorDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Overlap prevention: mission ids with a cycle currently in flight. */
  private readonly activeCycles = new Set<string>();

  constructor(deps: MissionOrchestratorDeps = {}) {
    this.deps = deps;
    MissionOrchestrator.instance = this;
  }

  /** Start the cadence sweeper (a simple timer, like the heartbeat's interval mode). */
  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.sweepOnce().catch((err) => {
        log.error({ err }, "Mission orchestrator sweep failed");
      });
    }, intervalMs);
    this.timer.unref();
    log.info({ intervalMs }, "Mission orchestrator started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Mission orchestrator stopped");
  }

  /** One scheduler sweep: run a cycle for every due active mission. */
  async sweepOnce(): Promise<void> {
    // Read the kill switch at sweep time so a supervisor env change takes
    // effect without a daemon restart (same contract as work-item auto-run).
    if (getDisableMissionOrchestrator()) return;
    const active = listMissions({ status: "active" });
    const due = active.filter((m) => isMissionCycleDue(m));
    for (const mission of due) {
      try {
        await this.runCycle(mission.id);
      } catch (err) {
        log.error(
          { missionId: mission.id, err: String(err) },
          "Mission cycle threw",
        );
      }
    }
    // Drift pass (§6 lifecycle): after cycles run this sweep, nudge any active
    // mission that has idled for DRIFT_STALE_CYCLES cycles with nothing to run.
    // Derived from the event trail, idempotent per cycle window, and never
    // touches a paused/achieved mission — a best-effort observation only.
    for (const mission of active) {
      try {
        maybeEmitMissionDrift(mission.id);
      } catch (err) {
        log.warn(
          { missionId: mission.id, err: String(err) },
          "mission drift check failed (ignored)",
        );
      }
    }
  }

  /**
   * Run one full cycle for a mission. `force` (the manual run-cycle route)
   * bypasses the kill switch — an explicit operator action — but NEVER the
   * status or budget guards: paused/achieved/abandoned missions don't cycle,
   * and a budget-exhausted mission hard-stops no matter who asks.
   */
  async runCycle(
    missionId: string,
    opts: { force?: boolean } = {},
  ): Promise<MissionCycleResult> {
    if (!opts.force && getDisableMissionOrchestrator()) {
      return { ran: false, reason: "disabled", enqueued: 0 };
    }
    if (this.activeCycles.has(missionId)) {
      return { ran: false, reason: "overlap", enqueued: 0 };
    }
    const mission = getMission(missionId);
    if (!mission) return { ran: false, reason: "not_found", enqueued: 0 };
    if (mission.status !== "active") {
      return { ran: false, reason: "not_active", enqueued: 0 };
    }
    // Budget pre-check — a mission that already burned its cap pauses
    // immediately instead of spending more.
    if (
      mission.budgetCents != null &&
      mission.spentCents >= mission.budgetCents
    ) {
      this.hardStopForBudget(mission, null);
      return { ran: false, reason: "budget_exhausted", enqueued: 0 };
    }

    this.activeCycles.add(missionId);
    try {
      return await this.executeCycle(mission);
    } finally {
      this.activeCycles.delete(missionId);
    }
  }

  private async executeCycle(mission: Mission): Promise<MissionCycleResult> {
    const cycleId = randomUUID();
    const state = assessMission(mission);
    recordMissionEvent({
      missionId: mission.id,
      kind: "cycle_started",
      cycleId,
      payload: {
        mode: state.mode,
        linkedProjects: state.linkedProjects.length,
        openItems: state.openItems.length,
        inbound: state.inboundItems.length,
      },
    });

    // ── Plan ─────────────────────────────────────────────────────────
    const prompt = buildMissionPlanPrompt(state);
    let plannerResult: MissionPlannerResult | null = null;
    try {
      plannerResult = await (this.deps.planner ?? defaultPlanner)(prompt);
    } catch (err) {
      log.warn(
        { missionId: mission.id, err: String(err) },
        "mission planning call failed",
      );
    }
    const plan = plannerResult ? parseMissionPlan(plannerResult.text) : null;
    const costCents = plannerResult?.costCents ?? 0;

    if (!plan) {
      recordMissionEvent({
        missionId: mission.id,
        kind: "error",
        cycleId,
        payload: { error: "planner produced no parseable plan" },
      });
      // A planner that cannot answer looks identical, from outside, to a
      // mission with nothing to do. Say which it is, once, in the lane the
      // owner reads — repeats fold into the same row.
      surfaceBlockedMission({
        missionId: mission.id,
        missionTitle: mission.title,
        kind: "planner_failing",
        reason:
          "The planner could not produce a usable plan for this mission. Recent cycles have run and cost money without producing work. Check the mission brief and the model behind the planner call site.",
      });
      // The failed call still cost money and the cycle still happened —
      // account for both so a wedged planner can't loop for free.
      this.finalizeSpendAndCadence(mission, cycleId, costCents);
      return { ran: true, reason: "plan_failed", enqueued: 0, cycleId };
    }

    recordMissionEvent({
      missionId: mission.id,
      kind: "planned",
      cycleId,
      payload: {
        mode: state.mode,
        assessment: truncate(plan.assessment, 1_000),
        items: plan.items.map((i) => ({
          projectId: i.projectId,
          title: truncate(i.title, 200),
        })),
      },
    });

    // ── Execute (mode-gated) ─────────────────────────────────────────
    let enqueued = 0;
    let duplicatePlan = false;
    const enqueuedTitles: string[] = [];
    const validProjectIds = new Set(
      state.linkedProjects
        .filter((p) => p.status === "active")
        .map((p) => p.id),
    );

    // A plan with no items is the normal shape of a blocked mission, not an
    // idle one: production ran 68 planning cycles and enqueued four items,
    // while the assessments said plainly what was in the way. Surface the
    // planner's own words — they are more specific and more actionable than
    // anything synthesized here ("create a 'Seed Fundraising' project and
    // link it"). Deduped by (mission, kind), so a daily repeat refreshes one
    // row rather than adding one.
    if (
      state.mode !== "observe" &&
      plan.items.length === 0 &&
      plan.assessment
    ) {
      surfaceBlockedMission({
        missionId: mission.id,
        missionTitle: mission.title,
        kind: "awaiting_owner",
        reason: plan.assessment,
      });
    }

    if (state.mode !== "observe" && plan.items.length > 0) {
      if (validProjectIds.size === 0) {
        recordMissionEvent({
          missionId: mission.id,
          kind: "checkpoint",
          cycleId,
          payload: {
            note: "plan produced items but the mission has no active linked projects — nothing enqueued",
          },
        });
        // The most common way a mission stalls, and the most fixable: it
        // planned real work and had nowhere to put it. As a checkpoint event
        // this was invisible, so the mission looked idle rather than blocked
        // on a one-time setup step.
        surfaceBlockedMission({
          missionId: mission.id,
          missionTitle: mission.title,
          kind: "no_linked_project",
          reason:
            plan.assessment ||
            "This mission planned work but has no active linked project, so nothing could be enqueued. Link a project to the mission and the plan will run on the next cycle.",
        });
      } else {
        const planHash = computePlanHash(plan.items);
        // Exact-once: claim the fingerprint BEFORE enqueuing. A crashed
        // cycle that already claimed (and possibly enqueued) can never
        // duplicate on retry; the re-run degrades to report-only.
        if (!claimMissionPlanFingerprint(mission.id, planHash)) {
          duplicatePlan = true;
          recordMissionEvent({
            missionId: mission.id,
            kind: "checkpoint",
            cycleId,
            payload: {
              note: "duplicate plan fingerprint — skipped enqueue",
              planHash,
            },
          });
        } else {
          const fallbackProjectId = state.linkedProjects.find(
            (p) => p.status === "active",
          )!.id;
          // Resolve the planner's `assignee` names against the live roster
          // (case-insensitive → canonical name). Unknown names fall through to
          // the house agent, so a hallucinated role never orphans an item.
          const rosterByLower = new Map(
            listAgents().map((a) => [a.name.toLowerCase(), a.name]),
          );
          for (const planItem of plan.items) {
            const assignee = planItem.assignee
              ? rosterByLower.get(planItem.assignee.toLowerCase())
              : undefined;
            const projectId =
              planItem.projectId && validProjectIds.has(planItem.projectId)
                ? planItem.projectId
                : fallbackProjectId;
            const template = planItem.notes ?? planItem.title;
            // Mirrors the quick-add route: work_items.taskId needs a real
            // tasks row, so mint a lightweight template per item.
            const task = createTask({ title: planItem.title, template });
            // The planner doesn't emit per-item tools, so stamp the
            // conservative read-only snapshot — it classifies to "research"
            // instead of the fail-closed "other", letting autonomous-mode
            // items actually pass the auto-run policy gate. Items whose
            // text implies a side-effect deliverable keep an empty
            // snapshot and park for human review.
            const requiredTools = conservativeRequiredToolsForCapture(
              planItem.title,
              template,
            );
            const item = createWorkItem({
              taskId: task.id,
              title: planItem.title,
              ...(planItem.notes ? { notes: planItem.notes } : {}),
              ...(requiredTools ? { requiredTools } : {}),
              ...(assignee ? { assignee } : {}),
              projectId,
              sourceType: "mission",
              sourceId: mission.id,
              sourceContext: JSON.stringify({
                origin: "mission",
                missionId: mission.id,
                cycleId,
                snippet: truncate(template, 500),
                capturedAt: Date.now(),
              }),
              actor: "mission-orchestrator",
            });
            enqueued++;
            enqueuedTitles.push(planItem.title);
            recordMissionEvent({
              missionId: mission.id,
              kind: "item_enqueued",
              cycleId,
              payload: {
                workItemId: item.id,
                projectId,
                title: truncate(planItem.title, 200),
                mode: state.mode,
              },
            });
            // assist → draft-only: triage fills the blanks but the item
            // stays queued for a human "Run it". autonomous → the normal
            // capture path, where the existing hard-deny guard and the
            // per-category autonomy policy stay authoritative.
            await triageAndMaybeAutoRunWorkItem(item.id, {
              skipAutoRun: state.mode !== "autonomous",
            });
          }
        }
      }
    }

    // ── Continuation summary ─────────────────────────────────────────
    const summary = buildMissionContinuationSummary({
      mission,
      mode: state.mode,
      cycleId,
      assessment: plan.assessment,
      enqueuedTitles,
      openItems: state.openItems,
      report: plan.report,
      duplicatePlan,
    });
    updateMission(mission.id, { continuationSummary: summary });

    // ── Report ───────────────────────────────────────────────────────
    recordMissionEvent({
      missionId: mission.id,
      kind: "reported",
      cycleId,
      payload: {
        report: truncate(plan.report, 1_000),
        enqueued,
        mode: state.mode,
        costCents,
      },
    });
    publishClientEvent();

    // ── Budget + cadence bookkeeping ─────────────────────────────────
    this.finalizeSpendAndCadence(mission, cycleId, costCents);

    log.info(
      { missionId: mission.id, cycleId, mode: state.mode, enqueued, costCents },
      "mission cycle completed",
    );
    return { ran: true, reason: "completed", enqueued, duplicatePlan, cycleId };
  }

  /** Stamp last_cycle_at + spend; hard-stop the mission at its budget cap. */
  private finalizeSpendAndCadence(
    mission: Mission,
    cycleId: string | null,
    costCents: number,
  ): void {
    const spentCents = mission.spentCents + Math.max(0, costCents);
    updateMission(mission.id, { spentCents, lastCycleAt: Date.now() });
    if (mission.budgetCents != null && spentCents >= mission.budgetCents) {
      this.hardStopForBudget({ ...mission, spentCents }, cycleId);
    }
  }

  private hardStopForBudget(mission: Mission, cycleId: string | null): void {
    // Idempotent: pausing an already-paused mission is a no-op write.
    updateMission(mission.id, { status: "paused" });
    recordMissionEvent({
      missionId: mission.id,
      kind: "budget_stop",
      ...(cycleId ? { cycleId } : {}),
      payload: {
        spentCents: mission.spentCents,
        budgetCents: mission.budgetCents,
        note: "budget cap reached — mission paused",
      },
    });
    publishClientEvent();
    log.warn(
      {
        missionId: mission.id,
        spentCents: mission.spentCents,
        budgetCents: mission.budgetCents,
      },
      "mission hard-stopped at budget cap",
    );
  }
}

// ---------------------------------------------------------------------------
// Default planner (flash side-chain + pricing)
// ---------------------------------------------------------------------------

async function defaultPlanner(prompt: string): Promise<MissionPlannerResult> {
  // Same flash/cost-optimized call-site pattern as work-item triage: the
  // conversationTitle site resolves to the flash model. Token budget is
  // raised locally — a plan is bigger than a title.
  const provider = await getConfiguredProvider("conversationTitle");
  if (!provider) {
    throw new Error("no LLM provider configured for mission planning");
  }
  const config = getConfig();
  const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
  const result = await runBtwSidechain({
    content: prompt,
    provider,
    systemPrompt:
      "You are a mission planning orchestrator. Reply with ONLY the requested JSON object.",
    messages: [],
    tools: [],
    callSite: "conversationTitle",
    maxTokens: Math.max(resolved.maxTokens ?? 0, 2_000),
    timeoutMs: PLAN_TIMEOUT_MS,
  });
  return {
    text: result.text,
    costCents: estimateCostCents(result.response),
  };
}

/** Price a side-chain response in cents (0 when unpriced/unknown). */
function estimateCostCents(response: {
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}): number {
  try {
    const config = getConfig();
    const providerName =
      resolveCallSiteConfig("conversationTitle", config.llm).provider ??
      "unknown";
    const usage = buildPricingUsageFromResponse(
      providerName,
      response as Parameters<typeof buildPricingUsageFromResponse>[1],
    );
    const priced = resolveStructuredPricing(
      providerName,
      response.model,
      usage,
    );
    if (priced.estimatedCostUsd == null) return 0;
    // Round up so sub-cent cycles still count against the cap — budget is a
    // hard floor of caution, not an accounting exercise.
    return Math.max(0, Math.ceil(priced.estimatedCostUsd * 100));
  } catch {
    return 0;
  }
}

function publishClientEvent(): void {
  try {
    void assistantEventHub.publish(
      buildAssistantEvent({ type: "tasks_changed" } as ServerMessage),
    );
  } catch (err) {
    log.debug({ err: String(err) }, "mission event publish failed (ignored)");
  }
}
