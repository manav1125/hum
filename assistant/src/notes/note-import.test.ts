/**
 * The import, and the one decision it turns on.
 *
 * Everything imported is searchable immediately. The only question is what
 * gets PROPOSED as work, and the default matters more than it looks:
 * proposing 73 tasks out of two years of archive is how someone's HQ becomes
 * unusable on their first day — and it is dishonest besides, because a
 * two-year-old "call the dentist" is not a live commitment.
 *
 * So the tests here are mostly about the window, and about `occurredAt`:
 * without the note's own date, every imported note dates from the import,
 * which puts a decade of writing at the top of today's list AND makes the
 * window meaningless, since everything looks like it happened this minute.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  importNotes,
  parseMarkdownExport,
  selectForExtraction,
} from "./note-import.js";
import { listNotes, type Note } from "./note-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
});

const NOW = Date.parse("2026-08-21T09:00:00Z");
const daysAgo = (n: number) => NOW - n * 24 * 3600_000;

describe("selectForExtraction", () => {
  const note = (occurredAt: number) => ({ occurredAt }) as Note;

  test("last_month is the default window, and it is a real filter", () => {
    const notes = [note(daysAgo(3)), note(daysAgo(200)), note(daysAgo(700))];
    expect(selectForExtraction(notes, "last_month", NOW)).toHaveLength(1);
  });

  test("all means all — someone importing last quarter means it", () => {
    const notes = [note(daysAgo(3)), note(daysAgo(700))];
    expect(selectForExtraction(notes, "all", NOW)).toHaveLength(2);
  });

  test("none proposes nothing, and the notes are still imported", () => {
    const notes = [note(daysAgo(3))];
    expect(selectForExtraction(notes, "none", NOW)).toEqual([]);
  });
});

describe("importNotes", () => {
  test("imported notes are searchable immediately, whatever the window", () => {
    const { summary } = importNotes(
      [
        { body: "An old thought", occurredAt: daysAgo(700) },
        { body: "A recent thought", occurredAt: daysAgo(2) },
      ],
      { window: "none" },
    );

    // Nothing is queued for reading, and yet both notes exist and list.
    expect(summary.queuedForReading).toBe(0);
    expect(summary.imported).toBe(2);
    expect(listNotes()).toHaveLength(2);
  });

  test("THE DEFAULT: two years of archive proposes only the recent month", () => {
    const { summary, toRead } = importNotes([
      { body: "call the dentist", occurredAt: daysAgo(730) },
      { body: "chase the invoice", occurredAt: daysAgo(400) },
      { body: "send Dana the report", occurredAt: daysAgo(5) },
    ]);

    expect(summary.window).toBe("last_month");
    expect(summary.imported).toBe(3);
    expect(toRead).toHaveLength(1);
    expect(toRead[0]?.body).toBe("send Dana the report");
  });

  test("keeps each note's own date, or the window means nothing", () => {
    const when = daysAgo(400);
    importNotes([{ body: "An old thought", occurredAt: when }]);
    expect(listNotes()[0]?.occurredAt).toBe(when);
  });

  test("marks where the pile came from without changing how it behaves", () => {
    importNotes([{ body: "A thought" }], { tool: "apple-notes" });
    const [note] = listNotes();
    expect(note?.source).toBe("import");
    expect(note?.sourceDetail).toBe("apple-notes");
    // An import creates notes, never tasks: nothing is proposed or filed by
    // the act of importing.
    expect(note?.projectId).toBeNull();
    expect(note?.extractionState).toBe("idle");
  });

  test("blank notes are skipped, not imported as empties", () => {
    const { summary } = importNotes([
      { body: "   " },
      { body: "" },
      { body: "real" },
    ]);
    expect(summary).toMatchObject({ imported: 1, skipped: 2 });
  });
});

describe("parseMarkdownExport", () => {
  test("a heading becomes the title and leaves the body", () => {
    const [note] = parseMarkdownExport([
      { name: "2026-03-14.md", content: "# Acme kickoff\n\nMigration is it." },
    ]);
    expect(note?.title).toBe("Acme kickoff");
    expect(note?.body).toBe("Migration is it.");
  });

  test("no heading: the first line titles it, exactly like a typed note", () => {
    const [note] = parseMarkdownExport([
      { name: "note.md", content: "Migration is the real objection\nmore" },
    ]);
    expect(note?.title).toBe("Migration is the real objection");
  });

  test("the filename is a fallback, never a preference", () => {
    // `2026-03-14-1423.md` tells the owner nothing; what they wrote does.
    const [note] = parseMarkdownExport([
      { name: "2026-03-14-1423.md", content: "# Real title\nbody" },
    ]);
    expect(note?.title).toBe("Real title");
  });

  test("empty files are dropped rather than imported blank", () => {
    expect(parseMarkdownExport([{ name: "a.md", content: "  \n " }])).toEqual(
      [],
    );
  });
});
