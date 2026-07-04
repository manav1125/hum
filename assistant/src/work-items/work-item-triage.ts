/**
 * Auto-triage + policy-gated auto-run for freshly captured work items.
 *
 * Closes the capture → execution gap: today items land in the queue at the
 * default priority and wait for a manual "Run it". This module runs right
 * after capture (fire-and-forget from every creation callsite) and does two
 * things:
 *
 *   1. TRIAGE — score urgency with the flash LLM (same side-chain path
 *      next-move narration uses) and stamp `priorityTier` (0/1/2) plus
 *      `sortIndex` (100 - urgency) so the queue is genuinely ranked, not
 *      insertion-ordered. Falls back to a deterministic keyword heuristic
 *      when no provider is configured or the call fails. Items whose caller
 *      explicitly chose a priority are left alone.
 *
 *   2. AUTO-RUN — when the user's per-category autonomy policy allows it,
 *      hand the item straight to the background runner instead of parking it
 *      in the queue. The gate is deterministic: every tool in the item's
 *      `requiredTools` snapshot is classified via `classifyAutonomy` and the
 *      item auto-runs only if EVERY class resolves to "auto" under the
 *      current policy (an item with no snapshot classifies as "other").
 *      Money/delete therefore wait for a human under the default Balanced
 *      policy, and everything defers — never denies — when the policy says
 *      ask. A concurrency cap keeps a burst of captures from stampeding the
 *      daemon, and CUE_DISABLE_WORKITEM_AUTORUN turns the behavior off
 *      entirely.
 *
 * Triage failures are non-fatal by design: the item stays queued exactly as
 * it would have before this module existed.
 */

import { getDisableWorkItemAutoRun } from "../config/env-registry.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  type AutonomyClass,
  classifyAutonomy,
} from "../permissions/autonomy-class.js";
import { getAutonomyPolicy } from "../permissions/autonomy-policy-reader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { listProjects, type Project } from "./project-store.js";
import {
  broadcastWorkItemStatus,
  runWorkItemInBackground,
} from "./work-item-runner.js";
import {
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

const log = getLogger("work-item-triage");

/** Never let auto-run start more than this many concurrent background runs. */
const MAX_AUTO_CONCURRENT_RUNS = 2;

/** Flash-LLM triage must not dawdle — fall back to heuristics past this. */
const TRIAGE_TIMEOUT_MS = 8_000;

export interface TriageOptions {
  /**
   * True when the creator (user or main-agent tool call) explicitly chose a
   * priority — triage then leaves priorityTier untouched and only fills in
   * the urgency-derived sortIndex when one wasn't provided.
   */
  callerSetPriority?: boolean;
  /** Skip the auto-run evaluation entirely (e.g. re-triage of old items). */
  skipAutoRun?: boolean;
}

interface TriageScore {
  /** 0–100; higher = more urgent. */
  urgency: number;
  /** 0 = high, 1 = medium, 2 = low — mirrors workItems.priorityTier. */
  tier: 0 | 1 | 2;
  /** An EXISTING project id this item clearly belongs to, else null. */
  projectId: string | null;
  /** Explicit deadline extracted from the text, epoch ms, else null. */
  dueAt: number | null;
}

// ---------------------------------------------------------------------------
// Deterministic fallback scoring
// ---------------------------------------------------------------------------

const HIGH_URGENCY_RE =
  /\b(urgent|asap|immediately|right away|today|tonight|this morning|this afternoon|before .*(flight|meeting|call|deadline)|deadline|overdue|expiring|expires?|by (eod|end of day|noon|tomorrow morning))\b/i;

const LOW_URGENCY_RE =
  /\b(someday|eventually|no rush|when (you|we) (get|have) (a chance|time)|low priority|nice to have|backlog|later this (month|quarter|year))\b/i;

function heuristicScore(item: WorkItem): TriageScore {
  const text = `${item.title} ${item.notes ?? ""}`;
  const base = { projectId: null, dueAt: null };
  if (HIGH_URGENCY_RE.test(text)) return { urgency: 85, tier: 0, ...base };
  if (LOW_URGENCY_RE.test(text)) return { urgency: 25, tier: 2, ...base };
  return { urgency: 50, tier: 1, ...base };
}

// ---------------------------------------------------------------------------
// Source-context stamping
// ---------------------------------------------------------------------------

/**
 * Build the `source_context` JSON snapshot stamped at triage time: the origin
 * (the capturing channel/surface — chat/voice/mcp/a channel name) plus a short
 * snippet of the original request text. The runner reads this to tell the
 * agent where a task came from. Returns a compact JSON string.
 */
export function buildSourceContext(item: WorkItem): string {
  const origin = item.sourceType ?? "chat";
  const snippetSource = item.notes?.trim() || item.title.trim();
  const snippet =
    snippetSource.length > 500
      ? `${snippetSource.slice(0, 500)}…`
      : snippetSource;
  return JSON.stringify({
    origin,
    ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    snippet,
    capturedAt: item.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Flash-LLM scoring (best-effort)
// ---------------------------------------------------------------------------

function buildTriagePrompt(item: WorkItem, projects: Project[]): string {
  const source = item.sourceType ? ` (captured from ${item.sourceType})` : "";
  const projectLines = projects
    .slice(0, 20)
    .map((p) => `  - ${p.id}: ${p.title}`);
  return [
    `Today is ${new Date().toString()}.`,
    `Task${source}: ${item.title}`,
    item.notes ? `Details: ${item.notes.slice(0, 500)}` : "",
    projectLines.length > 0
      ? `Existing projects:\n${projectLines.join("\n")}`
      : "",
    "",
    "Triage this task for a busy professional. Reply with ONLY a JSON object, no prose:",
    '{"urgency": <0-100>, "tier": <0|1|2>, "projectId": <string|null>, "dueAt": <"YYYY-MM-DDTHH:MM"|null>}.',
    "tier 0 = must happen soon (hard deadline, time-sensitive, blocking someone). tier 1 = normal. tier 2 = whenever.",
    "projectId: the id of the ONE existing project this clearly belongs to, else null. Never invent an id.",
    'dueAt: only when the text states an explicit deadline ("by Friday", "before the flight tomorrow") — resolve it to a local date-time; else null. When only a day is given, use 17:00.',
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseTriageResponse(
  text: string,
  validProjectIds: ReadonlySet<string>,
  now = Date.now(),
): TriageScore | null {
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      urgency?: unknown;
      tier?: unknown;
      projectId?: unknown;
      dueAt?: unknown;
    };
    const urgency = Number(parsed.urgency);
    const tier = Number(parsed.tier);
    if (!Number.isFinite(urgency) || !Number.isFinite(tier)) return null;
    const clampedTier = Math.min(2, Math.max(0, Math.round(tier))) as 0 | 1 | 2;
    // Hallucinated project ids are dropped — the scorer may only pick from
    // the ids it was shown, never mint one.
    const projectId =
      typeof parsed.projectId === "string" &&
      validProjectIds.has(parsed.projectId)
        ? parsed.projectId
        : null;
    // "YYYY-MM-DDTHH:MM" parses as local time; reject unparseable values and
    // anything more than a day in the past (a nonsense extraction).
    let dueAt: number | null = null;
    if (typeof parsed.dueAt === "string") {
      const t = Date.parse(parsed.dueAt);
      if (Number.isFinite(t) && t > now - 24 * 3600_000) dueAt = t;
    }
    return {
      urgency: Math.min(100, Math.max(0, Math.round(urgency))),
      tier: clampedTier,
      projectId,
      dueAt,
    };
  } catch {
    return null;
  }
}

async function scoreWithFlashLlm(
  item: WorkItem,
  projects: Project[],
): Promise<TriageScore | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildTriagePrompt(item, projects),
      provider,
      systemPrompt:
        "You are a triage scorer. Reply with ONLY the requested JSON object.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: TRIAGE_TIMEOUT_MS,
    });
    return parseTriageResponse(result.text, new Set(projects.map((p) => p.id)));
  } catch (err) {
    log.debug({ err: String(err) }, "flash triage failed; using heuristic");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Autonomy classification for auto-run
// ---------------------------------------------------------------------------

function parseRequiredTools(item: WorkItem): string[] {
  if (!item.requiredTools) return [];
  try {
    const parsed = JSON.parse(item.requiredTools) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The autonomy classes an item touches. An empty tool snapshot classifies as
 * ["other"] — the run will still hit per-tool permission gates at execution
 * time, so "other" is the honest label for "we don't know yet".
 */
export function classifyWorkItemAutonomy(item: WorkItem): AutonomyClass[] {
  const tools = parseRequiredTools(item);
  if (tools.length === 0) return ["other"];
  const classes = new Set<AutonomyClass>();
  for (const tool of tools) classes.add(classifyAutonomy(tool));
  return [...classes];
}

// ---------------------------------------------------------------------------
// Hard-deny guard for auto-run
// ---------------------------------------------------------------------------

/**
 * Tool-name segments that indicate a purchase/ordering capability. Matched on
 * whole name segments (split on non-alphanumerics), not substrings, so
 * "recorder" or "sort_order_index" style names don't false-positive.
 */
const PURCHASE_SEGMENTS: ReadonlySet<string> = new Set([
  "purchase",
  "buy",
  "checkout",
  "order",
  "orders",
  "cart",
  "pay",
  "payment",
  "charge",
  "transfer",
  "refund",
]);

/**
 * Whether a single tool must never run under the auto-runner without a human
 * in the loop — REGARDLESS of what the per-category autonomy policy says.
 *
 * The autonomy policy is a preference; this is a floor. It exists because the
 * auto-runner once picked up a physical-world errand ("buy stroopwafels")
 * whose tool snapshot included browser tools and walked into an Amazon
 * purchase flow. Categories:
 *
 *   - `host_*`: desktop host control (host_bash, host_cu, host_browser,
 *     host_app_control, host_file) — executes on the user's machine.
 *   - browser / computer-use automation — can navigate arbitrary flows,
 *     including checkout pages, with no per-action review.
 *   - purchase/order-like tools — spend money directly.
 *   - messaging egress + money (via `classifyAutonomy`) — sends on the
 *     user's behalf / moves money.
 */
export function isHardDeniedForAutoRun(toolName: string): boolean {
  const name = toolName.toLowerCase();
  const segments = name.split(/[^a-z0-9]+/).filter(Boolean);

  // Desktop host control tools all share the host_ prefix.
  if (segments[0] === "host") return true;

  // Browser & computer-use automation (core browser_* tools, MCP
  // mcp__computer-use__*, connector *_browser_* variants, …).
  if (segments.includes("browser") || segments.includes("computer")) {
    return true;
  }

  // Purchase / order-like tools by name segment.
  if (segments.some((s) => PURCHASE_SEGMENTS.has(s))) return true;

  // Messaging egress ("send") and money per the shared autonomy classifier.
  const cls = classifyAutonomy(toolName);
  return cls === "send" || cls === "money";
}

/**
 * The subset of an item's required-tools snapshot that is hard-denied for
 * auto-run. Non-empty result ⇒ the item must wait for an explicit human
 * "Run it", no matter how permissive the autonomy policy snapshot is.
 */
export function hardDeniedAutoRunTools(item: WorkItem): string[] {
  return parseRequiredTools(item).filter(isHardDeniedForAutoRun);
}

function countRunningItems(): number {
  return listWorkItems({ status: "running" }).length;
}

function isAutoRunDisabled(): boolean {
  // Read at call time so the kill-switch works without a daemon restart when
  // the process env is updated by a supervisor.
  return getDisableWorkItemAutoRun();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: triage the item, then auto-run it when policy allows.
 * Never throws — all failures degrade to "item stays queued as-is".
 */
export function triageAndMaybeAutoRunWorkItem(
  workItemId: string,
  opts: TriageOptions = {},
): void {
  void (async () => {
    try {
      await triageWorkItem(workItemId, opts);
      if (!opts.skipAutoRun) await maybeAutoRunWorkItem(workItemId);
    } catch (err) {
      log.warn({ workItemId, err: String(err) }, "work-item triage failed");
    }
  })();
}

/** Statuses in which triage has nothing useful left to contribute. */
const TRIAGE_SKIP_STATUSES: readonly string[] = ["archived", "cancelled"];

/** Exported for tests; production callers go through {@link triageAndMaybeAutoRunWorkItem}. */
export async function triageWorkItem(
  workItemId: string,
  opts: TriageOptions,
): Promise<void> {
  const item = getWorkItem(workItemId);
  if (!item || TRIAGE_SKIP_STATUSES.includes(item.status)) return;

  const projects = listProjects();
  const score =
    (await scoreWithFlashLlm(item, projects)) ?? heuristicScore(item);

  const updates: {
    priorityTier?: number;
    sortIndex?: number;
    projectId?: string;
    dueAt?: number;
    sourceContext?: string;
  } = {};
  if (!opts.callerSetPriority) updates.priorityTier = score.tier;
  // Stamp where this task came from — the creating channel/origin plus a
  // snippet of the original text — so the runner can tell the agent the
  // provenance ("this came from a WhatsApp thread") when it works the task.
  // Only fill when blank; a caller may have supplied richer source context.
  if (item.sourceContext == null) {
    updates.sourceContext = buildSourceContext(item);
  }
  // Higher urgency → smaller sortIndex → sorts first within its tier.
  if (item.sortIndex == null) updates.sortIndex = 100 - score.urgency;
  // Never overwrite a human/caller assignment — triage only fills blanks.
  if (item.projectId == null && score.projectId) {
    updates.projectId = score.projectId;
  }
  if (item.dueAt == null && score.dueAt) updates.dueAt = score.dueAt;

  // Re-check state right before writing — the item may have started running
  // or been edited while the LLM call was in flight. Priority re-scoring only
  // applies while the item is still queued (a run or user edit owns it after
  // that), but the blank-fill fields (sortIndex/dueAt/projectId) are stamped
  // regardless: they only ever fill holes, and skipping them entirely used to
  // leave fast-raced items with no dueAt/sortIndex at all even when the notes
  // said "by Friday 5pm".
  const fresh = getWorkItem(workItemId);
  if (!fresh) return;
  if (fresh.status !== "queued") delete updates.priorityTier;
  if (fresh.sortIndex != null) delete updates.sortIndex;
  if (fresh.projectId != null) delete updates.projectId;
  if (fresh.dueAt != null) delete updates.dueAt;
  if (fresh.sourceContext != null) delete updates.sourceContext;

  if (Object.keys(updates).length === 0) return;
  updateWorkItem(workItemId, updates, { actor: "triage" });
  log.info(
    { workItemId, urgency: score.urgency, tier: score.tier, ...opts },
    "work item triaged",
  );
  broadcastWorkItemStatus(workItemId);
}

/** Exported for tests; production callers go through {@link triageAndMaybeAutoRunWorkItem}. */
export async function maybeAutoRunWorkItem(workItemId: string): Promise<void> {
  if (isAutoRunDisabled()) return;

  const item = getWorkItem(workItemId);
  if (!item || item.status !== "queued") return;

  // Safety floor, evaluated BEFORE the policy: items whose tool snapshot
  // includes host control, browser/computer-use automation, purchase/order
  // tools, or messaging/money egress never auto-run — even if the user's
  // autonomy policy marks every category "auto". They stay queued for an
  // explicit human "Run it".
  const hardDenied = hardDeniedAutoRunTools(item);
  if (hardDenied.length > 0) {
    log.info(
      { workItemId, hardDenied },
      "auto-run hard-denied: required tools need a human in the loop (item stays queued)",
    );
    return;
  }

  const policy = await getAutonomyPolicy();
  const classes = classifyWorkItemAutonomy(item);
  const blocked = classes.filter((c) => policy[c] !== "auto");
  if (blocked.length > 0) {
    log.debug(
      { workItemId, classes, blocked },
      "auto-run deferred: policy asks for these categories",
    );
    return;
  }

  const running = countRunningItems();
  if (running >= MAX_AUTO_CONCURRENT_RUNS) {
    log.info(
      { workItemId, running },
      "auto-run deferred: concurrency cap reached (item stays queued)",
    );
    return;
  }

  const result = runWorkItemInBackground(workItemId);
  log.info(
    { workItemId, classes, success: result.success, error: result.error },
    "work item auto-run per autonomy policy",
  );
}
