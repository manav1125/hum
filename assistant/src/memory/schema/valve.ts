import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The volume valve — what INTERRUPTS, as distinct from what is KEPT.
 *
 * The relevance gate (`arrivals/arrival-gate.ts`) already answers "is this
 * mail worth keeping as work at all". Measured on the owner's production
 * instance that gate turns ~307 raw watcher events a day into ~93 surfaced
 * arrivals and ~67 work items — and the standing queue is 131. A hundred-odd
 * items is not a lane, it is a wall, and no HQ layout survives it.
 *
 * The valve is a SECOND question asked of work that already exists, not a
 * second answer to the gate's question. It never re-judges content: it reads
 * the gate's own verdict off the `arrivals` row and combines it with facts
 * about the work item (is Cue blocked on you, is it due, has it been shown
 * already) and with what the owner has taught it. Nothing here calls a model.
 *
 * ## band × stop
 *
 * Two independent axes, and keeping them independent is the whole design:
 *
 *   · **band** — a property of the ITEM. How loudly it asks for the owner.
 *     `urgent` > `needs_you` > `everything`. Stamped once, durable, with the
 *     rule that decided it.
 *   · **stop** — a property of the OWNER's current preference. Where they set
 *     the valve: `everything`, `needs_you` (default), `only_urgent`.
 *
 * An item interrupts iff its band is at or above the stop. Changing the stop
 * is therefore a pure comparison over rows that already exist — instant, and
 * incapable of losing anything, because nothing was ever removed to make it
 * quiet. A demoted item is still in Work, still queryable, still counted.
 *
 * ## Fail open, structurally
 *
 * The absence of a `valve_bands` row means `urgent`. Every item that predates
 * the valve, every item whose banding threw, every item written by a code path
 * that has never heard of this table — all of them show at every stop. Being
 * unbanded is the loudest state, not the quietest, so no outage, timeout,
 * disabled feature or unmigrated row can make a work item quiet. The only
 * things that can lower an item are positive evidence: a structural fact about
 * the sender's address, or the owner themselves saying "not relevant".
 */

/** How loudly one work item asks for the owner. Stamped once, durable. */
export const valveBands = sqliteTable(
  "valve_bands",
  {
    /** Reference-by-convention to work_items.id (no FK — see `arrivals`). */
    workItemId: text("work_item_id").primaryKey(),
    /**
     * 'urgent' | 'needs_you' | 'everything'. A monotone ladder compared
     * against the stop. NOT a score: a number would invite threshold
     * tuning against a distribution nobody has measured, and would make
     * "why is this here" unanswerable.
     */
    band: text("band").notNull(),
    /**
     * Which rule decided, e.g. 'awaiting_you', 'automated_sender',
     * 'gate_unsure'. The single most important column in this table: the
     * previous safety floor in this codebase ran for weeks with three of its
     * four conditions never firing once, and nobody noticed because the
     * fourth over-fired. A rule id per decision makes that distribution a
     * query rather than an assumption.
     */
    ruleId: text("rule_id").notNull(),
    /** Why, in the owner's words. Never a code, never a score. */
    reason: text("reason").notNull(),
    /**
     * 'rule' (a deterministic fact), 'learned' (the owner taught it), or
     * 'fallback' (the valve could not decide and defaulted to urgent).
     * A `fallback` row is a bug report waiting to be read; it must never be
     * confused with a rule that deliberately chose `urgent`.
     */
    bandedBy: text("banded_by").notNull(),
    /** The arrival whose gate verdict was read, when there was one. */
    arrivalId: text("arrival_id"),
    /** Lowercased sender address — the learning key. Null off-mail. */
    senderKey: text("sender_key"),
    /** The mission this item belongs to, for the per-mission override. */
    missionId: text("mission_id"),
    /**
     * Epoch ms this item first interrupted the owner. Set by the HQ read the
     * first time the item passes the valve, and it is what lets already-seen
     * work rest: shown once, then it stops competing with new arrivals. Null
     * = never shown, which is emphatically not the same as "shown and
     * ignored" and must never be collapsed into it.
     */
    surfacedAt: integer("surfaced_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // The observability read: "how often did each rule fire, in this window".
    index("idx_valve_bands_rule").on(table.ruleId, table.createdAt),
    // The HQ read: everything at or above a band, newest first.
    index("idx_valve_bands_band").on(table.band, table.createdAt),
    index("idx_valve_bands_sender").on(table.senderKey),
    index("idx_valve_bands_mission").on(table.missionId),
  ],
);

/**
 * Where the valve is set. One global row plus one row per mission override.
 *
 * A table rather than a config key because a per-mission override is data the
 * owner creates and deletes at runtime ("bump this mission to Everything while
 * it's live"), and config files are not where runtime state belongs. The
 * global row is a row for the same reason its overrides are: one read path,
 * one write path, one audit trail.
 */
export const valveStops = sqliteTable("valve_stops", {
  /** 'global', or 'mission:<missionId>'. */
  scope: text("scope").primaryKey(),
  /** 'everything' | 'needs_you' | 'only_urgent'. */
  stop: text("stop").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

/**
 * What the owner has taught the valve.
 *
 * `arrivals.reversed_at` already records one direction — "you filed this and
 * you were wrong, it mattered". This records the other: "you surfaced this and
 * you were wrong, it did not". Both are corrections, and they are stored apart
 * because they are corrections to different decisions; folding a dismissal
 * into the arrivals row would overwrite the gate's verdict with a judgement
 * about interruption, and the gate's verdict is what the valve reads.
 *
 * Counts, not a score. `dismissed` and `kept` are both retained so a sender
 * the owner dismissed twice and then acted on once cannot be quietly written
 * off — the evidence that they were wrong about it is still in the row.
 */
export const valveFeedback = sqliteTable(
  "valve_feedback",
  {
    /** 'sender' | 'channel' | 'rule'. */
    subjectKind: text("subject_kind").notNull(),
    /** The lowercased address, channel key, or rule id. */
    subjectKey: text("subject_key").notNull(),
    /** Times the owner said "not relevant" / dismissed with ✕. */
    dismissed: integer("dismissed").notNull().default(0),
    /** Times the owner acted on, promoted, or un-dismissed one of these. */
    kept: integer("kept").notNull().default(0),
    lastSignalAt: integer("last_signal_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectKind, table.subjectKey] }),
    index("idx_valve_feedback_dismissed").on(table.dismissed),
  ],
);
