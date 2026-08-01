import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Arrivals — one row per thing a watcher saw, and what Cue decided to do with
 * it at the arrival → work-item boundary.
 *
 * Cue is sold as a chief of staff that FILTERS. Before this table every Gmail
 * hit became a work item in the Came-in lane, so 101 newsletters, receipts and
 * build notifications all became things the owner had to look at. The filter
 * has to live at arrival, because everything downstream (triage urgency,
 * auto-file confidence) only ranks or files a row that already exists — none
 * of it can stop something from demanding attention.
 *
 * Two dispositions, and only two:
 *
 *   · `surfaced` — Cue looked at it and decided the owner needs to see it. A
 *     work item exists (`work_item_id`), exactly as before.
 *   · `filed` — recorded, browsable, reversible, but NOT in the lane. No work
 *     item is created.
 *
 * The invariant `watcher-intake.ts` has always claimed — nothing a watcher saw
 * is silently dropped — is why this is a table and not a `continue`. "Filed"
 * means recorded-and-findable; it never means deleted. Every filed row carries
 * `reason`, a sentence fragment in the owner's words ("newsletter from
 * Stripe", "automated build notification"), because a filter you cannot
 * interrogate is not trustworthy, it is spooky.
 *
 * Why a sibling table rather than columns on `work_items`: a filed arrival is
 * not work. Modelling it as a work item with a "please ignore me" flag means
 * every existing query — the queue drainer, the auto-file sweep, mission
 * rollups, the dedupe pass, every count — has to remember to exclude it, and
 * the first one that forgets puts the newsletters straight back in front of
 * the owner. Here, exclusion is free and unbreakable: filed arrivals never
 * become rows in `work_items` at all.
 *
 * Deliberately FK-free (the same convention as `work_items.project_id`):
 * deleting a work item must not erase the record of why it was ever kept.
 */
export const arrivals = sqliteTable(
  "arrivals",
  {
    id: text("id").primaryKey(),
    /** The channel it arrived on, e.g. 'watcher:gmail'. */
    channel: text("channel").notNull(),
    /** The provider's own id (a Gmail message id). Unique with `channel`. */
    externalId: text("external_id").notNull(),
    /** The watcher that saw it; reference-by-convention to watchers.id. */
    watcherId: text("watcher_id"),
    /** The originating watcher_events.id, for tracing back to the raw hit. */
    eventId: text("event_id"),
    /** What the owner would read on a card. */
    title: text("title").notNull(),
    /**
     * Lowercased sender address (an email address for mail). This is the
     * learning key: repeated reversals for the SAME sender are the strongest
     * signal a later learning loop can act on, so it is stored separately
     * rather than left buried inside `source_context`.
     */
    senderAddress: text("sender_address"),
    /** The sender's display name as it appeared ("Stripe", "Jane Doe"). */
    senderName: text("sender_name"),
    /** Bounded snippet of the body/summary, for the filed-list preview. */
    snippet: text("snippet"),
    /** The JSON provenance blob a surfaced item carries on its work item. */
    sourceContext: text("source_context"),
    /** 'surfaced' | 'filed'. Exactly one of the two, always set. */
    disposition: text("disposition").notNull(),
    /**
     * Why, in the owner's words — "newsletter from Stripe", "you're a direct
     * recipient and it's from a person". Set for BOTH dispositions: a kept
     * item's reason is what makes "Cue looked at it and decided you need to
     * see it" a claim the owner can check rather than one they must trust.
     */
    reason: text("reason"),
    /**
     * What made the call: 'rule' (a deterministic header rule), 'model' (the
     * flash judge), 'floor' (the safety floor overrode a file decision),
     * 'playbook' (a playbook the owner configured claimed it), 'fallback'
     * (the judge errored, timed out or was skipped — fail OPEN, surface), or
     * 'user' (a reversal). Distinguishing "filed by rule X" from "filed by
     * model" is the difference between a bug report and a prompt tweak.
     */
    decidedBy: text("decided_by").notNull(),
    /** Which deterministic rule fired ('list_mail', 'precedence_bulk', …). */
    ruleId: text("rule_id"),
    /** The judge's 0–1 confidence; null unless `decided_by` = 'model'. */
    confidence: real("confidence"),
    /** The work item this became; null while filed. */
    workItemId: text("work_item_id"),
    /**
     * Epoch ms the owner said "this mattered" and the filing was reversed.
     * Null = never reversed. The row is never rewritten to hide that it was
     * filed once — the correction IS the training signal, and erasing the
     * original decision would erase the signal with it.
     */
    reversedAt: integer("reversed_at"),
    /** Who reversed it ('user' by default). */
    reversedBy: text("reversed_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_arrivals_created_at").on(table.createdAt),
    index("idx_arrivals_disposition_created_at").on(
      table.disposition,
      table.createdAt,
    ),
    index("idx_arrivals_sender").on(table.senderAddress),
  ],
);
