import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_autonomy_ledger_v1";

/**
 * The autonomy ledger — `autonomy_ledger`.
 *
 * Migration slot 316 — the next free slot after 315
 * (work-item-origin-conversation).
 *
 * One append-only row per CONSEQUENTIAL action Cue attempted on the owner's
 * behalf (external send, call, money, publish, delete, purchase, network-
 * egress shell, browser submit control, script-mode schedule, opaque external
 * runner, host file mutation), whatever the outcome — executed, parked,
 * denied, or failed. See `memory/schema/ledger.ts` for why this is distinct
 * from `tool_invocations` (per-conversation, cascaded away, no approval
 * provenance) and `agent_acts` (completed work-item runs, value accounting).
 *
 * Deliberately FK-free: deleting a conversation must never erase the record
 * of what was done from it. Additive and idempotent — a fresh table, no
 * backfill (the ledger honestly starts at the moment it was installed).
 */
export function migrateAutonomyLedger(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS autonomy_ledger (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        action_class TEXT NOT NULL,
        summary TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        attended INTEGER NOT NULL DEFAULT 0,
        approved_via TEXT,
        approval_detail TEXT,
        conversation_id TEXT,
        work_item_id TEXT,
        agent TEXT,
        request_id TEXT,
        duration_ms INTEGER,
        reason TEXT
      )
    `);

    // The owner-facing read is "newest first, optionally filtered to what ran
    // unattended / was parked" — both covered here.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_at
        ON autonomy_ledger (at DESC)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_outcome_at
        ON autonomy_ledger (outcome, at DESC)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_conversation
        ON autonomy_ledger (conversation_id)
    `);
  });
}
