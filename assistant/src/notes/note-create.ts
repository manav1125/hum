/**
 * A note is a brief — turning one into something Cue makes.
 *
 * This is the step that connects three surfaces that were islands: Notes →
 * Create → Library, with provenance running the whole way. The deck knows its
 * brief; the brief knows its note. So a deck can always answer "where did
 * this come from?", which is the question that makes generated work
 * defensible rather than merely fast.
 *
 * ## The options are the note's plausible outputs, not a menu
 *
 * A note about a customer offers a deck and an email, not a video style. That
 * restraint is the difference between "make something from this" reading as a
 * suggestion and reading as a toy box — and a toy box is what makes people
 * stop trusting the suggestions.
 *
 * ## Provenance stays one-way
 *
 * The output remembers the note. **Deleting the note never deletes the
 * deck** — the same rule as note → task, for the same reason: notes must not
 * become load-bearing infrastructure by accident.
 */

import type { Note } from "./note-store.js";

/** What Cue can make from a note. Each is a real Create surface. */
export type CreateKind = "deck" | "one_pager" | "email" | "plan" | "doc";

export interface CreateOption {
  kind: CreateKind;
  label: string;
  /** The brief Create receives, seeded from the note. */
  prompt: string;
}

/**
 * Signals that a note is ABOUT something, used to pick plausible outputs.
 *
 * Deliberately shallow — this decides which four buttons to draw, not what
 * gets made. A wrong guess costs someone one glance at an option they do not
 * want; a model call to decide it would cost real money on every note opened.
 */
interface NoteShape {
  aboutAPerson: boolean;
  aboutMoneyOrTerms: boolean;
  aboutAPlan: boolean;
}

const PERSON_RE =
  /\b(call|met|meeting|spoke|email(ed)?|they|he|she|customer|client|vendor)\b/i;
const MONEY_RE =
  /[$£€]\s?\d|\b\d+\s?%|\bper seat\b|\bterm\b|\bquote\b|\bprice\b/i;
const PLAN_RE =
  /\b(plan|roadmap|milestone|timeline|launch|ship|phase|by (mon|tues|wednes|thurs|fri)day)\b/i;

export function readNoteShape(note: Note): NoteShape {
  const text = `${note.title}\n${note.body}`;
  return {
    aboutAPerson: PERSON_RE.test(text),
    aboutMoneyOrTerms: MONEY_RE.test(text),
    aboutAPlan: PLAN_RE.test(text),
  };
}

/** Never more than this — a menu of everything is not a suggestion. */
const MAX_OPTIONS = 4;

/**
 * The plausible things to make from this note.
 *
 * Always returns something: a note that matches no signal still offers a
 * one-pager and a doc, because "make something from this" that offers nothing
 * is a dead button.
 */
export function createOptionsFor(note: Note): CreateOption[] {
  const shape = readNoteShape(note);
  const brief = briefFor(note);
  const options: CreateOption[] = [];

  if (shape.aboutMoneyOrTerms || shape.aboutAPerson) {
    options.push({
      kind: "deck",
      label: "A deck",
      prompt: `Make a short deck from this note.\n\n${brief}`,
    });
  }
  if (shape.aboutAPerson) {
    options.push({
      kind: "email",
      label: "An email",
      prompt: `Draft an email based on this note. Keep my voice; do not invent facts that are not here.\n\n${brief}`,
    });
  }
  if (shape.aboutAPlan) {
    options.push({
      kind: "plan",
      label: "A plan",
      prompt: `Turn this note into a plan with the steps and dates it actually contains.\n\n${brief}`,
    });
  }

  options.push({
    kind: "one_pager",
    label: "A one-pager",
    prompt: `Make a one-pager from this note.\n\n${brief}`,
  });
  if (options.length < MAX_OPTIONS) {
    options.push({
      kind: "doc",
      label: "A document",
      prompt: `Write this note up as a document.\n\n${brief}`,
    });
  }

  return options.slice(0, MAX_OPTIONS);
}

/**
 * The note, as a brief.
 *
 * Says plainly that the note is the source and that nothing outside it may be
 * invented — the same standard the extractor holds itself to, carried into
 * the thing that gets made.
 */
export function briefFor(note: Note): string {
  return [
    `The brief is this note, written ${new Date(note.occurredAt).toISOString().slice(0, 10)}:`,
    '"""',
    note.body.trim(),
    '"""',
    "Use only what is in the note. Where something is missing, leave a gap and say so rather than inventing it.",
  ].join("\n");
}
