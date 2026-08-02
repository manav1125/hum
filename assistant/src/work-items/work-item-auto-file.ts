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
 * Below-threshold items are NOT filed, but they are no longer invisible:
 * the sweep stamps the scorer's best-guess `auto_file_confidence` while
 * `project_id` and `auto_filed_by` stay null — the exact shape clients
 * feature-detect for the amber "?" below-confidence card (frame 44/D2's
 * "scored, not guessed"). A stamped-but-unfiled item is skipped by later
 * sweeps (no re-score churn) until its title changes, which clears the stamp
 * (see `updateWorkItem` in work-item-store.ts).
 *
 * The same batched scorer is exposed at capture time via
 * {@link classifyTitlesForPreview} (the `work-items/classify-preview` route):
 * score a handful of typed titles against active projects with no
 * persistence and no side effects, so batch-add surfaces can pre-fill
 * per-row suggestions.
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

/**
 * The slice of a work item the scorer actually reads. Persisted `WorkItem`s
 * satisfy this structurally; the classify-preview route builds ephemeral ones
 * from raw titles (no DB row involved).
 */
export interface ScorableItem {
  id: string;
  title: string;
  notes?: string | null;
  context?: string | null;
  sourceType?: string | null;
}

/** Exported for tests; production callers go through {@link sweepUnfiledWorkItems}. */
export function buildAutoFilePrompt(
  items: ScorableItem[],
  projects: Project[],
): string {
  const projectLines = projects.map((p) => {
    const brief = p.context ? ` — ${clip(p.context, BRIEF_SNIPPET_CHARS)}` : "";
    return `  - ${p.id}: ${p.title}${brief}`;
  });
  const itemLines = items.map((i) => {
    const detail = i.notes ?? i.context ?? "";
    // (WorkItem's nullable fields and ScorableItem's optional ones both land
    // here as ""-when-absent.)
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
  items: ScorableItem[],
  projects: Project[],
) => Promise<AutoFileAssignment[] | null>;

async function scoreWithFlashLlm(
  items: ScorableItem[],
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

/**
 * Race a scorer call against {@link SCORER_DEADLINE_MS} — the one deadline the
 * sweep and the classify-preview route share. On deadline the caller sees the
 * same `null` a scorer failure produces (degrade to "suggest/file nothing");
 * the abandoned promise is left to settle on its own — it holds no locks and
 * writes nothing; only its return value is used.
 */
async function raceScorerDeadline(
  scoring: Promise<AutoFileAssignment[] | null>,
): Promise<AutoFileAssignment[] | null> {
  return Promise.race([
    scoring,
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), SCORER_DEADLINE_MS);
      if (typeof t === "object") t.unref?.();
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Classify preview (capture-time suggestions, no persistence)
// ---------------------------------------------------------------------------

/** At most this many titles are scored per classify-preview call. */
export const MAX_CLASSIFY_PREVIEW_TITLES = 30;

export interface ClassifyPreviewSuggestion {
  title: string;
  projectId: string | null;
  /** The scorer's 0–1 confidence; 0 when the scorer skipped the title. */
  confidence: number;
}

/**
 * Score raw task titles against the user's active projects with the EXACT
 * batch scorer the auto-file sweep uses (same flash call site, same prompt
 * shape) — but with no persistence and no side effects: nothing is created,
 * filed, or stamped. Backs `POST work-items/classify-preview` so batch-add
 * surfaces can pre-fill per-row project suggestions while the user types.
 *
 * Battle-hardened by design: blank/duplicate titles are dropped, the batch is
 * capped at {@link MAX_CLASSIFY_PREVIEW_TITLES}, the scorer runs under the
 * sweep's shared {@link SCORER_DEADLINE_MS}, and every failure mode (no
 * titles, no projects, scorer miss/deadline/throw) degrades to an empty
 * array — never an error. `scorer` is injectable for deterministic tests.
 */
export async function classifyTitlesForPreview(
  titles: string[],
  scorer: AutoFileScorer = scoreWithFlashLlm,
): Promise<ClassifyPreviewSuggestion[]> {
  try {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of titles) {
      const title = raw.trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      cleaned.push(title);
      if (cleaned.length >= MAX_CLASSIFY_PREVIEW_TITLES) break;
    }
    if (cleaned.length === 0) return [];

    const projects = listProjects();
    if (projects.length === 0) return [];

    // Ephemeral ids — these items exist only for this one scorer call.
    const items: ScorableItem[] = cleaned.map((title, i) => ({
      id: `preview-${i}`,
      title,
    }));
    const assignments = await raceScorerDeadline(scorer(items, projects));
    if (!assignments) return [];

    const byId = new Map(assignments.map((a) => [a.id, a]));
    return items.map((item) => {
      const assignment = byId.get(item.id);
      return {
        title: item.title,
        projectId: assignment?.projectId ?? null,
        confidence: assignment?.confidence ?? 0,
      };
    });
  } catch (err) {
    log.warn({ err: String(err) }, "classify-preview scoring failed (empty)");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Why a sweep ended the way it did. A sweep has exactly one outcome, and every
 * early return names its own — "did nothing" and "had nothing to do" are
 * different answers and must never share a silence.
 */
export type AutoFileSweepOutcome =
  /** Config kill switch is off. */
  | "disabled"
  /** Nothing unfiled and unscored in the queued lane — the honest idle state. */
  | "no_candidates"
  /** Candidates exist but there is no active project to file them into. */
  | "no_projects"
  /** The scorer returned nothing (failure, unparseable reply, or deadline). */
  | "scorer_miss"
  /** Scored, but nothing was filed and nothing was stamped. */
  | "no_match"
  /** At least one item was filed or stamped. */
  | "progress"
  /** The sweep threw; everything degraded to "item stays unfiled". */
  | "error";

export interface AutoFileSweepResult {
  /** Why the sweep ended — set on every path, including the early returns. */
  outcome: AutoFileSweepOutcome;
  /**
   * Unfiled, unscored queued items waiting right now, BEFORE the per-sweep
   * cap. This is the number the user is staring at; `scanned` is only what
   * one sweep could reach. A large `candidates` with a zero `filed` is the
   * signature of a filer that is running and achieving nothing.
   */
  candidates: number;
  /** Unfiled queued items sent to the scorer this sweep (post-cap). */
  scanned: number;
  /** Items filed into a project (provenance stamped, event broadcast). */
  filed: number;
  /** Scored but left unfiled: no project or confidence below the threshold. */
  belowThreshold: number;
  /**
   * Below-threshold items whose best-guess confidence was stamped (the amber
   * "?" marker: `autoFileConfidence` set, `projectId`/`autoFiledBy` null).
   */
  stamped: number;
  /** Candidates skipped: raced to filed/user-unfiled mid-sweep, or scorer miss. */
  skipped: number;
}

function emptyResult(
  outcome: AutoFileSweepOutcome = "no_candidates",
): AutoFileSweepResult {
  return {
    outcome,
    candidates: 0,
    scanned: 0,
    filed: 0,
    belowThreshold: 0,
    stamped: 0,
    skipped: 0,
  };
}

/** An item the sweep may consider: unfiled and not deliberately unfiled. */
function isAutoFileCandidate(item: WorkItem): boolean {
  return item.projectId == null && item.autoFiledBy !== AUTO_FILE_USER_UNFILED;
}

/**
 * An item worth sending to the scorer: a candidate that has NOT already been
 * scored. A below-threshold stamp (`autoFileConfidence` set while unfiled)
 * means a previous sweep already judged this item — re-scoring it every 5
 * minutes would burn LLM calls to reach the same answer, so it stays skipped
 * until its title changes (the store clears the stamp on a title edit, which
 * re-opens candidacy).
 */
function isSweepCandidate(item: WorkItem): boolean {
  return isAutoFileCandidate(item) && item.autoFileConfidence == null;
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
    if (!cfg.enabled) {
      result.outcome = "disabled";
      return result;
    }

    // Cheap pre-checks: no unfiled items or no projects → no LLM call at all.
    // `candidates` counts the whole waiting pool, not just this sweep's slice:
    // "20 scanned" reads like progress when 200 are queued behind it.
    const candidates = listWorkItems({ status: "queued" })
      .filter(isSweepCandidate)
      .sort((a, b) => a.createdAt - b.createdAt);
    result.candidates = candidates.length;
    const unfiled = candidates.slice(0, MAX_ITEMS_PER_SWEEP);
    if (unfiled.length === 0) {
      result.outcome = "no_candidates";
      return result;
    }

    const projects = listProjects();
    if (projects.length === 0) {
      // Candidates with nowhere to go. Not an error, but not "nothing to do"
      // either — the filer cannot make progress until a project exists, and
      // the health record has to be able to say so.
      result.outcome = "no_projects";
      return result;
    }

    result.scanned = unfiled.length;
    // Deadline-raced: a stalled provider resolution must not wedge the sweep.
    const assignments = await raceScorerDeadline(scorer(unfiled, projects));
    if (!assignments) {
      result.skipped = unfiled.length;
      result.outcome = "scorer_miss";
      return result;
    }

    const byId = new Map(assignments.map((a) => [a.id, a]));
    for (const item of unfiled) {
      const assignment = byId.get(item.id);
      if (!assignment) {
        // The scorer never judged this item — leave it untouched (no stamp)
        // so the next sweep offers it again.
        result.skipped++;
        continue;
      }
      if (
        assignment.projectId == null ||
        assignment.confidence < cfg.confidenceThreshold
      ) {
        // Below-threshold / no-fit items stay UNFILED by design — the came-in
        // triage owns the ambiguous ones. But the judgment itself is recorded:
        // stamp the best-guess confidence while projectId and autoFiledBy stay
        // null. That exact shape is what clients feature-detect for the amber
        // "?" card ("scored, not guessed"), and it doubles as the no-re-score
        // guard (isSweepCandidate skips stamped items).
        result.belowThreshold++;
        try {
          const fresh = getWorkItem(item.id);
          // Mid-flight user decisions win here too; an already-stamped item
          // is not re-stamped.
          if (
            fresh &&
            isAutoFileCandidate(fresh) &&
            fresh.autoFileConfidence == null
          ) {
            updateWorkItem(
              item.id,
              { autoFileConfidence: assignment.confidence },
              { actor: "auto-file" },
            );
            result.stamped++;
          }
        } catch (err) {
          log.warn(
            { err: String(err), workItemId: item.id },
            "auto-file: stamping below-confidence failed (skipped)",
          );
        }
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

    if (result.filed > 0 || result.stamped > 0) {
      // Project boards and task lists refetch on tasks_changed; the per-item
      // work_item_status_changed broadcasts above carry the item ids. Stamped
      // items ride the same refetch so the amber "?" card lights up live.
      broadcastMessage({ type: "tasks_changed" });
      result.outcome = "progress";
    } else {
      // Scored the batch and moved nothing. One of these is normal; a run of
      // them is a filer that is alive and useless, which is what the caller
      // watches for.
      result.outcome = "no_match";
    }
    if (result.scanned > 0) {
      log.info({ ...result }, "auto-file sweep finished");
    }
    return result;
  } catch (err) {
    log.warn({ err: String(err) }, "auto-file sweep failed (ignored)");
    result.outcome = "error";
    return result;
  }
}

// ---------------------------------------------------------------------------
// Observable health
// ---------------------------------------------------------------------------

/**
 * After this many consecutive sweeps that reached the scorer and moved
 * nothing, the filer is declared degraded and says so at WARN. One such sweep
 * is ordinary (the batch was genuinely ambiguous); a run of them means the
 * filer is burning LLM calls to achieve nothing, and the user is watching an
 * unfiled pile that never shrinks.
 */
export const UNPRODUCTIVE_SWEEP_LIMIT = 3;

/**
 * A tick that finds the previous sweep still running logs at debug — cheap and
 * usually right. After this many consecutive skips the overlap is no longer
 * incidental and gets said out loud.
 */
const SKIPPED_TICK_WARN_LIMIT = 3;

/**
 * How long an in-flight sweep may hold the single-flight latch before the
 * watchdog breaks it.
 *
 * The bug this exists for: `sweepInFlight` was a plain boolean cleared only by
 * the sweep promise's own `.finally()`. One sweep that never settles latches
 * it forever — every later tick returns at the guard, the guard logs at debug,
 * and the filer is dead with no line above debug anywhere in the log. It
 * survives restarts too, because the next process's first tick hangs the same
 * way. Nothing may be trusted to settle on its own.
 */
const SWEEP_STUCK_MS = 4 * SCORER_DEADLINE_MS;

/**
 * One INFO line every this many ticks whatever the outcome. An idle filer and
 * a dead filer produce identical silence otherwise, and telling them apart is
 * the whole point: absence of this line means the timer stopped firing.
 */
const HEARTBEAT_EVERY_TICKS = 12;

/**
 * What the auto-filer has actually been doing — the record a "the filer is
 * broken" surface can read instead of inferring health from an unfiled pile.
 * In-memory by design: it describes this process's behaviour since start, and
 * a restart genuinely does reset what we know.
 */
export interface AutoFileHealth {
  /** Whether the interval is running in this process. */
  running: boolean;
  /** Ticks the interval has fired, including skipped and watchdog ones. */
  ticks: number;
  /** Sweeps that actually ran (ticks minus skips). */
  sweeps: number;
  /** Epoch ms of the last tick — stale means the timer stopped firing. */
  lastTickAt: number | null;
  /** Epoch ms the last sweep finished. */
  lastSweepAt: number | null;
  /** The last finished sweep's full result, outcome included. */
  lastResult: AutoFileSweepResult | null;
  /** Unfiled, unscored items waiting as of the last sweep. */
  candidatesWaiting: number;
  /** Consecutive sweeps that scanned candidates and moved none of them. */
  unproductiveStreak: number;
  /** Consecutive ticks skipped because a sweep was still in flight. */
  skippedTicks: number;
  /** When the in-flight sweep started, or null when idle. */
  inFlightSince: number | null;
  /** Times the watchdog had to break a wedged sweep's latch. */
  stuckReleases: number;
  /** Epoch ms of the most recent watchdog release. */
  lastStuckAt: number | null;
  /** True when the filer is running but not doing its job. */
  degraded: boolean;
  /** Plain-language reason, in the user's terms, or null when healthy. */
  degradedReason: string | null;
}

function freshHealth(): AutoFileHealth {
  return {
    running: false,
    ticks: 0,
    sweeps: 0,
    lastTickAt: null,
    lastSweepAt: null,
    lastResult: null,
    candidatesWaiting: 0,
    unproductiveStreak: 0,
    skippedTicks: 0,
    inFlightSince: null,
    stuckReleases: 0,
    lastStuckAt: null,
    degraded: false,
    degradedReason: null,
  };
}

let health: AutoFileHealth = freshHealth();

/**
 * A snapshot of what the filer has been doing. Safe to call at any time; the
 * returned object is a copy, so a caller cannot mutate the live record.
 */
export function getAutoFileHealth(): AutoFileHealth {
  return {
    ...health,
    lastResult: health.lastResult && { ...health.lastResult },
  };
}

/**
 * Reset the in-memory record AND release the single-flight latch. Test-only:
 * a test that deliberately wedges a sweep would otherwise leak the latch into
 * the next test, which is the very failure mode under test.
 */
export function resetAutoFilerForTests(): void {
  health = freshHealth();
  sweepInFlight = false;
  sweepGeneration++;
}

/**
 * Decide whether the filer is currently failing the user, and say it in the
 * terms the user would use. "Degraded" is deliberately not the same as
 * "errored": a filer that scores batch after batch and files nothing has
 * thrown nothing at all, and is the exact failure the pile of unfiled items
 * represents.
 */
function evaluateDegraded(): void {
  const r = health.lastResult;
  if (health.unproductiveStreak >= UNPRODUCTIVE_SWEEP_LIMIT) {
    health.degraded = true;
    health.degradedReason = `Cue has looked at these ${health.candidatesWaiting} unfiled items ${health.unproductiveStreak} times running and filed none of them.`;
    return;
  }
  if (r?.outcome === "no_projects") {
    health.degraded = true;
    health.degradedReason = `${r.candidates} items are waiting to be filed, but there are no active projects to file them into.`;
    return;
  }
  if (health.skippedTicks >= SKIPPED_TICK_WARN_LIMIT) {
    health.degraded = true;
    health.degradedReason =
      "Auto-filing sweeps are taking longer than the interval between them, so most sweeps are being skipped.";
    return;
  }
  health.degraded = false;
  health.degradedReason = null;
}

/** Fold a finished sweep into the health record and say anything worth saying. */
function recordSweep(result: AutoFileSweepResult): void {
  health.sweeps++;
  health.lastSweepAt = Date.now();
  health.lastResult = result;
  health.candidatesWaiting = result.candidates;

  const moved = result.filed > 0 || result.stamped > 0;
  const reachedScorer = result.scanned > 0;
  if (moved) health.unproductiveStreak = 0;
  else if (reachedScorer) health.unproductiveStreak++;

  evaluateDegraded();

  // The line that was missing. A sweep that scans and files nothing, over and
  // over, is not a quiet success — it is the only symptom of this failure that
  // exists before a human notices the pile.
  if (health.unproductiveStreak === UNPRODUCTIVE_SWEEP_LIMIT) {
    log.warn(
      {
        unproductiveStreak: health.unproductiveStreak,
        candidates: result.candidates,
        scanned: result.scanned,
        outcome: result.outcome,
      },
      "auto-file has scanned candidates and filed nothing for several sweeps running",
    );
  }
  if (health.ticks % HEARTBEAT_EVERY_TICKS === 0) {
    log.info(
      {
        ticks: health.ticks,
        sweeps: health.sweeps,
        outcome: result.outcome,
        candidates: result.candidates,
        degraded: health.degraded,
      },
      "auto-file heartbeat",
    );
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
 *
 * Held with a start time and released by generation, never by a bare boolean —
 * see {@link SWEEP_STUCK_MS}.
 */
let sweepInFlight = false;

/**
 * Increments on every sweep start. A sweep only clears the latch if it is
 * still the current generation, so a wedged sweep that settles hours later
 * cannot release a latch that a newer sweep now holds.
 */
let sweepGeneration = 0;

/**
 * One tick of the auto-filer: the single-flight guard, the stuck-sweep
 * watchdog, and the health bookkeeping around one sweep.
 *
 * `scorer` and `now` are injectable for deterministic tests; production drives
 * this from the interval with both defaulted. It never rejects, and it always
 * leaves the latch in a state a later tick can recover from.
 */
export async function runAutoFileTick(
  scorer: AutoFileScorer = scoreWithFlashLlm,
  now: number = Date.now(),
): Promise<void> {
  health.ticks++;
  health.lastTickAt = now;

  if (sweepInFlight) {
    const heldMs = now - (health.inFlightSince ?? now);
    if (heldMs < SWEEP_STUCK_MS) {
      health.skippedTicks++;
      evaluateDegraded();
      if (health.skippedTicks === SKIPPED_TICK_WARN_LIMIT) {
        log.warn(
          { heldMs, skippedTicks: health.skippedTicks },
          "auto-file sweeps keep overlapping; ticks are being skipped",
        );
      } else {
        log.debug("auto-file sweep still in flight; skipping this tick");
      }
      return;
    }
    // The watchdog. Whatever that sweep is waiting on, it has had four times
    // its own hard deadline and is not coming back. Filing must not stay off
    // until someone restarts the daemon.
    health.stuckReleases++;
    health.lastStuckAt = now;
    log.warn(
      { heldMs, stuckReleases: health.stuckReleases },
      "auto-file: the previous sweep never finished — breaking the latch and sweeping anyway",
    );
    sweepInFlight = false;
  }

  sweepInFlight = true;
  sweepGeneration++;
  const generation = sweepGeneration;
  health.inFlightSince = now;
  health.skippedTicks = 0;
  try {
    recordSweep(await sweepUnfiledWorkItems(scorer));
  } catch (err) {
    // sweepUnfiledWorkItems never rejects; belt-and-suspenders catch anyway.
    log.warn({ err: String(err) }, "auto-file sweep failed (ignored)");
    recordSweep(emptyResult("error"));
  } finally {
    // A sweep the watchdog already gave up on must not clear a latch that a
    // newer sweep is holding.
    if (sweepGeneration === generation) {
      sweepInFlight = false;
      health.inFlightSince = null;
    }
  }
}

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
  health.running = true;

  const timer = setInterval(() => {
    void runAutoFileTick();
  }, intervalMs);
  timer.unref?.();

  activeController = {
    stop() {
      clearInterval(timer);
      activeController = null;
      health.running = false;
    },
  };
  return activeController;
}
