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
  if (HIGH_URGENCY_RE.test(text)) return { urgency: 85, tier: 0 };
  if (LOW_URGENCY_RE.test(text)) return { urgency: 25, tier: 2 };
  return { urgency: 50, tier: 1 };
}

// ---------------------------------------------------------------------------
// Flash-LLM scoring (best-effort)
// ---------------------------------------------------------------------------

function buildTriagePrompt(item: WorkItem): string {
  const source = item.sourceType ? ` (captured from ${item.sourceType})` : "";
  return [
    `Task${source}: ${item.title}`,
    item.notes ? `Details: ${item.notes.slice(0, 500)}` : "",
    "",
    'Score how urgent this task is for a busy professional. Reply with ONLY a JSON object, no prose: {"urgency": <0-100>, "tier": <0|1|2>}.',
    "tier 0 = must happen soon (hard deadline, time-sensitive, blocking someone). tier 1 = normal. tier 2 = whenever.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseTriageResponse(text: string): TriageScore | null {
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      urgency?: unknown;
      tier?: unknown;
    };
    const urgency = Number(parsed.urgency);
    const tier = Number(parsed.tier);
    if (!Number.isFinite(urgency) || !Number.isFinite(tier)) return null;
    const clampedTier = Math.min(2, Math.max(0, Math.round(tier))) as 0 | 1 | 2;
    return {
      urgency: Math.min(100, Math.max(0, Math.round(urgency))),
      tier: clampedTier,
    };
  } catch {
    return null;
  }
}

async function scoreWithFlashLlm(item: WorkItem): Promise<TriageScore | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildTriagePrompt(item),
      provider,
      systemPrompt:
        "You are a triage scorer. Reply with ONLY the requested JSON object.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: TRIAGE_TIMEOUT_MS,
    });
    return parseTriageResponse(result.text);
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

async function triageWorkItem(
  workItemId: string,
  opts: TriageOptions,
): Promise<void> {
  const item = getWorkItem(workItemId);
  if (!item || item.status !== "queued") return;

  const score = (await scoreWithFlashLlm(item)) ?? heuristicScore(item);

  const updates: { priorityTier?: number; sortIndex?: number } = {};
  if (!opts.callerSetPriority) updates.priorityTier = score.tier;
  // Higher urgency → smaller sortIndex → sorts first within its tier.
  if (item.sortIndex == null) updates.sortIndex = 100 - score.urgency;

  if (Object.keys(updates).length === 0) return;

  // Re-check state right before writing — the user may have already run or
  // edited the item while the LLM call was in flight.
  const fresh = getWorkItem(workItemId);
  if (!fresh || fresh.status !== "queued") return;
  updateWorkItem(workItemId, updates);
  log.info(
    { workItemId, urgency: score.urgency, tier: score.tier, ...opts },
    "work item triaged",
  );
  broadcastWorkItemStatus(workItemId);
}

async function maybeAutoRunWorkItem(workItemId: string): Promise<void> {
  if (isAutoRunDisabled()) return;

  const item = getWorkItem(workItemId);
  if (!item || item.status !== "queued") return;

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
