// ---------------------------------------------------------------------------
// Memory jobs — the run of empty outcomes, counted and named.
//
// `job-outcome.ts` gives a single run a truthful answer. This is where a
// *sequence* of those answers becomes a signal, because one empty run is
// ordinary and forty in a row is a bug wearing a green status.
//
// Design's words for the surface this feeds: "Contact extraction ran 718× and
// found nothing — that's a bug, not a quiet week." The distinction only exists
// if something is counting the streak, so that is exactly what this counts.
//
// In-memory and per-process, matching the contact-memory and auto-filer health
// records: it describes behaviour since this daemon started, and a restart
// genuinely does reset what we know. The durable answer lives in
// `memory_jobs.outcome` — see `summarizeJobOutcomes` in `jobs-store.ts` — so
// losing this on restart costs a warning, not the evidence.
// ---------------------------------------------------------------------------

import { getLogger } from "../util/logger.js";
import type { JobOutcome } from "./job-outcome.js";
import type { MemoryJobType } from "./jobs-store.js";

const log = getLogger("memory-job-outcome-health");

/**
 * The run length at which an unbroken sequence of empty outcomes stops being
 * a quiet week and starts being worth saying out loud.
 *
 * Chosen low deliberately. The costs are asymmetric: a premature warning is a
 * line in a log, while a late one was 697 completed extractions and years of
 * correspondence Cue learned nothing from. Ten consecutive runs of any of
 * these jobs is hours at most.
 */
export const EMPTY_RUN_WARN_AT = 10;

/**
 * After the first warning, warn again only when the run has doubled (10, 20,
 * 40, …). A run that is genuinely stuck keeps re-announcing itself with a
 * bigger number instead of one line per tick.
 */
function shouldWarnAtRunLength(run: number): boolean {
  if (run < EMPTY_RUN_WARN_AT) return false;
  let milestone = EMPTY_RUN_WARN_AT;
  while (milestone < run) milestone *= 2;
  return milestone === run;
}

export interface JobTypeOutcomeStats {
  type: MemoryJobType;
  /** Runs that reached a terminal outcome of any kind. */
  runs: number;
  producedRuns: number;
  /** Ran end to end, wrote nothing. Ordinary in ones; a signal in a row. */
  emptyRuns: number;
  /** Gated off before doing work. Never counts toward the empty run. */
  skippedRuns: number;
  /** Handlers that cannot yet say what they did. */
  unreportedRuns: number;
  /** Records written by this job type since the daemon started. */
  totalProduced: number;
  /** Empty outcomes since the last one that produced anything. */
  consecutiveEmpty: number;
  /** High-water mark of {@link consecutiveEmpty} this process has seen. */
  longestEmptyRun: number;
  lastProducedAt: number | null;
  lastEmptyAt: number | null;
  /** The most recent empty run's own words, for the health surface. */
  lastEmptyReason: string | null;
}

export interface MemoryJobOutcomeHealth {
  /** When this process started counting. */
  since: number;
  /** One entry per job type that has run, worst empty run first. */
  types: JobTypeOutcomeStats[];
  /** True when at least one job type is in a run of empty outcomes. */
  degraded: boolean;
  /** Plain-language reason, in the owner's terms, or null when healthy. */
  degradedReason: string | null;
}

let since = Date.now();
let stats = new Map<MemoryJobType, JobTypeOutcomeStats>();

function freshStats(type: MemoryJobType): JobTypeOutcomeStats {
  return {
    type,
    runs: 0,
    producedRuns: 0,
    emptyRuns: 0,
    skippedRuns: 0,
    unreportedRuns: 0,
    totalProduced: 0,
    consecutiveEmpty: 0,
    longestEmptyRun: 0,
    lastProducedAt: null,
    lastEmptyAt: null,
    lastEmptyReason: null,
  };
}

/**
 * Fold one job's outcome into the record, and warn when the run of empties
 * crosses a milestone.
 *
 * Best-effort by construction: this is observation, and a bookkeeping failure
 * must never turn a job that succeeded into one that failed. The worker calls
 * it inside its own try/catch for the same reason.
 */
export function recordJobOutcome(
  type: MemoryJobType,
  outcome: JobOutcome,
  nowMs = Date.now(),
): void {
  let entry = stats.get(type);
  if (!entry) {
    entry = freshStats(type);
    stats.set(type, entry);
  }
  entry.runs++;

  switch (outcome.kind) {
    case "produced":
      entry.producedRuns++;
      entry.totalProduced += outcome.produced;
      entry.consecutiveEmpty = 0;
      entry.lastProducedAt = nowMs;
      return;

    case "skipped":
      // A gate the owner or the config closed. It must not extend the run —
      // otherwise turning a subsystem off would eventually report itself as
      // breakage — and it must not reset it either, because a skip is not
      // evidence that the job can still write.
      entry.skippedRuns++;
      return;

    case "unreported":
      // We do not know what happened. Neither extend nor reset; the count
      // itself is the finding.
      entry.unreportedRuns++;
      return;

    case "empty": {
      entry.emptyRuns++;
      entry.consecutiveEmpty++;
      entry.lastEmptyAt = nowMs;
      entry.lastEmptyReason = outcome.reason;
      if (entry.consecutiveEmpty > entry.longestEmptyRun) {
        entry.longestEmptyRun = entry.consecutiveEmpty;
      }
      if (shouldWarnAtRunLength(entry.consecutiveEmpty)) {
        log.warn(
          {
            type,
            consecutiveEmpty: entry.consecutiveEmpty,
            lastProducedAt: entry.lastProducedAt,
            reason: outcome.reason,
          },
          `${type} has completed ${entry.consecutiveEmpty} times in a row without writing anything`,
        );
      }
      return;
    }
  }
}

/**
 * Say what is wrong in the terms the owner would use. "Degraded" is
 * deliberately not "errored": a job that completes several hundred times and
 * writes nothing has thrown nothing at all, and the missing rows are the only
 * symptom that exists.
 */
function evaluateDegraded(entries: JobTypeOutcomeStats[]): {
  degraded: boolean;
  degradedReason: string | null;
} {
  const worst = entries.find((e) => e.consecutiveEmpty >= EMPTY_RUN_WARN_AT);
  if (worst) {
    const noun = worst.totalProduced === 0 ? "ever" : "since it last did";
    return {
      degraded: true,
      degradedReason:
        `${worst.type} has run ${worst.consecutiveEmpty} times in a row and written nothing ${noun}` +
        (worst.lastEmptyReason ? ` — ${worst.lastEmptyReason}.` : "."),
    };
  }
  return { degraded: false, degradedReason: null };
}

/**
 * A snapshot; the caller cannot mutate the live record. Sorted worst-first so
 * a surface that shows only the top row shows the row that matters.
 */
export function getMemoryJobOutcomeHealth(): MemoryJobOutcomeHealth {
  const types = [...stats.values()]
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        b.consecutiveEmpty - a.consecutiveEmpty ||
        b.longestEmptyRun - a.longestEmptyRun ||
        a.type.localeCompare(b.type),
    );
  return { since, types, ...evaluateDegraded(types) };
}

/** Test-only: forget the record so files do not leak state into each other. */
export function resetMemoryJobOutcomeHealth(nowMs = Date.now()): void {
  stats = new Map();
  since = nowMs;
}
