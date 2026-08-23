/**
 * The notes beat in the rituals.
 *
 * Requiring acceptance means unreviewed proposals pile up, and "Waiting on
 * you · 3" only helps someone who goes to Notes. The brief is the surface
 * that comes to *them*, so it carries the pile — which is the thing that
 * makes "nothing files without you" workable rather than a way for findings
 * to rot quietly.
 *
 * Two behaviours are worth pinning:
 *
 *  · **Nothing waiting means no beat at all.** A section that says "0 things
 *    from your notes" every morning teaches people to skip the section, and
 *    then it is not read on the day it matters.
 *  · **It leads with what is about today.** A count is easy to postpone every
 *    morning until it is sixty; a reason is not.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  buildNotesBeat,
  composeSentence,
  composeWeeklyLine,
} from "./note-ritual.js";
import {
  createExtraction,
  createNote,
  recordExtractionDecision,
} from "./note-store.js";

initializeDb();

const NOW = Date.parse("2026-08-21T07:30:00Z");
const inHours = (h: number) => NOW + h * 3600_000;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM note_extractions");
  db.run("DELETE FROM notes");
});

function proposal(dueAt: number | null = null) {
  const note = createNote({ body: "a note" });
  return createExtraction({
    noteId: note.id,
    kind: "task",
    payload: { title: "Send the report", dueAt },
  });
}

describe("buildNotesBeat", () => {
  test("nothing waiting means NO beat — not a zero-state", () => {
    expect(buildNotesBeat(NOW)).toBeNull();
  });

  test("a decided proposal is not waiting", () => {
    const extraction = proposal();
    recordExtractionDecision(extraction.id, "accepted");
    expect(buildNotesBeat(NOW)).toBeNull();
  });

  test("counts notes and proposals separately — they are different numbers", () => {
    const note = createNote({ body: "one note" });
    createExtraction({ noteId: note.id, kind: "task", payload: {} });
    createExtraction({ noteId: note.id, kind: "memory", payload: {} });

    const beat = buildNotesBeat(NOW);
    expect(beat?.noteCount).toBe(1);
    expect(beat?.found).toBe(2);
  });

  test("leads with what is about today", () => {
    proposal(inHours(3));
    proposal(null);

    const beat = buildNotesBeat(NOW);
    expect(beat?.dueSoon).toBe(1);
    expect(beat?.sentence).toContain("about today");
    // Soonest-due first: the reason to look now is the thing at the top.
    expect(beat?.items[0]?.payload.dueAt).toBe(inHours(3));
  });

  test("something due next week is not 'about today'", () => {
    proposal(inHours(24 * 7));
    const beat = buildNotesBeat(NOW);
    expect(beat?.dueSoon).toBe(0);
    expect(beat?.sentence).not.toContain("about today");
  });
});

describe("composeSentence", () => {
  test("says what was found and that it has not been looked at", () => {
    expect(composeSentence(3, 5, 0)).toBe(
      "You have 5 things to do that I found in 3 notes, and you haven't looked at them yet.",
    );
  });

  test("singulars read like English", () => {
    expect(composeSentence(1, 1, 0)).toBe(
      "You have 1 thing to do that I found in 1 note, and you haven't looked at it yet.",
    );
  });

  test("today's is what the sentence ends on", () => {
    expect(composeSentence(3, 5, 2)).toContain("2 are about today");
    expect(composeSentence(3, 5, 1)).toContain("one is about today");
  });
});

describe("composeWeeklyLine", () => {
  test("counts what stayed a note as well as what became work", () => {
    // A note that stays a note is not a failure, and a review that counts
    // only conversions teaches people unfiled notes are debt. They are not.
    expect(composeWeeklyLine(14, 9)).toBe(
      "You took 14 notes, 9 became work, 5 were just thinking.",
    );
  });

  test("never reports negative thinking when the numbers disagree", () => {
    expect(composeWeeklyLine(2, 5)).toContain("0 were just thinking");
  });
});
