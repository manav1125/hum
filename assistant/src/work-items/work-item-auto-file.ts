/**
 * Background auto-filer for unfiled work items.
 *
 * "The system auto-files as it sees fit": tasks captured from ANY source
 * (manual quick-add, MCP, chat, voice, channels) that landed without a
 * project sit in an ungrouped pool until a human drags them somewhere. This
 * job periodically sweeps the unfiled `queued` lane and scores the batch
 * against the user's ACTIVE projects (names + `projects.context` briefs) with
 * a single flash-tier LLM call. Confident matches get `projectId` plus a
 * provenance stamp (`auto_filed_by='cue'` + the 0–1 confidence) so clients
 * can render an honest "auto-filed" chip; everything else is left alone for
 * the normal came-in triage (that's the design, not a failure).
 *
 * Hard rules:
 *   - FILING IS NOT PERMISSION TO RUN. `auto_run_eligibility` is never
 *     touched — a parked item stays parked after filing.
 *   - Only `projectId IS NULL` items are candidates, so a user's filing
 *     decision always sticks. A deliberate unfile (PATCH projectId=null)
 *     stamps `auto_filed_by='user_unfiled'`, which this job also respects —
 *     an unfiled-on-purpose item is never re-filed.
 *   - One batched LLM call per sweep, capped at {@link MAX_ITEMS_PER_SWEEP}
 *     items; the sweep is skipped outright when there are no unfiled items or
 *     no active projects. One summary log line per productive sweep.
 *   - Never throws: per-item and sweep-level failures log and degrade to
 *     "item stays unfiled" (daemon startup philosophy).
 *
 * Config (workItems.autoFile.*): `enabled` (default true, re-read every
 * sweep), `intervalMinutes` (default 5, read at start), and
 * `confidenceThreshold` (default 0.7).
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import { listProjects, type Project } from "./project-store.js";
import { broadcastWorkItemStatus } from "./work-item-runner.js";
import {
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

const log = getLogger("work-item-auto-file");

/** Provenance value stamped on items this job files. */
export const AUTO_FILED_BY_CUE = "cue";

/**
 * Guard value the PATCH route stamps when the user deliberately unfiles an
 * item (sets projectId to null). The auto-filer never re-files these.
 */
export const AUTO_FILE_USER_UNFILED = "user_unfiled";

/** At most this many unfiled items are scored per sweep (one LLM call). */
export const MAX_ITEMS_PER_SWEEP = 20;

/** The batched flash call must not dawdle — a missed sweep just waits 5 min. */
const AUTO_FILE_TIMEOUT_MS = 20_000;

/**
 * Hard deadline on the whole scorer (provider resolution + the LLM call).
 * `runBtwSidechain` bounds only the send; provider resolution itself can
 * stall for minutes on a key-less daemon while platform auth times out. A
 * sweep must always terminate — on deadline it degrades to "file nothing"
 * exactly like a scorer failure.
 */
const SCORER_DEADLINE_MS = 90_000;

/** Cap on how much of a project brief is quoted into the prompt. */
const BRIEF_SNIPPET_CHARS = 300;

/** Cap on how much of an item's notes/context is quoted into the prompt. */
const ITEM_SNIPPET_CHARS = 240;

// ---------------------------------------------------------------------------
// Prompt + response parsing (exported for tests)
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Exported for tests; production callers go through {@link sweepUnfiledWorkItems}. */
export function buildAutoFilePrompt(
  items: WorkItem[],
  projects: Project[],
): string {
  const projectLines = projects.map((p) => {
    const brief = p.context ? ` — ${clip(p.context, BRIEF_SNIPPET_CHARS)}` : "";
    return `  - ${p.id}: ${p.title}${brief}`;
  });
  const itemLines = items.map((i) => {
    const detail = i.notes ?? i.context ?? "";
    const suffix = detail ? ` — ${clip(detail, ITEM_SNIPPET_CHARS)}` : "";
    const source = i.sourceType ? ` (from ${i.sourceType})` : "";
    return `  - ${i.id}: ${i.title}${source}${suffix}`;
  });
  return [
    "You are filing a user's captured tasks into their projects.",
    "",
    `Projects:\n${projectLines.join("\n")}`,
    "",
    `Unfiled tasks:\n${itemLines.join("\n")}`,
    "",
    "For each task, decide which ONE project it clearly belongs to, if any.",
    "Reply with ONLY a JSON array, no prose, one entry per task:",
    '[{"id": "<task id>", "projectId": "<project id or null>", "confidence": <0-1>}]',
    "confidence is how sure you are the task belongs to that project. Use",
    "projectId null (confidence 0) when no project is a clear fit — leaving a",
    "task unfiled is the correct answer for anything ambiguous. Never invent",
    "an id: only use the task and project ids listed above.",
  ].join("\n");
}

export interface AutoFileAssignment {
  id: string;
  projectId: string | null;
  confidence: number;
}

/**
 * Parse the model's JSON-array reply. Defensive by design: entries with
 * unknown item ids are dropped, hallucinated project ids are treated as
 * "leave unfiled", and confidence is clamped to [0, 1]. Returns null when no
 * parseable array is present (the sweep then files nothing).
 */
export function parseAutoFileResponse(
  text: string,
  validItemIds: ReadonlySet<string>,
  validProjectIds: ReadonlySet<string>,
): AutoFileAssignment[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const assignments: AutoFileAssignment[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, projectId, confidence } = entry as {
      id?: unknown;
      projectId?: unknown;
      confidence?: unknown;
    };
    if (typeof id !== "string" || !validItemIds.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    // A hallucinated project id means the model wasn't grounded — the honest
    // reading is "no clear fit", so the item stays unfiled.
    const resolvedProjectId =
      typeof projectId === "string" && validProjectIds.has(projectId)
        ? projectId
        : null;
    const numeric = Number(confidence);
    const clamped = Number.isFinite(numeric)
      ? Math.min(1, Math.max(0, numeric))
      : 0;
    assignments.push({
      id,
      projectId: resolvedProjectId,
      confidence: clamped,
    });
  }
  return assignments;
}

// ---------------------------------------------------------------------------
// Flash-LLM scoring (best-effort)
// ---------------------------------------------------------------------------

/**
 * Injectable batch scorer — production uses the flash-tier side-chain (the
 * same `conversationTitle` call site capture triage scores with, so the
 * CUE_OPENROUTER_FLASH_MODEL / llm.callSites overrides apply unchanged).
 */
export type AutoFileScorer = (
  items: WorkItem[],
  projects: Project[],
) => Promise<AutoFileAssignment[] | null>;

async function scoreWithFlashLlm(
  items: WorkItem[],
  projects: Project[],
): Promise<AutoFileAssignment[] | null> {
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) return null;
    const config = getConfig();
    const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
    const result = await runBtwSidechain({
      content: buildAutoFilePrompt(items, projects),
      provider,
      systemPrompt:
        "You are a task-filing classifier. Reply with ONLY the requested JSON array.",
      messages: [],
      tools: [],
      callSite: "conversationTitle",
      maxTokens: resolved.maxTokens,
      timeoutMs: AUTO_FILE_TIMEOUT_MS,
    });
    return parseAutoFileResponse(
      result.text,
      new Set(items.map((i) => i.id)),
      new Set(projects.map((p) => p.id)),
    );
  } catch (err) {
    log.debug({ err: String(err) }, "auto-file flash scoring failed (skipped)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface AutoFileSweepResult {
  /** Unfiled queued items sent to the scorer this sweep (post-cap). */
  scanned: number;
  /** Items filed into a project (provenance stamped, event broadcast). */
  filed: number;
  /** Scored but left unfiled: no project or confidence below the threshold. */
  belowThreshold: number;
  /** Candidates skipped: raced to filed/user-unfiled mid-sweep, or scorer miss. */
  skipped: number;
}

function emptyResult(): AutoFileSweepResult {
  return { scanned: 0, filed: 0, belowThreshold: 0, skipped: 0 };
}

/** An item the sweep may consider: unfiled and not deliberately unfiled. */
function isAutoFileCandidate(item: WorkItem): boolean {
  return item.projectId == null && item.autoFiledBy !== AUTO_FILE_USER_UNFILED;
}

/**
 * One sweep over the unfiled queued lane. Exported for tests and never
 * rejects — all failures degrade to "item stays unfiled".
 *
 * `scorer` is injectable for deterministic tests; production callers use the
 * default flash-LLM batch scorer.
 */
export async function sweepUnfiledWorkItems(
  scorer: AutoFileScorer = scoreWithFlashLlm,
): Promise<AutoFileSweepResult> {
  const result = emptyResult();
  try {
    const cfg = getConfig().workItems.autoFile;
    if (!cfg.enabled) return result;

    // Cheap pre-checks: no unfiled items or no projects → no LLM call at all.
    const unfiled = listWorkItems({ status: "queued" })
      .filter(isAutoFileCandidate)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, MAX_ITEMS_PER_SWEEP);
    if (unfiled.length === 0) return result;

    const projects = listProjects();
    if (projects.length === 0) return result;

    result.scanned = unfiled.length;
    // Deadline-raced: a stalled provider resolution must not wedge the sweep
    // (the abandoned promise is left to settle on its own — it holds no locks
    // and writes nothing; only its return value is used, and only here).
    const assignments = await Promise.race([
      scorer(unfiled, projects),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), SCORER_DEADLINE_MS);
        if (typeof t === "object") t.unref?.();
      }),
    ]);
    if (!assignments) {
      result.skipped = unfiled.length;
      return result;
    }

    const byId = new Map(assignments.map((a) => [a.id, a]));
    for (const item of unfiled) {
      const assignment = byId.get(item.id);
      if (
        !assignment ||
        assignment.projectId == null ||
        assignment.confidence < cfg.confidenceThreshold
      ) {
        // Below-threshold / no-fit items stay unfiled by design — the
        // came-in triage (LowConfidenceFilePrompt) owns the ambiguous ones.
        result.belowThreshold++;
        continue;
      }
      try {
        // Re-check right before writing: the user (or capture triage) may
        // have filed or unfiled the item while the LLM call was in flight —
        // a human decision always wins over this sweep's stale snapshot.
        const fresh = getWorkItem(item.id);
        if (!fresh || !isAutoFileCandidate(fresh)) {
          result.skipped++;
          continue;
        }
        // NOTE: auto_run_eligibility is deliberately untouched — filing is
        // not permission to run; a parked item stays parked.
        updateWorkItem(
          item.id,
          {
            projectId: assignment.projectId,
            autoFiledBy: AUTO_FILED_BY_CUE,
            autoFileConfidence: assignment.confidence,
          },
          { actor: "auto-file" },
        );
        broadcastWorkItemStatus(item.id);
        result.filed++;
      } catch (err) {
        result.skipped++;
        log.warn(
          { err: String(err), workItemId: item.id },
          "auto-file: filing an item failed (skipped)",
        );
      }
    }

    if (result.filed > 0) {
      // Project boards and task lists refetch on tasks_changed; the per-item
      // work_item_status_changed broadcasts above carry the item ids.
      broadcastMessage({ type: "tasks_changed" });
    }
    if (result.scanned > 0) {
      log.info({ ...result }, "auto-file sweep finished");
    }
    return result;
  } catch (err) {
    log.warn({ err: String(err) }, "auto-file sweep failed (ignored)");
    return result;
  }
}

// ---------------------------------------------------------------------------
// Interval starter
// ---------------------------------------------------------------------------

interface AutoFilerController {
  stop(): void;
}

let activeController: AutoFilerController | null = null;

/**
 * Single-flight guard: provider resolution + the flash call can take longer
 * than expected (key-less daemons spend ~a minute failing platform auth), and
 * an interval tick that fires while the previous sweep is still in flight
 * must not start a second concurrent LLM call over the same candidates.
 */
let sweepInFlight = false;

/**
 * Start the periodic auto-filer. Idempotent — a second call returns the
 * running controller. `workItems.autoFile.enabled` and the confidence
 * threshold are re-read at every sweep (so a config change applies without a
 * restart); the interval is read once at start.
 *
 * The timer is unref'd: it must never hold the daemon process open.
 */
export function startWorkItemAutoFiler(): AutoFilerController {
  if (activeController) return activeController;

  const cfg = getConfig().workItems.autoFile;
  const intervalMs = Math.max(1, cfg.intervalMinutes) * 60_000;
  log.info(
    { intervalMs, enabled: cfg.enabled },
    "work-item auto-filer started",
  );

  const timer = setInterval(() => {
    if (sweepInFlight) {
      log.debug("auto-file sweep still in flight; skipping this tick");
      return;
    }
    sweepInFlight = true;
    // sweepUnfiledWorkItems never rejects; belt-and-suspenders catch anyway.
    void sweepUnfiledWorkItems()
      .catch((err) => {
        log.warn({ err: String(err) }, "auto-file sweep failed (ignored)");
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, intervalMs);
  timer.unref?.();

  activeController = {
    stop() {
      clearInterval(timer);
      activeController = null;
    },
  };
  return activeController;
}
