import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_automations_v1";

/**
 * Automations layer (WS-F): structured Playbooks + a watcher intake mode.
 *
 * Migration slot 313 — chosen high in the free range (307–310 were the last
 * used) and past the WS-A..WS-E band to avoid colliding with sibling
 * pre-alpha workstreams that also claim slots. See
 * docs/prealpha-adoption-program.md (WS-F).
 *
 * Two additive changes, both idempotent:
 *
 *  1. `playbooks` — a first-class trigger→action rule table (replacing the
 *     loose memory-graph-node encoding the old bundled-skill tools used).
 *     Columns:
 *       - trigger_text / channel / watcher_id — what fires the rule. A
 *         playbook may scope to a channel ('*' = any), a specific watcher, or
 *         both. `trigger_text` is a case-insensitive substring matched against
 *         the incoming item's title+summary.
 *       - action — natural-language description of what to do.
 *       - autonomy_level — the *requested* autonomy ('auto' | 'draft' |
 *         'notify'). The EFFECTIVE autonomy is computed at read/fire time by
 *         clamping this against the global trust dial (see
 *         playbooks/autonomy-cap.ts). The stored value is never silently
 *         downgraded — the cap is applied on top so the UI can show the 🔒
 *         capped state honestly.
 *       - priority — higher wins when several playbooks match one event.
 *       - enabled / last_fired_at — lifecycle + the W3 "last-fired" column.
 *
 *  2. `watchers.intake_mode` — how a watcher's new events are dispositioned:
 *       - 'came_in' (default for watchers created via the Automations UI) —
 *         each new event is filed into the Came-in lane as a work item, then
 *         run through playbook evaluation. This is the event-driven layer the
 *         cadence-based missions lack.
 *       - 'agent' — the legacy behaviour: process pending events through a
 *         background LLM job using the watcher's action_prompt. The column
 *         backfills to 'agent' so every PRE-EXISTING watcher keeps its exact
 *         current behaviour; the watcher store explicitly stamps 'came_in' on
 *         watchers created after this migration.
 */
export function migrateAutomations(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT '*',
        watcher_id TEXT,
        action TEXT NOT NULL,
        autonomy_level TEXT NOT NULL DEFAULT 'draft',
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at INTEGER,
        scope_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_playbooks_enabled_priority
        ON playbooks (enabled, priority DESC)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_playbooks_watcher
        ON playbooks (watcher_id)
    `);

    if (!tableHasColumn(database, "watchers", "intake_mode")) {
      // Backfill existing rows to 'agent' so live watchers keep the LLM path;
      // watcher-store stamps 'came_in' on newly created watchers.
      raw.exec(
        /*sql*/ `ALTER TABLE watchers ADD COLUMN intake_mode TEXT NOT NULL DEFAULT 'agent'`,
      );
    }
  });
}
