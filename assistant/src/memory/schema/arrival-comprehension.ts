import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Comprehension — what Cue understood a surfaced arrival to actually be.
 *
 * The relevance gate answers "should the owner see this". It does not answer
 * "what is this, and what do I have to do about it", which is why every Gmail
 * work item was still titled `Email from <Name> <addr>: <subject>` — a
 * relabelled email, not a task.
 *
 * One row per work item, and it exists whether or not comprehension SUCCEEDED.
 * That is the point: a failure has to be legible. `status` distinguishes
 *
 *   · `comprehended`   — the title was rewritten to a verb phrase; the item's
 *                        `title` now says what the owner must do.
 *   · `low_confidence` — the model answered, but not well enough to be trusted
 *                        with the owner's task list. The ORIGINAL title stands
 *                        and `note` says why.
 *   · `failed`         — no usable answer at all (timeout, parse failure, the
 *                        model skipped the item). Original title stands.
 *   · `skipped`        — comprehension was off, or the arrival is not a
 *                        message shape this extractor understands.
 *
 * `original_title` is kept verbatim so a rewrite is always reversible by
 * reading, and the raw message is still reachable through the work item's
 * `source_context` and its `arrivals` row. Nothing here replaces the record of
 * what actually arrived.
 *
 * The extracted facts (`due_at`, `amount_text`, `asked_by`) are stored ONLY
 * when they were genuinely present in the message — see
 * `arrivals/arrival-comprehension.ts`, where every one of them must be quoted
 * back and that quote must be found in the source text before it is accepted.
 * A hallucinated due date on a real obligation is worse than no due date, so
 * "absent" is represented by NULL and never by a guess.
 */
export const workItemComprehension = sqliteTable(
  "work_item_comprehension",
  {
    /** The work item this describes. One row per item. */
    workItemId: text("work_item_id").primaryKey(),
    /** The arrival it was surfaced from, for provenance. */
    arrivalId: text("arrival_id"),
    /** 'comprehended' | 'low_confidence' | 'failed' | 'skipped'. */
    status: text("status").notNull(),
    /** The title the item had BEFORE comprehension, verbatim. */
    originalTitle: text("original_title").notNull(),
    /** The verb-phrase title, when one was accepted. Null otherwise. */
    actionTitle: text("action_title"),
    /**
     * The extracted deadline, epoch ms. NULL when the message carried none —
     * which is the common case and must never be filled in with a default.
     */
    dueAt: integer("due_at"),
    /** The literal words the deadline was read from, for the owner to check. */
    dueQuote: text("due_quote"),
    /** The amount as written ("USD 1,250.00"). Null when none was present. */
    amountText: text("amount_text"),
    /** Who is asking, as written ("CIPA", "HSBC Business Banking"). */
    askedBy: text("asked_by"),
    /** One line naming the decision wanted, when the message asks for one. */
    decisionNeeded: text("decision_needed"),
    /** The extractor's 0–1 confidence. Null when it never answered. */
    confidence: real("confidence"),
    /** Plain-words explanation, set on every non-`comprehended` status. */
    note: text("note"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_work_item_comprehension_status").on(table.status),
    index("idx_work_item_comprehension_arrival").on(table.arrivalId),
  ],
);

/**
 * Group members — the messages folded into one work item.
 *
 * Two replies in one Gmail conversation used to become two unrelated work
 * items, and fifteen ZA Bank notifications became fifteen rows. Grouping folds
 * the later ones into the first item as updates instead of minting new rows.
 *
 * Every message in a group has a row here, INCLUDING the one that created the
 * work item (`is_anchor = 1`). That is what makes a merge visible: "what was
 * combined" is a query, not an inference, and the count the card shows is the
 * number of live rows rather than a number somebody incremented.
 *
 * A merge is never a deletion. Un-grouping does not remove a row — it stamps
 * `detached_at` / `detached_by` and records the work item the message was
 * split back out into (`detached_work_item_id`). The original `arrivals` row
 * was written at intake and is never touched by any of this, so the record of
 * what arrived survives every merge, split and re-merge.
 *
 * `group_key` is `thread:<providerThreadId>` or `sender:<address>` — the two
 * keys that are defensible. Topic similarity across senders is deliberately
 * NOT a key here: a wrongly merged pair of real obligations is a serious
 * failure, and fuzzy matching is where those hide.
 */
export const arrivalGroupMembers = sqliteTable(
  "arrival_group_members",
  {
    id: text("id").primaryKey(),
    /** The work item every message in this group is folded into. */
    workItemId: text("work_item_id").notNull(),
    /** 'thread:<id>' or 'sender:<address>'. Unique per channel. */
    groupKey: text("group_key").notNull(),
    /** 'thread' | 'sender' — which rule combined these. */
    groupKind: text("group_kind").notNull(),
    /** The channel the messages arrived on, e.g. 'watcher:gmail'. */
    channel: text("channel").notNull(),
    /** The `arrivals` row for this message. Provenance, never rewritten. */
    arrivalId: text("arrival_id").notNull(),
    /** The provider's own message id. */
    externalId: text("external_id").notNull(),
    /** What arrived, verbatim — the pre-comprehension title. */
    title: text("title").notNull(),
    snippet: text("snippet"),
    senderAddress: text("sender_address"),
    /** 1 for the message that created the work item; 0 for later updates. */
    isAnchor: integer("is_anchor").notNull(),
    receivedAt: integer("received_at").notNull(),
    /** Epoch ms the owner split this message back out. Null = still grouped. */
    detachedAt: integer("detached_at"),
    detachedBy: text("detached_by"),
    /** The work item the split-out message became. */
    detachedWorkItemId: text("detached_work_item_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_arrival_group_members_item").on(table.workItemId),
    index("idx_arrival_group_members_key").on(table.channel, table.groupKey),
  ],
);
