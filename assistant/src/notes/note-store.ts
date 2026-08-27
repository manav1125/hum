/**
 * Store for `notes` and `note_extractions` — capture, and the proposals Cue
 * found inside it.
 *
 * **This module writes nothing outside those two tables**, and that is a
 * deliberate structural property rather than a coincidence of what has been
 * needed so far. Turning a proposal into a task or a memory is the accept
 * route's job (`note-accept.ts`), which is the only module in the feature
 * that imports a work-item or memory writer. A guard test asserts the
 * separation, because "extraction never writes without acceptance" is the
 * rule the whole feature's credibility rests on and a rule enforced only by
 * reviewers survives about four refactors.
 *
 * See `memory/schema/notes.ts` for the shape and the reasoning behind it.
 */

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { noteExtractions, notes } from "../memory/schema.js";

/** How a note got here. Drives the card's provenance line and nothing else. */
export type NoteSource = "typed" | "voice" | "selection" | "arrival" | "import";

/**
 * Where extraction stands. `done` with zero proposals means "nothing to file
 * here" — the common case, and not a failure; `failed` means the request
 * failed and the note is still saved. The two are never the same state.
 */
export type NoteExtractionState = "idle" | "reading" | "done" | "failed";

/** What Cue thinks it found. */
export type NoteExtractionKind = "task" | "memory" | "person_trait";

/** A tier, never a percentage — see `memory/schema/notes.ts`. */
export type NoteConfidenceTier = "confident" | "unsure";

export type NoteExtractionDecision = "proposed" | "accepted" | "dismissed";

/** Three answers, never two. `keep_both` is the default the UI pre-selects. */
export type NoteConflictResolution = "replace" | "keep_both" | "ignore";

export type NoteAcceptedRefType = "work_item" | "memory_page" | "contact";

export interface Note {
  id: string;
  title: string;
  body: string;
  source: NoteSource;
  sourceDetail: string | null;
  projectId: string | null;
  audioPath: string | null;
  audioDurationMs: number | null;
  transcript: string | null;
  /** True when `body` is Cue's summary rather than the owner's words. */
  bodyIsSummary: boolean;
  extractionState: NoteExtractionState;
  lastReadHash: string | null;
  lastReadAt: number | null;
  /** When the thought happened, which is not always when the row was made. */
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
  /**
   * What this note turned into. Present on list rows; see {@link NoteProduced}.
   */
  produced?: NoteProduced;
}

/**
 * What a note produced, per note.
 *
 * N1's card "states what it produced" — `✓ 3 tasks · 2 memories · 1 waiting`
 * — and that is the same argument the header count makes ("62 notes ·
 * they've produced 78 tasks and 31 memories"), at the scale where someone
 * actually decides whether to open a note. A card without it is a filename.
 *
 * `waiting` is the count of proposals still undecided, which is the visible
 * consequence of the rule that nothing files without acceptance. It is
 * counted separately from the accepted kinds rather than lumped in: "3 tasks"
 * and "1 still to look at" mean different things to whoever is scanning.
 */
export interface NoteProduced {
  tasks: number;
  memories: number;
  traits: number;
  waiting: number;
}

/**
 * What Cue already believed, set against what this note says. Neither value
 * is ever rendered without where it came from.
 */
export interface NoteConflict {
  existing: string;
  existingSource: string;
  existingAt: number | null;
  incoming: string;
  incomingSource: string;
  incomingAt: number | null;
}

export interface NoteExtraction {
  id: string;
  noteId: string;
  kind: NoteExtractionKind;
  payload: Record<string, unknown>;
  confidenceTier: NoteConfidenceTier;
  /** Why Cue is unsure, in plain words. Set for `unsure`, null for `confident`. */
  reason: string | null;
  state: NoteExtractionDecision;
  conflict: NoteConflict | null;
  conflictResolution: NoteConflictResolution | null;
  acceptedRefType: NoteAcceptedRefType | null;
  acceptedRefId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** Longest title we derive from a body's first line before clipping. */
const TITLE_CHARS = 120;

/**
 * Derive a title from the first non-empty line. A note the owner never titled
 * still needs something on its card, and the first line is what they would
 * have picked anyway.
 */
export function deriveNoteTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Untitled note";
  return firstLine.length > TITLE_CHARS
    ? `${firstLine.slice(0, TITLE_CHARS)}…`
    : firstLine;
}

type NoteRow = typeof notes.$inferSelect;
type ExtractionRow = typeof noteExtractions.$inferSelect;

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source as NoteSource,
    sourceDetail: row.sourceDetail,
    projectId: row.projectId,
    audioPath: row.audioPath,
    audioDurationMs: row.audioDurationMs,
    transcript: row.transcript,
    bodyIsSummary: row.bodyIsSummary === 1,
    extractionState: row.extractionState as NoteExtractionState,
    lastReadHash: row.lastReadHash,
    lastReadAt: row.lastReadAt,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Parse a JSON column that a person never typed but a future migration might
 * mangle. A malformed payload degrades to an empty object rather than
 * throwing: one bad row must not take down the rail for the whole note.
 */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toExtraction(row: ExtractionRow): NoteExtraction {
  return {
    id: row.id,
    noteId: row.noteId,
    kind: row.kind as NoteExtractionKind,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    confidenceTier: row.confidenceTier as NoteConfidenceTier,
    reason: row.reason,
    state: row.state as NoteExtractionDecision,
    conflict: parseJson<NoteConflict | null>(row.conflict, null),
    conflictResolution: row.conflictResolution as NoteConflictResolution | null,
    acceptedRefType: row.acceptedRefType as NoteAcceptedRefType | null,
    acceptedRefId: row.acceptedRefId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

// -- Notes -------------------------------------------------------------------

export interface CreateNoteInput {
  /**
   * A client-minted id.
   *
   * Capture must work with no signal, so a note gets its id on the device
   * that wrote it and keeps that id forever. That makes the write
   * **idempotent**: a queued note pushed twice — the retry after a dropped
   * connection, the second tab, the app relaunching mid-sync — resolves to
   * the one row rather than a duplicate. Omit it and the daemon mints one,
   * which is what a straightforward online create does.
   */
  id?: string;
  body: string;
  /** Omit to derive from the first line of `body`. */
  title?: string;
  source?: NoteSource;
  sourceDetail?: string | null;
  projectId?: string | null;
  audioPath?: string | null;
  audioDurationMs?: number | null;
  transcript?: string | null;
  bodyIsSummary?: boolean;
  /**
   * When the thought happened. Defaults to now — but a Halo capture, a
   * forwarded mail and an import all know their own time and should pass it.
   */
  occurredAt?: number;
}

/**
 * Write a note. Nothing here reads it, proposes anything, or files it
 * anywhere: **capture never asks where it goes**, and a note exists the
 * instant the owner stops writing. Extraction happens on close or on demand,
 * later and separately.
 */
export function createNote(input: CreateNoteInput): Note {
  // Idempotent on a client-minted id: the same note pushed twice is the same
  // note. The existing row wins outright rather than being overwritten — a
  // replayed create must never clobber an edit the owner made in between.
  if (input.id) {
    const existing = getNote(input.id);
    if (existing) return existing;
  }

  const db = getDb();
  const now = Date.now();
  const row: NoteRow = {
    id: input.id ?? crypto.randomUUID(),
    title: input.title?.trim() || deriveNoteTitle(input.body),
    body: input.body,
    source: input.source ?? "typed",
    sourceDetail: input.sourceDetail ?? null,
    projectId: input.projectId ?? null,
    audioPath: input.audioPath ?? null,
    audioDurationMs: input.audioDurationMs ?? null,
    transcript: input.transcript ?? null,
    bodyIsSummary: input.bodyIsSummary ? 1 : 0,
    extractionState: "idle",
    lastReadHash: null,
    lastReadAt: null,
    occurredAt: input.occurredAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(notes).values(row).run();
  return toNote(row);
}

export function getNote(id: string): Note | null {
  const db = getDb();
  const row = db.select().from(notes).where(eq(notes.id, id)).get();
  return row ? toNote(row) : null;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  /** Pass `null` to unfile. Unfiled is a resting state, not a failure. */
  projectId?: string | null;
  audioPath?: string | null;
  /** How long the recording ran. The list renders it as "12:41 kept". */
  audioDurationMs?: number | null;
  transcript?: string | null;
  bodyIsSummary?: boolean;
  extractionState?: NoteExtractionState;
  lastReadHash?: string | null;
  lastReadAt?: number | null;
}

export function updateNote(id: string, patch: UpdateNoteInput): Note | null {
  const existing = getNote(id);
  if (!existing) return null;

  const values: Partial<NoteRow> = { updatedAt: Date.now() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.body !== undefined) {
    values.body = patch.body;
    // A note whose title was only ever the first line follows the first line.
    // One the owner actually named keeps their name.
    if (
      patch.title === undefined &&
      existing.title === deriveNoteTitle(existing.body)
    ) {
      values.title = deriveNoteTitle(patch.body);
    }
  }
  if (patch.projectId !== undefined) values.projectId = patch.projectId;
  if (patch.audioPath !== undefined) values.audioPath = patch.audioPath;
  if (patch.audioDurationMs !== undefined) {
    values.audioDurationMs = patch.audioDurationMs;
  }
  if (patch.transcript !== undefined) values.transcript = patch.transcript;
  if (patch.bodyIsSummary !== undefined) {
    values.bodyIsSummary = patch.bodyIsSummary ? 1 : 0;
  }
  if (patch.extractionState !== undefined) {
    values.extractionState = patch.extractionState;
  }
  if (patch.lastReadHash !== undefined)
    values.lastReadHash = patch.lastReadHash;
  if (patch.lastReadAt !== undefined) values.lastReadAt = patch.lastReadAt;

  const db = getDb();
  db.update(notes).set(values).where(eq(notes.id, id)).run();
  return getNote(id);
}

/**
 * Delete a note and its proposals.
 *
 * **Work made from this note is untouched, by design.** Provenance is
 * one-way: the task remembers the note, never the reverse, so `work_items`
 * keeps its `note_id` and renders "from a note you deleted". Cascading here
 * would make notes load-bearing infrastructure by accident — someone tidying
 * their notes would silently empty their HQ.
 */
export function deleteNote(id: string): boolean {
  const existing = getNote(id);
  if (!existing) return false;
  const db = getDb();
  db.delete(noteExtractions).where(eq(noteExtractions.noteId, id)).run();
  db.delete(notes).where(eq(notes.id, id)).run();
  return true;
}

/**
 * The list's filters, which are the four the destination offers:
 *
 *   · `all` — everything
 *   · `waiting` — notes with proposals nobody has looked at. The honest
 *     consequence of requiring acceptance: unreviewed proposals must be
 *     visible somewhere or they rot silently.
 *   · `unfiled` — no project. A resting state, never a backlog to shame.
 *   · `recorded` — has audio.
 */
export type NoteFilter = "all" | "waiting" | "unfiled" | "recorded";

export const MAX_NOTE_PAGE = 200;

export interface ListNotesOptions {
  filter?: NoteFilter;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export function listNotes(options: ListNotesOptions = {}): Note[] {
  const db = getDb();
  const limit = Math.min(options.limit ?? 50, MAX_NOTE_PAGE);
  const conditions = [];

  if (options.projectId)
    conditions.push(eq(notes.projectId, options.projectId));
  if (options.filter === "unfiled") conditions.push(isNull(notes.projectId));
  if (options.filter === "recorded") {
    conditions.push(sql`${notes.audioPath} IS NOT NULL`);
  }
  if (options.filter === "waiting") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM note_extractions e
                  WHERE e.note_id = ${notes.id} AND e.state = 'proposed')`,
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(notes)
    .where(where)
    .orderBy(desc(notes.occurredAt))
    .limit(limit)
    .offset(options.offset ?? 0)
    .all();

  return attachProduced(rows.map(toNote));
}

/**
 * Fill in {@link NoteProduced} for a page of notes.
 *
 * One grouped query for the whole page rather than a subquery per row: the
 * list is the surface someone opens first and most often, and a per-card
 * count that costs a query per card is how a list gets slow exactly as it
 * starts being worth having. Notes with nothing yet get explicit zeros, so
 * the card can tell "nothing found in this one" from "not read yet" without
 * a second call.
 */
function attachProduced(page: Note[]): Note[] {
  if (page.length === 0) return page;
  const db = getDb();
  const ids = page.map((n) => n.id);

  const counts = db
    .select({
      noteId: noteExtractions.noteId,
      kind: noteExtractions.kind,
      state: noteExtractions.state,
      n: sql<number>`COUNT(*)`,
    })
    .from(noteExtractions)
    .where(inArray(noteExtractions.noteId, ids))
    .groupBy(
      noteExtractions.noteId,
      noteExtractions.kind,
      noteExtractions.state,
    )
    .all();

  const byNote = new Map<string, NoteProduced>();
  for (const id of ids) {
    byNote.set(id, { tasks: 0, memories: 0, traits: 0, waiting: 0 });
  }
  for (const row of counts) {
    const acc = byNote.get(row.noteId);
    if (!acc) continue;
    const n = Number(row.n);
    // Undecided proposals are the visible cost of the acceptance rule, so
    // they are counted whatever kind they are.
    if (row.state === "proposed") {
      acc.waiting += n;
      continue;
    }
    if (row.state !== "accepted") continue;
    if (row.kind === "task") acc.tasks += n;
    else if (row.kind === "memory") acc.memories += n;
    else if (row.kind === "person_trait") acc.traits += n;
  }

  return page.map((note) => ({
    ...note,
    produced: byNote.get(note.id) ?? {
      tasks: 0,
      memories: 0,
      traits: 0,
      waiting: 0,
    },
  }));
}

/**
 * The header line — "62 notes · they've produced 78 tasks and 31 memories".
 *
 * That sentence is the whole argument for the feature: it is what proves
 * notes are not a graveyard. So every number in it is **counted, never
 * estimated** — `produced` counts accepted proposals by kind, and `waiting`
 * counts undecided ones, both straight off the table.
 */
export interface NoteCounts {
  notes: number;
  tasks: number;
  memories: number;
  /** Notes carrying at least one undecided proposal — "Waiting on you · 3". */
  waiting: number;
  unfiled: number;
  recorded: number;
}

export function getNoteCounts(): NoteCounts {
  const db = getDb();

  const total = db.select({ n: count() }).from(notes).get()?.n ?? 0;
  const unfiled =
    db.select({ n: count() }).from(notes).where(isNull(notes.projectId)).get()
      ?.n ?? 0;
  const recorded =
    db
      .select({ n: count() })
      .from(notes)
      .where(sql`${notes.audioPath} IS NOT NULL`)
      .get()?.n ?? 0;

  const acceptedByKind = db
    .select({ kind: noteExtractions.kind, n: count() })
    .from(noteExtractions)
    .where(eq(noteExtractions.state, "accepted"))
    .groupBy(noteExtractions.kind)
    .all();

  const waiting =
    db
      .select({ n: sql<number>`COUNT(DISTINCT ${noteExtractions.noteId})` })
      .from(noteExtractions)
      .where(eq(noteExtractions.state, "proposed"))
      .get()?.n ?? 0;

  const byKind = new Map(acceptedByKind.map((r) => [r.kind, r.n]));
  return {
    notes: total,
    tasks: byKind.get("task") ?? 0,
    memories: byKind.get("memory") ?? 0,
    waiting,
    unfiled,
    recorded,
  };
}

// -- Extractions -------------------------------------------------------------

export interface CreateExtractionInput {
  noteId: string;
  kind: NoteExtractionKind;
  payload: Record<string, unknown>;
  confidenceTier?: NoteConfidenceTier;
  reason?: string | null;
  conflict?: NoteConflict | null;
}

/**
 * Record a proposal. Emphatically not a write to anywhere else — this is the
 * whole mechanism by which extraction stays honest.
 */
export function createExtraction(input: CreateExtractionInput): NoteExtraction {
  const db = getDb();
  const row: ExtractionRow = {
    id: crypto.randomUUID(),
    noteId: input.noteId,
    kind: input.kind,
    payload: JSON.stringify(input.payload),
    confidenceTier: input.confidenceTier ?? "confident",
    reason: input.reason ?? null,
    state: "proposed",
    conflict: input.conflict ? JSON.stringify(input.conflict) : null,
    conflictResolution: null,
    acceptedRefType: null,
    acceptedRefId: null,
    createdAt: Date.now(),
    decidedAt: null,
  };
  db.insert(noteExtractions).values(row).run();
  return toExtraction(row);
}

export function getExtraction(id: string): NoteExtraction | null {
  const db = getDb();
  const row = db
    .select()
    .from(noteExtractions)
    .where(eq(noteExtractions.id, id))
    .get();
  return row ? toExtraction(row) : null;
}

export function listExtractionsForNote(noteId: string): NoteExtraction[] {
  const db = getDb();
  return db
    .select()
    .from(noteExtractions)
    .where(eq(noteExtractions.noteId, noteId))
    .orderBy(noteExtractions.createdAt)
    .all()
    .map(toExtraction);
}

/**
 * Every undecided proposal, newest first — what "Waiting on you" reads, in
 * Notes and in the morning brief alike. Acceptance only works if the pile is
 * visible from surfaces that come to you, not only from the one you must
 * remember to visit.
 */
export function listWaitingExtractions(limit = 50): NoteExtraction[] {
  const db = getDb();
  return db
    .select()
    .from(noteExtractions)
    .where(eq(noteExtractions.state, "proposed"))
    .orderBy(desc(noteExtractions.createdAt))
    .limit(Math.min(limit, MAX_NOTE_PAGE))
    .all()
    .map(toExtraction);
}

/**
 * Mark a proposal decided. Called by the accept route once the real write has
 * succeeded (`accepted`, with what it created), or directly on dismissal.
 *
 * Deliberately not named `accept`: this function only turns a column. The
 * write it records lives in `note-accept.ts`, and keeping the naming honest
 * is part of keeping the boundary visible.
 */
export function recordExtractionDecision(
  id: string,
  decision: Exclude<NoteExtractionDecision, "proposed">,
  outcome?: {
    acceptedRefType?: NoteAcceptedRefType;
    acceptedRefId?: string;
    conflictResolution?: NoteConflictResolution;
    /**
     * Exactly what acceptance wrote, so undo can take back that and only
     * that.
     *
     * Recorded rather than reconstructed: rebuilding the line from the
     * payload at undo time would silently drift the moment the formatting
     * changes, and an undo that removes the wrong line is worse than no undo
     * at all. Merged into `payload` so this needs no column of its own.
     */
    applied?: Record<string, unknown>;
  },
): NoteExtraction | null {
  const existing = getExtraction(id);
  if (!existing) return null;

  const db = getDb();
  db.update(noteExtractions)
    .set({
      state: decision,
      decidedAt: Date.now(),
      acceptedRefType: outcome?.acceptedRefType ?? null,
      acceptedRefId: outcome?.acceptedRefId ?? null,
      conflictResolution: outcome?.conflictResolution ?? null,
      ...(outcome?.applied
        ? {
            payload: JSON.stringify({
              ...existing.payload,
              applied: outcome.applied,
            }),
          }
        : {}),
    })
    .where(eq(noteExtractions.id, id))
    .run();
  return getExtraction(id);
}

/**
 * Put a proposal back to undecided, forgetting what acceptance created.
 *
 * The counterpart to {@link recordExtractionDecision}: undo happens in
 * `note-accept.ts`, which takes back the write first and calls this only once
 * that succeeded. The order matters for the same reason accepting is ordered
 * that way — a row that says "proposed" while the task it made still sits in
 * HQ is a lie in the other direction.
 */
export function reopenExtraction(id: string): NoteExtraction | null {
  const existing = getExtraction(id);
  if (!existing) return null;

  const { applied: _dropped, ...payload } = existing.payload as Record<
    string,
    unknown
  >;

  const db = getDb();
  db.update(noteExtractions)
    .set({
      state: "proposed",
      decidedAt: null,
      acceptedRefType: null,
      acceptedRefId: null,
      conflictResolution: null,
      payload: JSON.stringify(payload),
    })
    .where(eq(noteExtractions.id, id))
    .run();
  return getExtraction(id);
}

/**
 * Accept rate per extraction type — the number that says whether this feature
 * works, available from day one rather than retrofitted after a week of not
 * knowing.
 *
 * If it is low, the answer is fewer and better extractions, not more
 * prompting. Reported per kind and tier because those fail differently: a
 * poor `unsure` rate means the tier is doing its job, a poor `confident` rate
 * means the extractor is wrong.
 */
export interface AcceptRateRow {
  kind: NoteExtractionKind;
  confidenceTier: NoteConfidenceTier;
  proposed: number;
  accepted: number;
  dismissed: number;
}

export function getAcceptRates(sinceMs?: number): AcceptRateRow[] {
  const db = getDb();
  const where = sinceMs
    ? sql`${noteExtractions.createdAt} >= ${sinceMs}`
    : undefined;
  const rows = db
    .select({
      kind: noteExtractions.kind,
      confidenceTier: noteExtractions.confidenceTier,
      state: noteExtractions.state,
      n: count(),
    })
    .from(noteExtractions)
    .where(where)
    .groupBy(
      noteExtractions.kind,
      noteExtractions.confidenceTier,
      noteExtractions.state,
    )
    .all();

  const byPair = new Map<string, AcceptRateRow>();
  for (const row of rows) {
    const key = `${row.kind}:${row.confidenceTier}`;
    const entry = byPair.get(key) ?? {
      kind: row.kind as NoteExtractionKind,
      confidenceTier: row.confidenceTier as NoteConfidenceTier,
      proposed: 0,
      accepted: 0,
      dismissed: 0,
    };
    if (row.state === "proposed") entry.proposed = row.n;
    if (row.state === "accepted") entry.accepted = row.n;
    if (row.state === "dismissed") entry.dismissed = row.n;
    byPair.set(key, entry);
  }
  return [...byPair.values()];
}
