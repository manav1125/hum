/**
 * Notes in the rituals — the fix for the flaw that acceptance introduces.
 *
 * Requiring acceptance means unreviewed proposals pile up, and "Waiting on
 * you · 3" only helps someone who goes to Notes. The morning brief and the
 * weekly review are the surfaces that come to *you*, so they carry it. That
 * is what makes "nothing files without you" workable rather than a way for
 * findings to rot quietly.
 *
 * ## It leads with what is relevant, not with a count
 *
 * "I found 5 things and two of them are about today's call" is a reason to
 * look. "5 unreviewed extractions" is a number, and a number is easy to skip
 * every morning until it is 60. So the beat below sorts what is due soonest
 * to the front and says so in the sentence.
 *
 * ## It proposes nothing and files nothing
 *
 * This module reads. Everything it surfaces is still a proposal, and the only
 * thing that turns one into work is the owner accepting it — from Notes, or
 * from the review link this hands them.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { noteExtractions, notes } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import { listWaitingExtractions, type NoteExtraction } from "./note-store.js";

const log = getLogger("note-ritual");

/** Beyond this the beat is a wall of text, not a nudge. */
const MAX_MENTIONED = 5;

/** "About today" means due inside this window. */
const TODAY_WINDOW_MS = 24 * 3600_000;

export interface NotesBeat {
  /** Notes carrying undecided proposals. */
  noteCount: number;
  /** Undecided proposals across them. */
  found: number;
  /**
   * How many are due within a day. The reason to look now rather than
   * eventually, and the thing the sentence leads with.
   */
  dueSoon: number;
  /** One sentence, already written — the ritual renders it as-is. */
  sentence: string;
  /** The soonest-relevant few, for a client that wants to list them. */
  items: NoteExtraction[];
}

function dueAt(extraction: NoteExtraction): number | null {
  const value = extraction.payload.dueAt;
  return typeof value === "number" ? value : null;
}

/**
 * Build the notes beat, or `null` when there is nothing waiting.
 *
 * `null` rather than a zero-state on purpose: a ritual that says "0 things
 * from your notes" every morning teaches people to skip the section, and the
 * section needs to be worth reading on the day it says something.
 */
export function buildNotesBeat(now = Date.now()): NotesBeat | null {
  let waiting: NoteExtraction[];
  try {
    waiting = listWaitingExtractions(50);
  } catch (err) {
    // A brief that cannot read notes still has an overnight and a day. Losing
    // one beat must never cost the whole ritual.
    log.warn({ err }, "notes beat unavailable; the rest of the brief stands");
    return null;
  }
  if (waiting.length === 0) return null;

  const noteIds = new Set(waiting.map((item) => item.noteId));
  const dueSoon = waiting.filter((item) => {
    const due = dueAt(item);
    return due !== null && due - now <= TODAY_WINDOW_MS;
  });

  // Soonest-due first, then newest. What is about today leads, because that
  // is the part that makes looking now rather than later worth it.
  const items = [...waiting]
    .sort((a, b) => {
      const aDue = dueAt(a);
      const bDue = dueAt(b);
      if (aDue !== null && bDue !== null) return aDue - bDue;
      if (aDue !== null) return -1;
      if (bDue !== null) return 1;
      return b.createdAt - a.createdAt;
    })
    .slice(0, MAX_MENTIONED);

  return {
    noteCount: noteIds.size,
    found: waiting.length,
    dueSoon: dueSoon.length,
    sentence: composeSentence(noteIds.size, waiting.length, dueSoon.length),
    items,
  };
}

/**
 * The sentence, in the owner's terms.
 *
 * It says what was found and what has not been looked at, and — when any of
 * it is about today — leads with that rather than with the tally.
 */
export function composeSentence(
  noteCount: number,
  found: number,
  dueSoon: number,
): string {
  const notes = `${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
  const things = `${found} ${found === 1 ? "thing" : "things"}`;
  const base = `You have ${things} to do that I found in ${notes}, and you haven't looked at ${found === 1 ? "it" : "them"} yet`;
  if (dueSoon === 0) return `${base}.`;
  return `${base} — ${dueSoon === 1 ? "one is" : `${dueSoon} are`} about today.`;
}

/**
 * The weekly review's line: what the week's notes actually did.
 *
 * "9 became work, 5 were just thinking" is the honest shape. The second half
 * matters as much as the first — a note that stays a note is not a failure,
 * and a review that only counts conversions teaches people that unfiled
 * notes are debt. They are not; the walking-to-work thought is the
 * highest-value note in the system.
 */
export function composeWeeklyLine(taken: number, becameWork: number): string {
  const justThinking = Math.max(0, taken - becameWork);
  return `You took ${taken} ${taken === 1 ? "note" : "notes"}, ${becameWork} became work, ${justThinking} ${justThinking === 1 ? "was" : "were"} just thinking.`;
}

/**
 * The week's notes, for the weekly review.
 *
 * Counts what was taken and what became work over a window. The second half
 * of {@link composeWeeklyLine} — what stayed a note — is derived rather than
 * counted, because "just thinking" is not a state anything sets; it is
 * everything that was not converted, which is the honest way to define it.
 */
export interface NotesWeek {
  taken: number;
  becameWork: number;
  line: string;
}

export function buildNotesWeek(
  sinceMs: number,
  untilMs = Date.now(),
): NotesWeek | null {
  try {
    const db = getDb();
    const taken =
      (
        db
          .select({ n: sql<number>`COUNT(*)` })
          .from(notes)
          .where(
            and(gte(notes.occurredAt, sinceMs), lte(notes.occurredAt, untilMs)),
          )
          .get() as { n: number } | undefined
      )?.n ?? 0;

    if (taken === 0) return null;

    // Notes that produced at least one ACCEPTED task. Counting accepted
    // proposals instead would let one note with three tasks read as three
    // notes that became work.
    const becameWork =
      (
        db
          .select({
            n: sql<number>`COUNT(DISTINCT ${noteExtractions.noteId})`,
          })
          .from(noteExtractions)
          .innerJoin(notes, eq(notes.id, noteExtractions.noteId))
          .where(
            and(
              eq(noteExtractions.state, "accepted"),
              gte(notes.occurredAt, sinceMs),
              lte(notes.occurredAt, untilMs),
            ),
          )
          .get() as { n: number } | undefined
      )?.n ?? 0;

    return { taken, becameWork, line: composeWeeklyLine(taken, becameWork) };
  } catch (err) {
    log.warn({ err }, "notes week unavailable; the rest of the weekly stands");
    return null;
  }
}
