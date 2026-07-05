import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_brand_profiles_v1";

/**
 * Create the `brand_profiles` table — the stored per-assistant Brand Kit
 * behind Create Studio (Layer 2 of the Create-Studio direction). One row is
 * one saved brand identity (palette / fonts / logo / voice / approved assets)
 * that Create outputs are rendered in. The kit is loaded via one of three
 * paths (upload a deck/PDF, scrape a website, or a guided visual journey) —
 * `source` records which one produced the row.
 *
 *   - `assistant_id` scopes the kit to its owning assistant (reference by
 *     convention, no FK — matching the sibling HQ tables). Indexed because the
 *     list + active-lookup reads are always assistant-scoped.
 *   - `palette` / `fonts` / `logo` / `voice` are JSON blobs (TEXT) holding the
 *     structured sub-objects (see brand-profile-store.ts for their shapes).
 *     Storing them as JSON keeps the column set stable as the design tokens
 *     evolve without a migration per field.
 *   - `assets` is a JSON array of approved-imagery refs.
 *   - `source` is 'upload' | 'website' | 'guided'.
 *   - `is_active` (0/1) marks the one kit applied everywhere. The
 *     single-active-per-assistant invariant is enforced in the store
 *     (setActive clears the others in a transaction), not by a DB constraint,
 *     so a partial-unique index is unnecessary and the store stays the single
 *     writer of the flag.
 *
 * Idempotent by construction: the CREATE and the INDEX are both
 * `IF NOT EXISTS`, so re-running on every startup is a no-op. No rows are
 * seeded — a fresh workspace has no brand until the user builds one.
 */
export function migrateCreateBrandProfiles(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS brand_profiles (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        palette TEXT,
        fonts TEXT,
        logo TEXT,
        voice TEXT,
        assets TEXT,
        source TEXT NOT NULL DEFAULT 'guided',
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // List + active-lookup reads are always assistant-scoped.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS brand_profiles_assistant_id_idx
        ON brand_profiles (assistant_id)
    `);
  });
}
