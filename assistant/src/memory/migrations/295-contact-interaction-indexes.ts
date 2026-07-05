import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_contact_interaction_indexes_v1";

/**
 * Indexes for the contact-dossier interactions-stitching query
 * (contact-dossier-store.ts::getContactInteractions).
 *
 * The dossier's interactions timeline joins a contact's channel identities
 * against three binding tables, each filtered by (source_channel/from-to,
 * external_chat_id). Before this migration none of those predicates were
 * indexed:
 *
 *   - external_conversation_bindings: PK is conversation_id, so a lookup by
 *     (source_channel, external_chat_id) was a full table scan.
 *   - assistant_inbox_conversation_state: same — PK is conversation_id.
 *   - call_sessions: only idx_call_sessions_status existed; the interactions
 *     query matches on from_number / to_number, both unindexed.
 *
 * On a warm SQLite page cache these scans are cheap, but the FIRST (cold) hit
 * on a large history took ~5.4s. These indexes turn each per-identity lookup
 * into an index seek so the cold dossier read is bounded.
 *
 * IF NOT EXISTS keeps this idempotent and safe to re-run.
 */
export function migrateContactInteractionIndexes(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    // external_conversation_bindings: WHERE source_channel = ? AND external_chat_id = ?
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS ecb_channel_chat_idx
      ON external_conversation_bindings (source_channel, external_chat_id)
    `);

    // assistant_inbox_conversation_state: WHERE source_channel = ? AND external_chat_id = ?
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS aics_channel_chat_idx
      ON assistant_inbox_conversation_state (source_channel, external_chat_id)
    `);

    // call_sessions: WHERE from_number IN (...) OR to_number IN (...).
    // Two single-column indexes so SQLite can OR-optimize each arm.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS call_sessions_from_number_idx
      ON call_sessions (from_number)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS call_sessions_to_number_idx
      ON call_sessions (to_number)
    `);
  });
}
