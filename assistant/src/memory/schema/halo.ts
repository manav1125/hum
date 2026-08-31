import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Halo — the day a wearable heard.
 *
 * The shape here is the design's shape (`docs/design/halo/`, the H/V/E/F/G/R/S
 * program), down to the enum values, so nobody has to translate between the
 * frames and the columns. Three of its rules are structural rather than
 * stylistic, and each one is why a table exists:
 *
 * **1 · "Always a little behind the room, never in it."** The lag number is
 * worn on every surface — the card, the Island, the Day. It can only be told
 * the truth by the arrival record, so `halo_segments` keeps `coveredThrough`
 * (when the audio ends) apart from `syncedAt` (when the bytes landed). Lag is
 * the gap between the first of those and now. Deriving it from episodes would
 * make it a fact about understanding, which is a different and later number.
 *
 * **2 · Nothing files without acceptance.** `halo_proposals` is a proposal
 * table in the same sense as `note_extractions`: every row waits, ✕ is
 * recorded because dismissal teaches, and only the accept path writes a
 * `work_items` row. Confidence is a tier — `confident` | `unsure` — and there
 * is deliberately no numeric column, for the same reason notes has none: the
 * moment a percentage exists somebody prints it, and it is a number about the
 * model rather than about the owner's work.
 *
 * **3 · Never guess into a gap.** `halo_gaps` exists because "no rows" cannot
 * distinguish the four absences the frames draw differently: `not_worn`,
 * `off_the_record` (chosen, by a 3s hold on the device), `battery`, and
 * `forgotten` (deleted under the S2 ladder). Collapsing them would turn a
 * deliberate silence and a dead battery into the same shrug.
 *
 * ## What is deliberately absent
 *
 * **No audio path, anywhere.** "Audio discarded at understanding" is printed
 * on the episode header, so there is nowhere in this schema to keep audio even
 * by accident. **No coordinates.** Places are labels the owner chose; Halo has
 * no GPS, so there is no column that could hold one.
 */

/**
 * The arrival record — one row per ~20-second file off the device.
 *
 * Rows here are cheap and numerous, and they are the only place lag can be
 * read honestly. They also carry the live strip's last snippet, which is why
 * `snippet` is stored rather than recomputed: the strip renders before any
 * episode exists.
 */
export const haloSegments = sqliteTable(
  "halo_segments",
  {
    id: text("id").primaryKey(),
    /** The device's own session id (`AT+LIST`'s `YYYYMMDDHHMMSS`). */
    deviceSessionId: text("device_session_id").notNull(),
    /** Position within the device session, so ordering survives out-of-order sync. */
    sequence: integer("sequence").notNull(),
    startedAt: integer("started_at").notNull(),
    /**
     * When this segment's AUDIO ends. The lag every surface prints is
     * `now - max(coveredThrough)`, which is why this is separate from
     * `syncedAt` — a segment that arrives late still only covers the room up
     * to the moment it recorded.
     */
    coveredThrough: integer("covered_through").notNull(),
    /** When the bytes reached Cue. Differs from `coveredThrough` by the lag. */
    syncedAt: integer("synced_at").notNull(),
    transcript: text("transcript"),
    /** Last few words, for the live strip's "…as of 3 min ago". */
    snippet: text("snippet"),
    /** Set once segmentation claims this segment. Null means unassigned. */
    episodeId: text("episode_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_halo_segments_session").on(t.deviceSessionId, t.sequence),
    index("idx_halo_segments_covered").on(t.coveredThrough),
    index("idx_halo_segments_episode").on(t.episodeId),
  ],
);

/**
 * One local date. Holds what the day-close recap needs, and the scope that
 * keeps every derived count honest.
 */
export const haloDays = sqliteTable(
  "halo_days",
  {
    id: text("id").primaryKey(),
    /** `YYYY-MM-DD` in the owner's local time. The natural key. */
    localDate: text("local_date").notNull().unique(),
    /** The serif line Cue wrote about the day. Null until there is one. */
    verdict: text("verdict"),
    verdictWrittenAt: integer("verdict_written_at"),
    firstHeardAt: integer("first_heard_at"),
    lastHeardAt: integer("last_heard_at"),
    /**
     * Seconds of audio actually heard. Every count derived from this day
     * carries it ("based on the 5 hours heard") — a short day is still a day,
     * and the verdict scopes itself rather than scoring anyone.
     */
    heardSeconds: integer("heard_seconds").notNull().default(0),
    /** Wall-clock from first to last capture, gaps included. */
    wornSeconds: integer("worn_seconds").notNull().default(0),
    /** Set by the 9pm ritual. Null means the day is still open. */
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_halo_days_local_date").on(t.localDate)],
);

/** A chapter: a stretch of the day with a start, an end, and something in it. */
export const haloEpisodes = sqliteTable(
  "halo_episodes",
  {
    id: text("id").primaryKey(),
    dayId: text("day_id").notNull(),
    /** 1-based; renders as "CHAPTER 2". */
    chapterIndex: integer("chapter_index").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at").notNull(),
    /** A name the owner chose ("VERVE ☕"). Never a coordinate. */
    placeLabel: text("place_label"),
    title: text("title"),
    summary: text("summary"),
    /** The pull-quote, and who said it — the episode page opens on this. */
    pullQuote: text("pull_quote"),
    pullQuoteSpeaker: text("pull_quote_speaker"),
    pullQuoteAt: integer("pull_quote_at"),
    /** JSON `[{label, value}]` — the Key Takeaways block. */
    keyTakeaways: text("key_takeaways"),
    /** JSON `string[]` of speaker names. */
    participants: text("participants"),
    /** JSON `[{speaker, text, at}]` — "THE WORDS". Never edited, only reassigned. */
    transcript: text("transcript"),
    /** Which summary shape the reader chose: `default` | `meeting` | `lecture` | `client_call`. */
    template: text("template").notNull().default("default"),
    /** The Cue thread this episode opened, if it opened one. */
    conversationId: text("conversation_id"),
    /**
     * `kept` | `forgotten`. Forgetting is a state change, not a delete, so the
     * proposals it made can be recalled and the day can still draw the span as
     * an honest hole rather than silently closing over it.
     */
    state: text("state").notNull().default("kept"),
    /** Why the episode starts here: `silence` | `bookmark` | `calendar` | `place` | `day_edge`. */
    boundaryReason: text("boundary_reason").notNull().default("silence"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_halo_episodes_day").on(t.dayId, t.chapterIndex),
    index("idx_halo_episodes_started").on(t.startedAt),
  ],
);

/**
 * The two things a person can say to Halo with their hand: `bookmark` (a
 * single click, ⚑) and `note` (a double click, ✦).
 *
 * Its own table because the Day makes the bookmark the loudest element on the
 * screen and forbids anything Cue inferred from outranking it. A human signal
 * stored alongside machine output eventually gets sorted alongside it.
 */
export const haloMarks = sqliteTable(
  "halo_marks",
  {
    id: text("id").primaryKey(),
    dayId: text("day_id").notNull(),
    /** Null while the surrounding episode has not been cut yet. */
    episodeId: text("episode_id"),
    /** `bookmark` | `note`. */
    kind: text("kind").notNull().default("bookmark"),
    markedAt: integer("marked_at").notNull(),
    /** What was being said, verbatim — the Day prints these words, not a summary. */
    words: text("words"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_halo_marks_day").on(t.dayId, t.markedAt)],
);

/**
 * An absence, and which of the four kinds it is. Never interchangeable:
 * `not_worn` draws dim with a caption, `off_the_record` draws dashed because
 * it was chosen, `battery` says so, and `forgotten` stays blank permanently.
 */
export const haloGaps = sqliteTable(
  "halo_gaps",
  {
    id: text("id").primaryKey(),
    dayId: text("day_id").notNull(),
    startedAt: integer("started_at").notNull(),
    /** Null while the gap is still open (it is happening now). */
    endedAt: integer("ended_at"),
    /** `not_worn` | `off_the_record` | `battery` | `forgotten`. */
    reason: text("reason").notNull(),
    /** The plain caption the arc prints: "at home until noon", "battery · 6:40". */
    caption: text("caption"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_halo_gaps_day").on(t.dayId, t.startedAt)],
);

/**
 * What Cue thinks should happen — every row a proposal, none of them work.
 *
 * The provenance pill (`◉ heard · 10:31 · Verve`) is denormalised onto this
 * table and onto `work_items` rather than joined from the episode, because it
 * has to survive the episode being forgotten. An audit trail that disappears
 * with its source is not an audit trail.
 */
export const haloProposals = sqliteTable(
  "halo_proposals",
  {
    id: text("id").primaryKey(),
    dayId: text("day_id").notNull(),
    episodeId: text("episode_id"),
    /** Set when the proposal came from a ⚑ the owner marked, not from inference. */
    markId: text("mark_id"),
    title: text("title").notNull(),
    owner: text("owner"),
    /** The accept chip's verb: `file` | `draft` | `schedule` | `note`. */
    verb: text("verb").notNull().default("file"),
    /** What the chip PRINTS before acceptance ("Renew Acme"). */
    destinationLabel: text("destination_label"),
    /** Where it actually goes — `project:<id>`, `mission:<id>`, `notes`. */
    destinationRef: text("destination_ref"),
    /** `confident` | `unsure`. Unsure waits behind the fold. No numbers. */
    confidenceTier: text("confidence_tier").notNull().default("confident"),
    /** `proposed` | `accepted` | `dismissed`. Dismissals are kept — ✕ teaches. */
    state: text("state").notNull().default("proposed"),
    /** The provenance pill, carried whole. */
    heardQuote: text("heard_quote"),
    heardAt: integer("heard_at"),
    heardPlace: text("heard_place"),
    heardSpeaker: text("heard_speaker"),
    /** Set only by the accept path. Its presence is the proof work was created. */
    workItemId: text("work_item_id"),
    decidedAt: integer("decided_at"),
    /** Set when the episode behind it was forgotten and the proposal withdrawn. */
    recalledAt: integer("recalled_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_halo_proposals_day").on(t.dayId, t.state),
    index("idx_halo_proposals_episode").on(t.episodeId),
    index("idx_halo_proposals_queue").on(
      t.state,
      t.confidenceTier,
      t.createdAt,
    ),
  ],
);
