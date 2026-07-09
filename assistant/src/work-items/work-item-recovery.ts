/**
 * WS3 — startup recovery of stranded background work-item runs.
 *
 * A background work-item run executes in an in-memory async loop
 * (work-item-runner). If the daemon is OOM-killed or restarted mid-run, the row
 * is left `status='running'` with no process behind it — a stranded run that
 * never completes or retries. At startup this is unambiguous: ANY `running`
 * item is orphaned, because the loop that owned it died with the previous
 * process. So — unlike mid-operation silence detection — requeuing here carries
 * NO double-run risk (nothing is in flight at startup).
 *
 * Policy: requeue a stranded item (bounded by `recovery_attempts`) so it
 * re-runs; once it has stranded `MAX_WORK_ITEM_RECOVERY_ATTEMPTS` times, fail
 * it as a `run_recovered` recovery incident rather than requeue forever. Runs
 * once at daemon boot from `daemon/lifecycle.ts`, alongside the turn/schedule/
 * call recoveries.
 */
import { getLogger } from "../util/logger.js";
import { recordWorkItemEvent } from "./work-item-events.js";
import { listWorkItems, updateWorkItem } from "./work-item-store.js";

const log = getLogger("work-item-recovery");

/** Max times the watchdog requeues a stranded item before failing it. */
export const MAX_WORK_ITEM_RECOVERY_ATTEMPTS = 3;

export interface WorkItemRecoveryResult {
  /** Stranded items requeued to run again. */
  requeued: number;
  /** Stranded items failed as recovery incidents (hit the retry cap). */
  stalled: number;
  ids: string[];
}

/**
 * Reconcile stranded `running` work items left by a previous daemon process.
 * Best-effort: a per-item failure is logged and skipped, never thrown, so one
 * bad row can't block boot.
 */
export function recoverOrphanedWorkItemRuns(): WorkItemRecoveryResult {
  const result: WorkItemRecoveryResult = { requeued: 0, stalled: 0, ids: [] };

  let running: ReturnType<typeof listWorkItems>;
  try {
    running = listWorkItems({ status: "running" });
  } catch (err) {
    log.warn(
      { err: String(err) },
      "work-item recovery: listing running items failed (skipped)",
    );
    return result;
  }

  for (const item of running) {
    try {
      const attempts = item.recoveryAttempts ?? 0;
      if (attempts >= MAX_WORK_ITEM_RECOVERY_ATTEMPTS) {
        updateWorkItem(
          item.id,
          {
            status: "failed",
            lastRunStatus: "failed",
            livenessState: "stalled",
            lastProgressNote: `Stopped: the run kept stranding after ${attempts} recovery attempts. Re-run it manually or check the logs.`,
          },
          { actor: "watchdog" },
        );
        recordWorkItemEvent({
          workItemId: item.id,
          kind: "run_recovered",
          fromStatus: "running",
          toStatus: "failed",
          actor: "watchdog",
        });
        result.stalled++;
      } else {
        updateWorkItem(
          item.id,
          {
            status: "queued",
            recoveryAttempts: attempts + 1,
            livenessState: "recovered",
            // Clear the stale "Searching the web…" note from the dead run.
            lastProgressNote: null,
          },
          { actor: "watchdog" },
        );
        recordWorkItemEvent({
          workItemId: item.id,
          kind: "run_recovered",
          fromStatus: "running",
          toStatus: "queued",
          actor: "watchdog",
        });
        result.requeued++;
      }
      result.ids.push(item.id);
    } catch (err) {
      log.warn(
        { err: String(err), workItemId: item.id },
        "work-item recovery: item recovery failed (skipped)",
      );
    }
  }

  if (result.requeued + result.stalled > 0) {
    log.info(
      { requeued: result.requeued, stalled: result.stalled },
      "recovered stranded work-item runs at startup",
    );
  }
  return result;
}
