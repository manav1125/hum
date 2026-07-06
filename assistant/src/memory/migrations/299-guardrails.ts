import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_guardrails_v1";

/**
 * Guardrails — the unified rules surface over the existing trust/approval/
 * spend/ledger plumbing. Two schema changes:
 *
 * 1. `agents.model` — nullable per-agent model pin (provider/model string,
 *    e.g. "anthropic/claude-haiku-4.5"). Background work-item runs for an
 *    assignee whose agent row pins a model execute on that model via the
 *    conversation-level `modelOverride` mechanism (see work-item-runner).
 *    Null = no pin — the run resolves its model normally.
 *
 * 2. `guardrail_checkpoints` — the "Cue always asks before…" rule registry.
 *    One row is one named, plain-English checkpoint:
 *      - `template` is the checkpoint kind ('send_message' | 'spend_over' |
 *        'publish' | 'delete' | 'contact' | 'custom').
 *      - `pattern` is the underlying enforcement pattern the template
 *        compiles to. Patterns of the form `autonomy:<class>` (send / money /
 *        delete / …) are ENFORCED by the permission checker: an enabled
 *        checkpoint tightens that autonomy category to "ask" on every tool
 *        call in scope (see guardrails/checkpoint-enforcement). Other pattern
 *        forms are declarative-only today — persisted and exposed with
 *        `enforced: false` so the UI can show them as "coming online".
 *      - `scope` is 'everywhere', 'agent:<agentId>', or 'mission:<missionId>'.
 *      - `threshold_cents` documents the spend_over dollar line. Advisory:
 *        per-action dollar cost is not knowable before execution, so an
 *        enabled spend_over checkpoint asks on ANY money-category action.
 *      - `is_default` marks the seeded starter rules so the UI can label them.
 *
 * Idempotent by construction: the ALTER is guarded by a PRAGMA column check,
 * the CREATE is `IF NOT EXISTS`, and the four default checkpoints are seeded
 * only when the table is empty — re-running on every startup neither
 * duplicates nor resurrects checkpoints the owner deleted.
 *
 * References are by convention (no FKs), matching the sibling HQ tables
 * (agents, missions, agent_acts).
 */
export function migrateGuardrails(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    // 1. Per-agent model pin — guarded ALTER so re-runs are no-ops.
    const agentColumns = raw
      .prepare(/*sql*/ `PRAGMA table_info(agents)`)
      .all() as Array<{ name: string }>;
    if (!agentColumns.some((c) => c.name === "model")) {
      raw.exec(/*sql*/ `ALTER TABLE agents ADD COLUMN model TEXT`);
    }

    // 2. Checkpoint registry.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS guardrail_checkpoints (
        id TEXT PRIMARY KEY,
        template TEXT NOT NULL,
        label TEXT NOT NULL,
        pattern TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'everywhere',
        threshold_cents INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // 3. Seed the default checkpoints ONLY on a fresh (empty) table so this
    // is safe to re-run and never resurrects a rule the owner deleted.
    const count = raw
      .prepare(/*sql*/ `SELECT COUNT(*) AS n FROM guardrail_checkpoints`)
      .get() as { n: number };
    if (count.n === 0) {
      const now = Date.now();
      const insert = raw.prepare(/*sql*/ `
        INSERT INTO guardrail_checkpoints
          (id, template, label, pattern, scope, threshold_cents, enabled, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'everywhere', ?, 1, 1, ?, ?)
      `);
      const defaults: Array<[string, string, string, string, number | null]> = [
        [
          "default-send",
          "send_message",
          "Sending any email or message",
          "autonomy:send",
          null,
        ],
        [
          "default-spend",
          "spend_over",
          "Spending over $10 in one action",
          "autonomy:money",
          1000,
        ],
        [
          "default-publish",
          "publish",
          "Posting or publishing publicly",
          "tool:publish_*",
          null,
        ],
        [
          "default-delete",
          "delete",
          "Deleting anything",
          "autonomy:delete",
          null,
        ],
      ];
      for (const [id, template, label, pattern, thresholdCents] of defaults) {
        insert.run(id, template, label, pattern, thresholdCents, now, now);
      }
    }
  });
}
