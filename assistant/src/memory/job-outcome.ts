// ---------------------------------------------------------------------------
// Memory jobs — what a job DID, as distinct from whether it finished.
//
// `memory_jobs.status` answers "did the handler return without throwing".
// It has no opinion about whether anything reached a store, so a handler that
// runs 697 times and writes nothing looks exactly like one that works. That
// collapsed distinction is the most expensive bug class this codebase has:
//
//   - contact_memory_extract — 697 completed jobs, 0 rows written.
//   - graph extraction — ~190 of 237 runs in one day logged "complete" with
//     nodesCreated: 0, because the checkpoint advanced past messages it never
//     read.
//   - the auto-filer — 12 sweeps of 12 aborted mid-call and reported success.
//
// Every one was found late. This module gives the worker a second axis so
// "completed" and "completed having written nothing" stop being the same fact.
//
// ## Producing nothing is sometimes correct
//
// A memory sweep over a quiet week genuinely has nothing to write, and a prune
// with nothing older than the retention window genuinely deletes nothing. So
// `empty` is NOT an error and must never be reported as one. What deserves
// attention is a *run* of them — see `job-outcome-health.ts`, which counts the
// run and says how long it is.
//
// ## The four outcomes are deliberately not three
//
// The temptation is to fold `skipped` into `empty` (both wrote nothing) or to
// let `unreported` default to `produced` (it completed, didn't it?). Both
// collapses recreate the bug:
//
//   - `skipped` is a gate the owner or the config closed — v2 being on, a
//     feature flag being off, a payload with no id. A hundred of those in a row
//     is the system working. A hundred `empty` in a row is not.
//   - `unreported` is the honest answer for a handler that has not been taught
//     to count. It must stay visibly distinct from `produced`, because counting
//     it as work is precisely the lie this module exists to stop telling.
// ---------------------------------------------------------------------------

/**
 * - `produced` — records reached a store. `produced` is how many.
 * - `empty` — the handler ran end to end and wrote nothing. An outcome, not a
 *   failure. `reason` says what it looked at and came away with.
 * - `skipped` — the handler did not do its work at all: gated off, disabled,
 *   or handed a payload it could not act on. Never counts toward an empty run.
 * - `unreported` — the handler has not been taught to report. Counted on its
 *   own so the gap is visible instead of being laundered into success.
 */
export type JobOutcomeKind = "produced" | "empty" | "skipped" | "unreported";

export interface JobOutcome {
  readonly kind: JobOutcomeKind;
  /**
   * Records that reached a store. Zero for every kind except `produced`,
   * which is always > 0 — construct via {@link jobProduced} or
   * {@link jobProducedOrEmpty} rather than building the object by hand.
   */
  readonly produced: number;
  /** Why nothing was produced, or why the handler did not run. */
  readonly reason: string | null;
  /**
   * Named sub-counts for the log line — `{ nodesCreated: 3, edgesCreated: 1 }`.
   * Kept alongside `produced` rather than replacing it: the total is what the
   * health surface counts, the breakdown is what a human reads.
   */
  readonly detail?: Readonly<Record<string, number>>;
}

/** The handler wrote `count` records. Callers must pass a positive count. */
export function jobProduced(
  count: number,
  detail?: Readonly<Record<string, number>>,
): JobOutcome {
  return { kind: "produced", produced: count, reason: null, detail };
}

/** The handler ran fully and wrote nothing. Not an error. */
export function jobEmpty(
  reason: string,
  detail?: Readonly<Record<string, number>>,
): JobOutcome {
  return { kind: "empty", produced: 0, reason, detail };
}

/** The handler did not run its work: gated off, disabled, nothing to act on. */
export function jobSkipped(reason: string): JobOutcome {
  return { kind: "skipped", produced: 0, reason, detail: undefined };
}

/**
 * The workhorse. Hand it the count the handler already has and the sentence
 * that describes a zero, and it picks the right kind — so the correct thing is
 * also the shortest thing to write at a call site.
 */
export function jobProducedOrEmpty(
  count: number,
  emptyReason: string,
  detail?: Readonly<Record<string, number>>,
): JobOutcome {
  return count > 0 ? jobProduced(count, detail) : jobEmpty(emptyReason, detail);
}

/**
 * This handler cannot yet say what it did. Distinct from `empty` (which is a
 * claim) and from `produced` (which would be a false one).
 */
export const JOB_OUTCOME_UNREPORTED: JobOutcome = {
  kind: "unreported",
  produced: 0,
  reason: "handler does not report an outcome",
  detail: undefined,
};

/** Sum several sub-counts into the single number the health surface tracks. */
export function sumDetail(detail: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(detail)) {
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/**
 * Build an outcome from a bag of named write-counts: `produced` when any are
 * positive, `empty` otherwise, with the breakdown carried either way. This is
 * the shape most graph handlers already have (`nodesCreated`, `edgesCreated`,
 * …) — they were computing the answer and throwing it away in a log line.
 */
export function jobOutcomeFromDetail(
  detail: Readonly<Record<string, number>>,
  emptyReason: string,
): JobOutcome {
  return jobProducedOrEmpty(sumDetail(detail), emptyReason, detail);
}

/** True when the run genuinely attempted the work — `produced` or `empty`. */
export function jobOutcomeRan(outcome: JobOutcome): boolean {
  return outcome.kind === "produced" || outcome.kind === "empty";
}

// ---------------------------------------------------------------------------
// Queue resolution — how the row should read after a non-throwing handler.
//
// `JobOutcome` answers "what did the run write". It deliberately has no
// opinion on the job row's status, which is how a retrospective whose wake
// failed (a returned `wake_failed`, not a throw) still landed a `completed`
// row: the worker's only non-throw vocabulary was "complete it". This second
// axis lets a handler that reports failure through a returned domain outcome
// translate it into the row's real disposition. Ported from upstream
// 6d3f5d2e5b (there `JobQueueResolution` in plugins/types.ts).
// ---------------------------------------------------------------------------

/**
 * How the worker resolves a claimed job row after its handler returns
 * without throwing.
 *
 * - `completed`: the work succeeded (or was a legitimate no-op).
 * - `failed`: terminal failure; the row is dead-lettered with
 *   `errorMessage` as `last_error`. Use when retry is owned elsewhere
 *   (event-driven re-enqueue, durable backoff checkpoints).
 * - `retryable`: transient failure; the row re-enters the queue's
 *   attempt-budgeted retry machinery with `errorMessage` recorded.
 * - `deferred`: the work could not run yet for a reason external to the
 *   job (e.g. its source conversation is mid-turn); the row goes back to
 *   pending on the deferral counter's backoff curve and dead-letters with
 *   `deferralExhaustedMessage` once the deferral budget is spent.
 */
export interface JobQueueResolution {
  queueResolution: "completed" | "failed" | "retryable" | "deferred";
  /** Persisted to `memory_jobs.last_error` for `failed` / `retryable`. */
  errorMessage?: string;
  /** Retry delay override for `retryable`. */
  retryDelayMs?: number;
  /** Terminal `last_error` when a `deferred` job exhausts its budget. */
  deferralExhaustedMessage?: string;
}

/**
 * What `processJob` hands back to the worker's completion site: the write
 * outcome (the row's `outcome` columns, when the row completes) plus the
 * row's queue disposition.
 */
export interface JobHandlerResult {
  outcome: JobOutcome;
  queue: JobQueueResolution;
}

/** The common case: the row completes and records `outcome`. */
export function jobCompleted(outcome: JobOutcome): JobHandlerResult {
  return { outcome, queue: { queueResolution: "completed" } };
}
