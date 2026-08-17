import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Ritual snapshots — what the Morning Brief and the Weekly review actually
 * said, on the day they said it.
 *
 * ## Why this table has to exist
 *
 * `GET /brief/morning` composes today's brief from a sliding lookback over
 * the live stores. It takes no date, and the weekly is the same shape over
 * seven days. So "open Tuesday's brief" could only ever recompute TODAY's
 * numbers under a Tuesday heading — a fabricated artefact wearing a date,
 * which is why the archive shipped with two real rows and a line stating the
 * absence rather than a plausible list.
 *
 * Design's ruling: *"a ritual you can't re-read isn't a ritual, it's a
 * notification"*. Three things ride on this one table, which is what makes it
 * worth the schema:
 *
 *   1. **The archive** — real dated rows, each one the figures as composed.
 *   2. **Read-state** — see `ritualSnapshotReads` below. Read-state rides on
 *      the snapshot; it is emphatically NOT a separate read-receipt store.
 *   3. **The Weekly's "two slipped"** — a claim only becomes a comparison
 *      when last week's row exists to compare against.
 *
 * ## Nothing before today
 *
 * There is no backfill and there must never be one. A snapshot store starts
 * the day it is written; "nothing before today" is the honest first state of
 * any log. The numbers for last Tuesday cannot be reconstructed — the stores
 * they were computed from have moved on — so any row dated before this table
 * existed would be an invention. The archive says so in words instead, and
 * that line stops being true on its own after a week.
 *
 * ## One row per ritual per period, written at compose
 *
 * `(ritual, period_key)` is unique and the write is INSERT-OR-IGNORE: the
 * FIRST compose of a period wins. That is the brief that went out — the one
 * the push was composed from and the one the owner was told about. A re-read
 * at 11pm must not rewrite what the morning said.
 *
 * `facts` is JSON rather than columns because the two rituals count different
 * things (done/review/needsYou vs moved/slipped) and a wide table with half
 * its columns null per row makes every reader guess which half is real. The
 * `headline` beside it is the sentence composed FROM those figures — stored,
 * not recomputed, because a sentence re-derived from today's stores is the
 * exact bug this table exists to prevent.
 *
 * FK-free by the same convention as `arrivals` and `valve_bands`: nothing in
 * here references a row that may be deleted, and a snapshot must outlive the
 * work items it counted.
 */
export const ritualSnapshots = sqliteTable(
  "ritual_snapshots",
  {
    id: text("id").primaryKey(),
    /** 'brief' | 'weekly'. */
    ritual: text("ritual").notNull(),
    /**
     * The period the snapshot IS, in the daemon's local calendar:
     * `2026-08-17` for a brief, `2026-W33` for a weekly. This is the archive's
     * heading, and the uniqueness key that makes the write idempotent.
     */
    periodKey: text("period_key").notNull(),
    /** Epoch ms bounds of the period the figures cover. */
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    /** Epoch ms the ritual was composed — when, not what. */
    composedAt: integer("composed_at").notNull(),
    /**
     * The serif line, composed from the figures at compose time. Design's
     * rule: a serif sentence is not licence to be vague — if the figures
     * cannot be computed nothing is written at all, so a stored headline is
     * always backed by the `facts` beside it.
     */
    headline: text("headline").notNull(),
    /** JSON object of the ritual's own figures. Never free text. */
    facts: text("facts").notNull(),
  },
  (table) => [
    uniqueIndex("idx_ritual_snapshots_period").on(
      table.ritual,
      table.periodKey,
    ),
    // The archive read: newest first, all rituals interleaved.
    index("idx_ritual_snapshots_composed").on(table.composedAt),
    // The comparison read: "the weekly before this one".
    index("idx_ritual_snapshots_ritual_composed").on(
      table.ritual,
      table.composedAt,
    ),
  ],
);

/**
 * Which device has read which snapshot.
 *
 * Design ruled (R4) that read/dismissed are **device-local** — *"reading is
 * an act of attention rather than a property of the account"* — and then
 * ruled (N1) that when the snapshot store lands, read-state rides on it and
 * no separate read-receipt endpoint gets built. Both hold at once only if the
 * read row is keyed by device as well as by snapshot, which is what this is.
 * Collapsing it to a `read_at` column on `ritual_snapshots` would silently
 * convert a phone tap into an account-wide fact and overturn R4 by schema.
 *
 * Reference-by-convention to `ritual_snapshots.id` with no foreign key, per
 * the codebase convention. Snapshots are append-only and never deleted today;
 * a future retention prune must delete the reads alongside the snapshot in
 * the store, since there is no cascade to do it.
 */
export const ritualSnapshotReads = sqliteTable(
  "ritual_snapshot_reads",
  {
    snapshotId: text("snapshot_id").notNull(),
    /**
     * The device that read it. Opaque, client-minted, and never a user id —
     * the whole point is that a Mac and a phone disagree honestly.
     */
    deviceId: text("device_id").notNull(),
    readAt: integer("read_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.deviceId] }),
    index("idx_ritual_snapshot_reads_device").on(table.deviceId),
  ],
);
