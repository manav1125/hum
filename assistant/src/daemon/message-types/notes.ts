/**
 * Notes — server push messages.
 *
 * One lightweight invalidation signal, deliberately carrying no payload. The
 * counts a Notes client renders ("62 notes · 78 tasks · 31 memories",
 * "Waiting on you · 3") are all computed, not pushed, so a client that
 * refetches on this signal can never drift from the database — and a signal
 * with no numbers in it cannot be the thing that renders a stale one.
 */

/** Server push — a note, or a proposal on one, was created, changed or decided. */
export interface NotesChanged {
  type: "notes_changed";
}

export type _NotesServerMessages = NotesChanged;
