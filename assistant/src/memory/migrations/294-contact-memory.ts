import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_contact_memory_v1";

/**
 * People "relationship memory" backend — the data model behind the
 * Claude-Projects-style contact dossier (Cue-Surfaces S4: trust badge
 * HUMAN·STRONG·70%, "WHAT CUE REMEMBERS", "REACHABLE ON", interactions
 * timeline).
 *
 * Two new tables; everything else the dossier renders (reachability,
 * interactions) is DERIVED on read from existing contacts / contact_channels /
 * conversation binding tables — no duplication.
 *
 *   - contact_memory: the "WHAT CUE REMEMBERS" store. One row = one durable
 *     fact/preference/relationship/context statement Cue knows about the
 *     person, with provenance (told | inferred | from_conversation), an
 *     optional source_ref (conversation/message id), a confidence 0..1, and
 *     first-seen / last-seen timestamps. Statements are the honest source of
 *     the dossier's memory section — populated by the manual "remember about X"
 *     path today and by light auto-extraction going forward.
 *
 *   - contact_relationship: a MATERIALIZED relationship signal (score 0..100 +
 *     tier weak|building|strong) per contact. Chosen over derive-on-read
 *     because the score's inputs (interaction recency + volume, channel
 *     verification) already live denormalized on contact_channels
 *     (interaction_count, last_interaction, status) and change only when those
 *     stats change — so keeping a cached row fresh via one recompute at the
 *     same write sites is cheaper than recomputing the blended score on every
 *     dossier read, and it lets the People list sort/filter by tier with a
 *     single indexed read. The row is a cache: recomputeContactRelationship()
 *     rebuilds it deterministically from live channel stats, so a stale or
 *     missing row is always self-healing on the next dossier read.
 *
 * Referential integrity to contacts is by convention (store-enforced) for
 * contact_relationship's cache semantics; contact_memory uses a real FK with
 * ON DELETE CASCADE so forgetting a contact forgets its facts.
 *
 * NO backfill: the memory ledger starts empty (the dossier's honest empty
 * state is "Cue hasn't learned anything durable yet"); relationship rows are
 * created lazily on first dossier read / first fact, derived from whatever
 * channel interaction stats already exist.
 */
export function migrateCreateContactMemory(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS contact_memory (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        source TEXT NOT NULL DEFAULT 'told',
        source_ref TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);

    // The dossier's "WHAT CUE REMEMBERS" read is "all memory for this contact,
    // newest-seen first".
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS contact_memory_contact_seen_idx
      ON contact_memory (contact_id, last_seen_at)
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS contact_relationship (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        score INTEGER NOT NULL DEFAULT 0,
        tier TEXT NOT NULL DEFAULT 'weak',
        last_interaction_at INTEGER,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);

    // The People list sorts/filters by relationship strength.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS contact_relationship_tier_score_idx
      ON contact_relationship (tier, score)
    `);
  });
}
