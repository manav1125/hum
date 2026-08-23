/**
 * The Notes wire shape — the single place the web app names it.
 *
 * Lifted out of `domains/notes` because capture is not the Notes page's
 * private business: the floating corner writes notes too (`⌘↵`), and the iOS
 * capture doors will. A type two domains need is a top-level type, per
 * CONVENTIONS.md — the alternative is a cross-domain import, which is how one
 * domain quietly becomes another's library.
 *
 * Two things the UI depends on and must not re-derive:
 *
 *   · **`extractionState: "done"` with no proposals is "nothing to file".**
 *     `"failed"` is "I couldn't read this one just now — your note is
 *     saved." One is about the note, the other about the request, and the UI
 *     has a separate branch for each.
 *   · **`confidenceTier` is drawn, never printed.** There is no number on the
 *     wire to render, and there must never be one: "82% sure" is a fact about
 *     the model, not about the owner's work.
 */

export type NoteSource = "typed" | "voice" | "selection" | "arrival" | "import";
export type NoteExtractionState = "idle" | "reading" | "done" | "failed";
export type NoteExtractionKind = "task" | "memory" | "person_trait";
export type NoteConfidenceTier = "confident" | "unsure";
export type NoteDecision = "proposed" | "accepted" | "dismissed";
export type NoteConflictResolution = "replace" | "keep_both" | "ignore";

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
  /** True when `body` is Cue's summary. A summary is always labelled as one. */
  bodyIsSummary: boolean;
  extractionState: NoteExtractionState;
  lastReadHash: string | null;
  lastReadAt: number | null;
  /** When the thought happened. The list sorts on this, not on `createdAt`. */
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
}

/** What Cue already believed, against what this note says. Never one without the other. */
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
  payload: {
    title?: string;
    detail?: string;
    person?: string | null;
    dueAt?: number | null;
  };
  confidenceTier: NoteConfidenceTier;
  /** Plain words, for the unsure tier only. */
  reason: string | null;
  state: NoteDecision;
  conflict: NoteConflict | null;
  conflictResolution: NoteConflictResolution | null;
  acceptedRefType: "work_item" | "memory_page" | "contact" | null;
  acceptedRefId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface NoteCounts {
  notes: number;
  tasks: number;
  memories: number;
  /** Notes with proposals nobody has looked at — "Waiting on you · 3". */
  waiting: number;
  unfiled: number;
  recorded: number;
}

export type NoteFilter = "all" | "waiting" | "unfiled" | "recorded";

export interface ReadNoteResult {
  status: "skipped" | "done" | "failed";
  /**
   * `offline` is client-side only — the daemon never sends it. It means the
   * read was queued, which is a different thing from the daemon declining to
   * re-read unchanged text.
   */
  skippedReason: "unchanged" | "disabled" | "missing" | "offline" | null;
  extractions: NoteExtraction[];
}
