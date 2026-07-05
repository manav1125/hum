import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_create_kits_v1";

/**
 * Create the `kits` + `kit_assets` tables — the coordinated single-pass
 * "asset kit" behind Create Studio's fan-out (one brief → deck + one-pager +
 * social set + … produced together and tracked as a set).
 *
 * A `kits` row is one launched kit: the shared brief, the design-contract
 * preamble every asset was seeded with, and the brand kit applied to all of
 * them. A `kit_assets` row is one format in the kit (deck / one-pager / social
 * / …) — each maps to a Create mode/skill and runs in its own background
 * generation conversation, so the set reads as coordinated (shared
 * brief + contract + brand) while each asset renders in the right surface.
 *
 *   - `kits.brand_kit_id` references a brand_profiles row by convention (no FK,
 *     matching the sibling HQ tables — brand_profiles, missions, work_outputs).
 *     Null = the kit was produced un-branded.
 *   - `kits.contract_preamble` is the compiled design-contract block prepended
 *     to every asset's seed prompt (see create-intent.ts on the frontend). It
 *     is captured on the kit so a regenerate re-seeds with the exact same
 *     constraints the original run used.
 *   - `kit_assets.format` is the fan-out format id ('slides' | 'one_pager' |
 *     'social' | 'email' | 'landing' | …).
 *   - `kit_assets.mode` is the Create mode the format resolves to (slides →
 *     app-builder, docs → document-editor, image → replicate, …). Stored so a
 *     regenerate re-runs the same skill without re-deriving the mapping.
 *   - `kit_assets.conversation_id` is the background generation conversation
 *     the asset ran in; the produced attachment(s) live there. Null until the
 *     run is launched.
 *   - `kit_assets.status` is 'pending' | 'running' | 'done' | 'failed'.
 *   - `kit_assets.output_ref` is the attachment id of the produced deliverable
 *     (the first attachment the run emitted), or null.
 *
 * Idempotent by construction: both CREATEs and the INDEX are `IF NOT EXISTS`,
 * so re-running on every startup is a no-op. No rows are seeded.
 */
export function migrateCreateKits(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS kits (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        brief TEXT NOT NULL,
        brand_kit_id TEXT,
        contract_preamble TEXT,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS kit_assets (
        id TEXT PRIMARY KEY,
        kit_id TEXT NOT NULL,
        format TEXT NOT NULL,
        mode TEXT NOT NULL,
        conversation_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        output_ref TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // The status view of a kit is always "all assets for this kit"; the
    // assistant-scoped list is "all kits for this assistant".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS kit_assets_kit_id_idx
        ON kit_assets (kit_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS kits_assistant_id_idx
        ON kits (assistant_id)
    `);
  });
}
