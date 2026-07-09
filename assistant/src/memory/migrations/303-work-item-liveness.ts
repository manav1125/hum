import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_liveness_v1";

/**
 * WS3 — background work-item run liveness/recovery columns (Paperclip-inspired).
 *
 * A background work-item run executes in an in-memory async loop
 * (work-item-runner). If the daemon is OOM-killed / restarted mid-run, the row
 * is left `status='running'` forever with no process behind it — a stranded
 * run that never completes or retries (our documented daemon-restart scar
 * tissue). These columns let a startup sweep detect + bounded-recover such
 * orphans.
 *
 * Columns (additive, default-preserving — pre-WS3 rows behave identically):
 *   - work_items.recovery_attempts INTEGER NOT NULL DEFAULT 0 — how many times
 *     the watchdog has requeued this item after a stranded run. Bounds retries
 *     so an item that strands every run isn't requeued forever.
 *   - work_items.liveness_state    TEXT — nullable marker: NULL = healthy/never
 *     recovered; 'recovered' = requeued after a stranded run; 'stalled' =
 *     hit the retry cap and was failed as a recovery incident.
 *
 * Enforcement lives in work-items/work-item-recovery.ts
 * (recoverOrphanedWorkItemRuns), invoked once at daemon startup from
 * daemon/lifecycle.ts alongside the turn/schedule/call recoveries.
 *
 * Idempotent: each ALTER is guarded by a PRAGMA column check.
 */
export function migrateWorkItemLiveness(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const cols = raw
      .prepare(/*sql*/ `PRAGMA table_info(work_items)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "recovery_attempts")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!cols.some((c) => c.name === "liveness_state")) {
      raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN liveness_state TEXT`);
    }
  });
}
