/**
 * Periodic work-item queue drainer.
 *
 * Closes the crash-recovery gap in the autonomous work loop: the auto-run
 * gate (`maybeAutoRunWorkItem`) only fires at capture-time triage, on an
 * explicit user "Run it", or from a mission cycle. Items that land back in
 * `queued` outside those moments — most importantly stranded runs the startup
 * watchdog requeues (`work-item-recovery.ts`), but also captures that lost the
 * concurrency race at triage time — stall forever until a human clicks Run.
 *
 * This module sweeps the `queued` lane on an interval and hands eligible items
 * to the EXACT same gate triage uses. It is deliberately NOT a second
 * execution engine:
 *
 *   - every start goes through `maybeAutoRunWorkItem`, so the hard-deny floor,
 *     the per-category autonomy policy (a "policy_ask" item NEVER auto-runs
 *     from here), the CUE_DISABLE_WORKITEM_AUTORUN kill switch, and the
 *     concurrency cap all apply unchanged;
 *   - the drainer adds only scheduling concerns on top: skip items still in
 *     capture-triage flight (created/updated within the last ~2 minutes),
 *     skip items past the recovery-attempt cap (with a one-time progress note
 *     saying why), start at most a few items per sweep, and stop early when
 *     the gate reports the concurrency cap.
 *
 * Env knobs (read at call time so a supervisor can flip them live):
 *   CUE_QUEUE_DRAINER_INTERVAL_MS — sweep interval, default 5 minutes.
 *   CUE_DISABLE_QUEUE_DRAINER     — "1"/"true" disables sweeping entirely.
 *
 * Non-throwing by design: a per-item failure is logged and skipped, and a
 * sweep-level failure is logged and swallowed, so the interval can never take
 * the daemon down or wedge itself.
 */

import { getLogger } from "../util/logger.js";
import { MAX_WORK_ITEM_RECOVERY_ATTEMPTS } from "./work-item-recovery.js";
import { broadcastWorkItemStatus } from "./work-item-runner.js";
import {
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";
import {
  type AutoRunDecision,
  maybeAutoRunWorkItem,
} from "./work-item-triage.js";

const log = getLogger("work-item-queue-drainer");

/** Default sweep interval: 5 minutes. */
export const DEFAULT_DRAINER_INTERVAL_MS = 5 * 60_000;

/** Floor for the env-configured interval so a typo can't busy-loop the daemon. */
const MIN_DRAINER_INTERVAL_MS = 10_000;

/**
 * Items created/updated more recently than this are still in capture-triage
 * flight (triage's flash-LLM scoring + auto-run evaluation run right after
 * capture) — the drainer leaves them alone to avoid double-dispatch races.
 */
export const CAPTURE_FLIGHT_WINDOW_MS = 2 * 60_000;

/**
 * At most this many background runs are started per sweep. The auto-run gate's
 * own concurrency cap (2) is the real ceiling; this just keeps a single sweep
 * from flooding the runner when the cap frees up between items.
 */
export const MAX_STARTS_PER_SWEEP = 2;

/**
 * One-time progress note stamped on items the drainer refuses because they hit
 * the recovery-attempt cap. Stable text (prefix-checked before writing) so
 * repeated sweeps don't spam DB writes/broadcasts.
 */
export function attemptCapNote(attempts: number): string {
  return `Auto-retry paused after ${attempts} stranded runs — press Run to try again.`;
}

/** "1"/"true" (matching the env-registry flag convention) disables sweeps. */
export function isQueueDrainerDisabled(): boolean {
  const raw = process.env.CUE_DISABLE_QUEUE_DRAINER?.trim();
  return raw === "1" || raw === "true";
}

/** Sweep interval from CUE_QUEUE_DRAINER_INTERVAL_MS, clamped to a sane floor. */
export function getQueueDrainerIntervalMs(): number {
  const raw = process.env.CUE_QUEUE_DRAINER_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_DRAINER_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DRAINER_INTERVAL_MS;
  }
  return Math.max(parsed, MIN_DRAINER_INTERVAL_MS);
}

export interface QueueDrainSweepResult {
  /** Queued items considered this sweep. */
  scanned: number;
  /** Background runs actually started (gate passed). */
  started: number;
  /** Skipped: still inside the capture-triage flight window. */
  skippedRecent: number;
  /** Skipped: at/over the recovery-attempt cap (noted once on the item). */
  skippedAttemptCap: number;
  /** Left queued: gate said no (policy_ask/hard_denied/concurrency/...). */
  deferred: number;
}

function emptyResult(): QueueDrainSweepResult {
  return {
    scanned: 0,
    started: 0,
    skippedRecent: 0,
    skippedAttemptCap: 0,
    deferred: 0,
  };
}

/**
 * Queue order for the drainer: sortIndex ascending (nulls last — un-triaged
 * items go behind ranked ones), oldest-created first as the tiebreak.
 */
function orderForDrain(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const sa = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.createdAt - b.createdAt;
  });
}

/**
 * Stamp the attempt-cap note exactly once. Prefix-matched so a later
 * attempts-count change still counts as "already noted".
 */
function noteAttemptCapOnce(item: WorkItem): void {
  const note = attemptCapNote(item.recoveryAttempts ?? 0);
  if (item.lastProgressNote?.startsWith("Auto-retry paused after")) return;
  try {
    updateWorkItem(item.id, { lastProgressNote: note }, { actor: "drainer" });
    broadcastWorkItemStatus(item.id);
  } catch (err) {
    log.debug(
      { err: String(err), workItemId: item.id },
      "failed to stamp attempt-cap note (ignored)",
    );
  }
}

/** Injectable auto-run gate — production always uses the real triage gate. */
type AutoRunGate = (workItemId: string) => Promise<AutoRunDecision>;

/**
 * One sweep over the queued lane. Exported for tests and never rejects — all
 * failures degrade to "item stays queued exactly as it was".
 *
 * `now` and `gate` are injectable for deterministic tests; production callers
 * use the defaults (wall clock + the real `maybeAutoRunWorkItem`).
 */
export async function sweepWorkItemQueue(
  now: number = Date.now(),
  gate: AutoRunGate = maybeAutoRunWorkItem,
): Promise<QueueDrainSweepResult> {
  const result = emptyResult();
  if (isQueueDrainerDisabled()) return result;

  let queued: WorkItem[];
  try {
    queued = listWorkItems({ status: "queued" });
  } catch (err) {
    log.warn(
      { err: String(err) },
      "queue drainer: listing queued items failed (sweep skipped)",
    );
    return result;
  }

  for (const item of orderForDrain(queued)) {
    result.scanned++;
    try {
      // Freshly captured/edited items are still owned by the capture-triage
      // flow (or a human actively editing) — leave them alone this sweep.
      const lastTouched = Math.max(item.createdAt, item.updatedAt);
      if (now - lastTouched < CAPTURE_FLIGHT_WINDOW_MS) {
        result.skippedRecent++;
        continue;
      }

      // Items that already stranded MAX times are a human's call now — note
      // why once, never auto-retry them again.
      if ((item.recoveryAttempts ?? 0) >= MAX_WORK_ITEM_RECOVERY_ATTEMPTS) {
        result.skippedAttemptCap++;
        noteAttemptCapOnce(item);
        continue;
      }

      if (result.started >= MAX_STARTS_PER_SWEEP) {
        result.deferred++;
        continue;
      }

      // The one and only execution path: the same policy-gated auto-run gate
      // capture-time triage uses. "ask" policies, the hard-deny floor, the
      // autorun kill switch, and the concurrency cap are all enforced inside.
      const decision = await gate(item.id);
      if (decision.started) {
        result.started++;
        log.info(
          { workItemId: item.id, title: item.title },
          "queue drainer re-dispatched a stalled queued item",
        );
        continue;
      }
      result.deferred++;
      if (decision.reason === "concurrency_cap") {
        // No point evaluating the rest of the queue — the cap applies to all.
        result.deferred += Math.max(0, queued.length - result.scanned);
        break;
      }
      log.debug(
        { workItemId: item.id, reason: decision.reason },
        "queue drainer left item queued",
      );
    } catch (err) {
      log.warn(
        { err: String(err), workItemId: item.id },
        "queue drainer: item evaluation failed (skipped)",
      );
    }
  }

  if (result.started > 0 || result.skippedAttemptCap > 0) {
    log.info({ ...result }, "queue drainer sweep finished");
  }
  return result;
}

interface DrainerController {
  stop(): void;
}

let activeController: DrainerController | null = null;

/**
 * Start the periodic drainer. Idempotent — a second call returns the running
 * controller. The kill switch and interval are read at sweep/start time, so
 * CUE_DISABLE_QUEUE_DRAINER=1 in the process env silences sweeps without a
 * restart (each sweep re-checks it), matching the auto-run kill switch.
 *
 * The timer is unref'd: it must never hold the daemon process open.
 */
export function startWorkItemQueueDrainer(): DrainerController {
  if (activeController) return activeController;

  const intervalMs = getQueueDrainerIntervalMs();
  log.info(
    { intervalMs, disabled: isQueueDrainerDisabled() },
    "work-item queue drainer started",
  );

  const timer = setInterval(() => {
    // sweepWorkItemQueue never rejects, but a belt-and-suspenders catch keeps
    // an unforeseen sync throw from becoming an unhandled rejection.
    void sweepWorkItemQueue().catch((err) => {
      log.warn({ err: String(err) }, "queue drainer sweep failed (ignored)");
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
