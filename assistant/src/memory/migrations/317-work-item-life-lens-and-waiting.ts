import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_work_item_life_lens_and_waiting_v1";

/**
 * The Life lens and the waiting-on-a-person columns.
 *
 * Migration slot 317 — the next free slot after 316 (autonomy ledger).
 *
 * ## Life lens
 *
 * Personal items ("renew the passport", "book the dentist") are time-directed,
 * not goal-directed: forcing them under a mission turns Cue into a project
 * tool. So work and life are the SAME rows on the same engine, organised on
 * different axes — work groups by why (mission), life groups by when
 * (horizon). Life is a lens, not a level, which is also where the privacy
 * property comes from: one boundary means "hide Life" for a screen-share, or
 * "export work only", is a single predicate rather than a scattered rule.
 *
 *   - work_items.domain TEXT NOT NULL DEFAULT 'work' — 'work' | 'life'. The
 *     NOT NULL default is what backfills every pre-317 row as work: nothing
 *     already in the queue may silently become a personal item, because the
 *     Life boundary is a privacy boundary and a mis-stamped row leaks the
 *     wrong way.
 *   - work_items.horizon TEXT — 'this_week' | 'soon' | 'someday'. Nullable and
 *     meaningful only for life items; work items group by mission and leave it
 *     null.
 *   - idx_work_items_domain — the lens switch and the census both filter on
 *     domain, and 'life' is the rarer value, so the selective side of the
 *     predicate gets an index seek instead of a full scan.
 *
 * ## Waiting on people
 *
 * Waiting has states with different right answers — going cold wants a nudge,
 * already chased wants an escalation, on time wants to be forgotten about —
 * and none of them are derivable from `assignee` alone, which says who owns
 * the item, not who is being waited on.
 *
 *   - work_items.waiting_on TEXT — reference-by-convention to contacts.id (the
 *     same no-FK convention as project_id), naming the person whose reply the
 *     item is blocked on. Null = not waiting on anybody.
 *   - work_items.last_chased_at INTEGER — epoch ms of the last nudge sent
 *     about this item. Null = never chased, which is a real and different
 *     state from "chased a while ago": the first reads "Cue will chase", the
 *     second reads "you already asked — escalate rather than nudge again".
 *   - idx_work_items_waiting_on — "what am I waiting on from Rachel" is a
 *     point lookup per contact card, and the chase sweep walks the non-null
 *     rows only.
 *
 * Both are nullable and unset on every existing row: an item that nobody
 * marked as waiting reads exactly as it did before.
 *
 * Idempotent: every ALTER is column-guarded, the indexes are IF NOT EXISTS,
 * and the domain backfill only writes rows where the value is missing.
 */
export function migrateWorkItemLifeLensAndWaiting(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    // SQLite allows ADD COLUMN ... NOT NULL DEFAULT with a constant default,
    // and stamps the default onto every existing row as it rewrites the
    // header — which is precisely the "nothing silently becomes a life item"
    // guarantee.
    const columns: Array<[string, string]> = [
      ["domain", "TEXT NOT NULL DEFAULT 'work'"],
      ["horizon", "TEXT"],
      ["waiting_on", "TEXT"],
      ["last_chased_at", "INTEGER"],
    ];
    for (const [name, type] of columns) {
      if (!tableHasColumn(database, "work_items", name)) {
        raw.exec(/*sql*/ `ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
      }
    }

    // Belt for the re-run case: if an interrupted earlier attempt (or a
    // hand-patched database) left the column present but nullable, the ADD
    // above is skipped and the default never fires. An unstamped row must
    // still read as work.
    raw.exec(/*sql*/ `
      UPDATE work_items SET domain = 'work'
      WHERE domain IS NULL OR domain = ''
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_domain
      ON work_items (domain)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_work_items_waiting_on
      ON work_items (waiting_on)
    `);
  });
}
