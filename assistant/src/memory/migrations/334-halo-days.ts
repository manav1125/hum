import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_halo_days_v1";

/**
 * Halo — the day a wearable heard, as the design draws it.
 *
 * Migration slot 334 — the next free slot after 333.
 *
 * Schema for `docs/design/halo/` (the H/V/E/F/G/R/S program). The table names
 * and the enum values here are the design's own words on purpose: when the
 * frames say a chapter has a pull-quote and a verdict, and that an absence is
 * one of exactly three kinds, the schema should say the same thing so nobody
 * has to translate between a spec and a column.
 *
 * ## Six tables, and why each is its own
 *
 * `halo_segments` — the ~20-second Opus files as they arrive. Kept separate
 * from episodes because they are the only honest source of **lag**: the
 * design's organizing idea is that Halo is "always a little behind the room,
 * never in it", and every surface wears that number. Lag is
 * `now - last segment's covered_through`, which is a fact about arrival, not
 * about understanding. Segments also carry the live strip's last snippet.
 *
 * `halo_days` — one row per local date, holding what the recap needs: the
 * serif verdict Cue wrote, and `heard_seconds` so the verdict can scope
 * itself. S4 is emphatic that a short day is still a day and that nothing may
 * be guessed into a gap, so `heard_seconds` exists to qualify every count
 * derived from it ("based on the 5 hours heard") rather than to score anyone.
 *
 * `halo_episodes` — the chapters. Titles, pull-quote, takeaways, the summary
 * template the reader chose. `state` carries S2's delete ladder: forgetting an
 * episode is a state change here, and the recall of its proposals hangs off it.
 *
 * `halo_marks` — the ⚑ bookmark and the ✦ spoken note, the only two things a
 * person can say to Halo with their hand. Their own table because the design
 * makes the bookmark the LOUDEST element on the Day — nothing Cue inferred may
 * outrank it — and a human signal filed in the same table as machine output
 * would eventually get sorted alongside it.
 *
 * `halo_gaps` — S4's gap grammar, which is the reason this table exists at
 * all. Three absences that must never be interchangeable: `not_worn` (dim,
 * captioned), `off_the_record` (dashed, chosen by a 3s hold), `battery`, plus
 * `forgotten` for a span deleted under S2. Storing "no data" as the absence of
 * rows would collapse all four into one shrug, and the frames are built on
 * telling them apart.
 *
 * `halo_proposals` — F2's queue. Every row is a PROPOSAL, exactly as
 * `note_extractions` is: nothing files without acceptance, low confidence
 * waits behind the fold, and dismissal is data because ✕ teaches. It carries
 * the verb and the NAMED destination the accept chip shows before you accept
 * ("▤ File to Renew Acme"), and `recalled_at` for S2's rule that forgetting an
 * episode recalls what it proposed.
 *
 * ## The provenance pill is columns, not a table
 *
 * `◉ heard · 10:31 · Verve` is described as one object that is both the
 * product's proof-of-magic and its audit trail, following every filed thing
 * into HQ, missions, chat and People. It is denormalised onto proposals and
 * onto `work_items` because it has to survive the episode being forgotten —
 * an audit trail that disappears when its source does is not one. Same reason
 * the quote is stored, not referenced.
 *
 * ## Audio is not here
 *
 * There is no audio path column anywhere, and that is the point: "audio
 * discarded at understanding" is a claim the design prints on the episode
 * header, so the schema is built so it cannot quietly stop being true.
 *
 * Idempotent: every table and index is `IF NOT EXISTS`, the two ALTERs are
 * column-guarded, and there is nothing to backfill.
 */
export function migrateHaloDays(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    // The arrival record. `covered_through` is when the AUDIO ends, which is
    // what lag is measured from; `synced_at` is when the bytes landed. Keeping
    // both is what lets the Day say "quiet since 4:10 · 3 min behind" without
    // conflating silence with lateness.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_segments (
        id TEXT PRIMARY KEY,
        device_session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        covered_through INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        transcript TEXT,
        snippet TEXT,
        episode_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_days (
        id TEXT PRIMARY KEY,
        local_date TEXT NOT NULL UNIQUE,
        verdict TEXT,
        verdict_written_at INTEGER,
        first_heard_at INTEGER,
        last_heard_at INTEGER,
        heard_seconds INTEGER NOT NULL DEFAULT 0,
        worn_seconds INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // `place_label` is a name the owner chose, never a coordinate: G2 is
    // explicit that Halo has no GPS and that places are labels, so there is
    // nowhere here to put a latitude even by accident.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_episodes (
        id TEXT PRIMARY KEY,
        day_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        place_label TEXT,
        title TEXT,
        summary TEXT,
        pull_quote TEXT,
        pull_quote_speaker TEXT,
        pull_quote_at INTEGER,
        key_takeaways TEXT,
        participants TEXT,
        transcript TEXT,
        template TEXT NOT NULL DEFAULT 'default',
        conversation_id TEXT,
        state TEXT NOT NULL DEFAULT 'kept',
        boundary_reason TEXT NOT NULL DEFAULT 'silence',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_marks (
        id TEXT PRIMARY KEY,
        day_id TEXT NOT NULL,
        episode_id TEXT,
        kind TEXT NOT NULL DEFAULT 'bookmark',
        marked_at INTEGER NOT NULL,
        words TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_gaps (
        id TEXT PRIMARY KEY,
        day_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reason TEXT NOT NULL,
        caption TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    // `destination_label` is what the accept chip prints BEFORE acceptance
    // ("Renew Acme"), and `destination_ref` is where it actually goes. Two
    // columns because the frames promise the person can read the destination
    // in advance, so it cannot be something only resolved on the way out.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS halo_proposals (
        id TEXT PRIMARY KEY,
        day_id TEXT NOT NULL,
        episode_id TEXT,
        mark_id TEXT,
        title TEXT NOT NULL,
        owner TEXT,
        verb TEXT NOT NULL DEFAULT 'file',
        destination_label TEXT,
        destination_ref TEXT,
        confidence_tier TEXT NOT NULL DEFAULT 'confident',
        state TEXT NOT NULL DEFAULT 'proposed',
        heard_quote TEXT,
        heard_at INTEGER,
        heard_place TEXT,
        heard_speaker TEXT,
        work_item_id TEXT,
        decided_at INTEGER,
        recalled_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_segments_session
        ON halo_segments (device_session_id, sequence)
    `);
    // The lag read: newest covered_through wins, and it runs on every surface.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_segments_covered
        ON halo_segments (covered_through DESC)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_segments_episode
        ON halo_segments (episode_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_episodes_day
        ON halo_episodes (day_id, chapter_index)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_episodes_started
        ON halo_episodes (started_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_marks_day
        ON halo_marks (day_id, marked_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_gaps_day
        ON halo_gaps (day_id, started_at)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_proposals_day
        ON halo_proposals (day_id, state)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_proposals_episode
        ON halo_proposals (episode_id)
    `);
    // F2's queue read: open proposals, newest first, confident before the fold.
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_halo_proposals_queue
        ON halo_proposals (state, confidence_tier, created_at DESC)
    `);

    // The provenance pill travelling with the work item. Denormalised for the
    // reason given above: it must outlive the episode it came from.
    if (!tableHasColumn(database, "work_items", "halo_episode_id")) {
      raw.exec(
        /*sql*/ `ALTER TABLE work_items ADD COLUMN halo_episode_id TEXT`,
      );
    }
    if (!tableHasColumn(database, "work_items", "halo_heard")) {
      raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN halo_heard TEXT`);
    }
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_halo_episode
        ON work_items (halo_episode_id)
    `);
  });
}
