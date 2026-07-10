import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_agents_v1";

/**
 * Create the `agents` table — the server-side agent registry behind the
 * Agents · org page (HQ). One row is one standing role the owner staffs their
 * company with (Ops / Growth / Inbox / …). Replaces the localStorage-only
 * charter config the web page used in Phase 1, so charters persist across
 * devices and other surfaces (work-item assignment, spend attribution) can
 * read them.
 *
 *   - `name` is both the display name and the work-item `assignee` match key
 *     (matched case-insensitively). `cue` is the implicit house agent and is
 *     NOT seeded — a null work-item assignee reads as "cue" everywhere.
 *   - `tier` is the autonomy tier ('1'..'4', stored as text for headroom).
 *   - `cap_cents` is the weekly spend cap in cents; null = uncapped. Stored in
 *     cents to match missions.budget_cents (the money unit of record).
 *   - `paused` (0/1) mirrors the charter pause toggle.
 *
 * Idempotent by construction: the CREATE is `IF NOT EXISTS`, and the three
 * default roles are seeded only when the table is empty, so re-running on
 * every startup neither duplicates nor resurrects deleted rows.
 *
 * References are by convention (no FKs), matching the sibling HQ tables
 * (missions, projects, work_outputs, agent_acts).
 */
export function migrateCreateAgents(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT,
        domain TEXT,
        charter TEXT,
        tier TEXT NOT NULL DEFAULT '1',
        cap_cents INTEGER,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Roster reads are name-ordered; the assignee-match lookup is by name.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS agents_name_idx ON agents (name)
    `);

    // Seed the three default roles ONLY on a fresh (empty) table so this is
    // safe to re-run and never resurrects a role the owner retired.
    const count = raw
      .prepare(/*sql*/ `SELECT COUNT(*) AS n FROM agents`)
      .get() as { n: number };
    if (count.n === 0) {
      const now = Date.now();
      const insert = raw.prepare(/*sql*/ `
        INSERT INTO agents
          (id, name, emoji, domain, charter, tier, cap_cents, paused, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
      `);
      const defaults: Array<[string, string, string, string, string, string]> =
        [
          [
            "ops",
            "Ops",
            "⚙",
            "Operations",
            "Keep the calendar clean and vendors paid — never let a thread go cold.",
            "3",
          ],
          [
            "growth",
            "Growth",
            "✦",
            "Marketing",
            "Draft outreach and grow pipeline — never send without me; protect the brand voice.",
            "2",
          ],
          [
            "inbox",
            "Inbox",
            "✉",
            "Inbox",
            "Triage, file, and reply to the routine — surface only what needs me.",
            "2",
          ],
        ];
      for (const [id, name, emoji, domain, charter, tier] of defaults) {
        insert.run(id, name, emoji, domain, charter, tier, now, now);
      }
    }
  });
}
