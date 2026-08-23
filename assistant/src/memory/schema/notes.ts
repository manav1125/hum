import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Notes — the capture surface for a filing system that already exists.
 *
 * Cue already has HQ, projects, People and Memory, so a note's job is to
 * BECOME work rather than to become a second knowledge base. That single
 * sentence is why there are no collections here, no tags, no graph: a notes
 * app that needs organising is a notes app that failed.
 *
 * Two tables, and the split between them is the feature's central rule.
 *
 *   · `notes` — what the owner wrote, said, selected or forwarded. Theirs.
 *   · `note_extractions` — what Cue THINKS is in it: a task, a memory, a
 *     trait about a person. Proposals, every one of them.
 *
 * ## Why extractions are a table and not a write
 *
 * **Extraction never writes without acceptance** — not once, not for high
 * confidence, not on a timer. Everything else in the feature rests on this,
 * and a rule that lives only in review comments is a rule that ships broken
 * on the fourth refactor. So the proposal is a ROW, and the accept route is
 * the only code in the system that turns one into a `work_items` row or a
 * memory page. The extraction pipeline holds no writer at all; there is a
 * guard test asserting it imports none.
 *
 * The visible consequence is `Waiting on you · 3` — if acceptance is
 * required, unreviewed proposals have to be countable somewhere or they rot
 * silently. They are countable because they are rows.
 *
 * ## Confidence is a tier, never a number
 *
 * `confidence_tier` is `confident` | `unsure` and there is deliberately no
 * numeric column to render. A confident proposal draws as a solid card with a
 * pre-ticked box; an unsure one draws dashed and hollow, carries `reason` in
 * plain words, and needs an explicit Add. "82% sure" is a number about the
 * model, not about the owner's work, and the moment the column exists someone
 * will print it.
 *
 * ## Provenance is one-way, and stated
 *
 * `work_items.note_id` points from the work back to the note it came from —
 * never the reverse. **Deleting a note never deletes work.** No foreign key
 * (the same reference-by-convention rule as `work_items.project_id` and
 * `arrivals`): a deleted note leaves the id in place and the task renders
 * "from a note you deleted", because a task that quietly loses its origin is
 * worse than one that admits it. Notes must not become load-bearing
 * infrastructure by accident.
 *
 * ## Filing is optional forever
 *
 * `project_id` is nullable and stays nullable. "Unfiled" is a resting state,
 * not a backlog to shame — the walking-to-work thought is the highest-value
 * note in the system and it will never have a project.
 */
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    /** First line, or an AI-written title for a recording. Editable. */
    title: text("title").notNull(),
    /** The note itself, as the owner left it. Cue never edits it unless asked. */
    body: text("body").notNull().default(""),
    /**
     * How it got here: `typed` | `voice` | `selection` | `arrival` | `import`.
     * Drives the card's provenance line, and nothing else — an arrival obeys
     * acceptance exactly like something typed by hand.
     */
    source: text("source").notNull().default("typed"),
    /**
     * Free-form detail for `source`: the app a selection came from, the
     * channel an arrival used (`halo`, `email`, `meeting`), the tool an import
     * came out of (`apple-notes`, `obsidian`).
     */
    sourceDetail: text("source_detail"),
    /** Nullable reference-by-convention to `projects.id`. Null is legitimate, forever. */
    projectId: text("project_id"),
    /**
     * Local path to the recording. **Audio is local**; nothing uploads it, and
     * "delete audio, keep note" clears this column while leaving the note
     * whole — which is the escape people need before they will record at all.
     */
    audioPath: text("audio_path"),
    audioDurationMs: integer("audio_duration_ms"),
    /**
     * The words that were actually said — quotes, not Cue's prose. Kept apart
     * from `body` so a summary can never be laundered as a transcript.
     */
    transcript: text("transcript"),
    /**
     * 1 when `body` is Cue's summary rather than the owner's words. Any
     * AI-written prose in a note says so and is checkable against its source;
     * this column is what the label reads.
     */
    bodyIsSummary: integer("body_is_summary").notNull().default(0),
    /**
     * Where extraction stands for this note. Four states, because two of them
     * mean very different things to a person:
     *
     *   · `idle`   — never read (a brand-new note, or one nobody asked about)
     *   · `reading`— a read is in flight
     *   · `done`   — read completed. Zero proposals means "nothing to file
     *                here — this reads like thinking, not commitments", which
     *                is the COMMON case and must not read as failure.
     *   · `failed` — the request failed. "I couldn't read this one just now —
     *                your note is saved."
     *
     * `done`-with-nothing and `failed` are separate states by rule: one is
     * about the note, the other about the request. Collapsing them into one
     * branch is how the reassurance that matters — the writing survived —
     * goes missing.
     */
    extractionState: text("extraction_state").notNull().default("idle"),
    /**
     * Hash of the body at the last read. Reading is on close or on demand and
     * **never re-reads unchanged text** — a note reopened and closed without
     * an edit costs nothing. (This supersedes the original ~2s idle trigger,
     * which was a model call every couple of seconds on unfinished writing.)
     */
    lastReadHash: text("last_read_hash"),
    lastReadAt: integer("last_read_at"),
    /**
     * When the thought happened, which is not always when the row was made:
     * a Halo capture, a forwarded mail or an import all carry their own time.
     * The list sorts on this.
     */
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_notes_occurred_at").on(table.occurredAt),
    index("idx_notes_project").on(table.projectId),
    index("idx_notes_extraction_state").on(table.extractionState),
  ],
);

/**
 * One proposal Cue found in a note. Never a write — see the table comment
 * above.
 *
 * `payload` is the kind-shaped JSON the accept route needs to do the write:
 * a task's title/due/project, a memory's fact and slug, a person trait's
 * contact and claim. It is deliberately opaque here so adding a kind does not
 * mean a migration.
 */
export const noteExtractions = sqliteTable(
  "note_extractions",
  {
    id: text("id").primaryKey(),
    /** Reference-by-convention to `notes.id`. */
    noteId: text("note_id").notNull(),
    /** `task` | `memory` | `person_trait`. */
    kind: text("kind").notNull(),
    /** Kind-shaped JSON for the accept route. */
    payload: text("payload").notNull(),
    /** `confident` | `unsure`. A tier, never a percentage — see the table comment. */
    confidenceTier: text("confidence_tier").notNull().default("confident"),
    /**
     * Why Cue is unsure, in the owner's own vocabulary ("you wrote 'maybe'").
     * Required for the `unsure` tier and unused by `confident`, which earns
     * its pre-ticked box by not needing to explain itself.
     */
    reason: text("reason"),
    /** `proposed` | `accepted` | `dismissed`. The only column acceptance turns. */
    state: text("state").notNull().default("proposed"),
    /**
     * Set when this proposal disagrees with something Cue already believes:
     * JSON `{ existing, existingSource, existingAt, incoming, incomingSource,
     * incomingAt }`. Neither value is ever rendered without where it came
     * from.
     *
     * This is the only place accepting can DESTROY rather than add, which is
     * why it is modelled before voice ever ships.
     */
    conflict: text("conflict"),
    /**
     * `replace` | `keep_both` | `ignore` — three answers, never two. A
     * two-button version forces a false choice between the old truth and the
     * new one; prices and dates legitimately change, so `keep_both` (keep the
     * history, use the newer) is the default the UI pre-selects.
     */
    conflictResolution: text("conflict_resolution"),
    /** What acceptance created: `work_item` | `memory_page` | `contact`. */
    acceptedRefType: text("accepted_ref_type"),
    acceptedRefId: text("accepted_ref_id"),
    createdAt: integer("created_at").notNull(),
    /**
     * When the owner decided. With `kind`, `confidence_tier` and `state` this
     * is accept-rate-per-type — the number that says whether this feature
     * works, and the reason all four columns exist from day one rather than
     * being retrofitted after a week of not knowing.
     */
    decidedAt: integer("decided_at"),
  },
  (table) => [
    index("idx_note_extractions_note").on(table.noteId),
    index("idx_note_extractions_state").on(table.state, table.createdAt),
    index("idx_note_extractions_kind_state").on(table.kind, table.state),
  ],
);
