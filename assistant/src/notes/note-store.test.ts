/**
 * Notes store — the rules that are cheaper to assert than to re-argue.
 *
 * The one this file exists for is `deleteNote`: provenance is one-way, so
 * deleting a note must leave the work it produced completely alone. That is
 * the invariant someone tidying their notes is unknowingly relying on.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createWorkItem, getWorkItem } from "../work-items/work-item-store.js";
import {
  createExtraction,
  createNote,
  deleteNote,
  deriveNoteTitle,
  getAcceptRates,
  getNote,
  getNoteCounts,
  listExtractionsForNote,
  listNotes,
  listWaitingExtractions,
  recordExtractionDecision,
  updateNote,
} from "./note-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

describe("deriveNoteTitle", () => {
  test("uses the first non-empty line", () => {
    expect(deriveNoteTitle("\n\n  Acme renewal call\nmore text")).toBe(
      "Acme renewal call",
    );
  });

  test("an empty note still gets something on its card", () => {
    expect(deriveNoteTitle("   \n  ")).toBe("Untitled note");
  });
});

describe("createNote", () => {
  test("saves without filing, reading or proposing anything", () => {
    const note = createNote({ body: "Don't lead with price." });
    expect(note.projectId).toBeNull();
    expect(note.extractionState).toBe("idle");
    expect(note.lastReadHash).toBeNull();
    expect(listExtractionsForNote(note.id)).toEqual([]);
  });

  test("a client-minted id is honoured, so an offline note keeps its identity", () => {
    const id = crypto.randomUUID();
    const note = createNote({ id, body: "written on a plane" });
    expect(note.id).toBe(id);
  });

  test("IDEMPOTENT: the same id pushed twice is one note, and the first wins", () => {
    // The retry after a dropped connection, the second tab, the app
    // relaunching mid-sync. A replayed create must not duplicate the note —
    // and must not clobber an edit made between the two pushes.
    const id = crypto.randomUUID();
    createNote({ id, body: "original" });
    updateNote(id, { body: "edited after the first push" });

    const replayed = createNote({ id, body: "original" });
    expect(replayed.body).toBe("edited after the first push");
    expect(listNotes()).toHaveLength(1);
  });

  test("occurredAt carries the source's own time when given", () => {
    const when = Date.parse("2026-03-14T09:00:00Z");
    const note = createNote({
      body: "Acme kickoff — what they care about",
      source: "import",
      sourceDetail: "apple-notes",
      occurredAt: when,
    });
    expect(note.occurredAt).toBe(when);
    expect(note.createdAt).toBeGreaterThan(when);
  });
});

describe("updateNote", () => {
  test("a derived title follows the first line", () => {
    const note = createNote({ body: "first thought" });
    const updated = updateNote(note.id, { body: "a better first line\nmore" });
    expect(updated?.title).toBe("a better first line");
  });

  test("a title the owner chose is never rewritten by an edit", () => {
    const note = createNote({ body: "first thought", title: "Vendor call" });
    const updated = updateNote(note.id, { body: "completely different text" });
    expect(updated?.title).toBe("Vendor call");
  });

  test("unfiling is an explicit null, not an omission", () => {
    const note = createNote({ body: "x", projectId: "proj-1" });
    expect(updateNote(note.id, {})?.projectId).toBe("proj-1");
    expect(updateNote(note.id, { projectId: null })?.projectId).toBeNull();
  });
});

describe("deleteNote", () => {
  test("deletes the note and its proposals", () => {
    const note = createNote({ body: "needs to send the SOC 2 report" });
    createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the SOC 2 report" },
    });

    expect(deleteNote(note.id)).toBe(true);
    expect(getNote(note.id)).toBeNull();
    expect(listExtractionsForNote(note.id)).toEqual([]);
  });

  test("NEVER deletes work accepted out of it — provenance is one-way", () => {
    const note = createNote({ body: "send the report" });
    const task = createTask({ title: "Send the report", template: "…" });
    const item = createWorkItem({
      taskId: task.id,
      title: "Send the report",
      noteId: note.id,
    });

    deleteNote(note.id);

    const survivor = getWorkItem(item.id);
    expect(survivor).toBeDefined();
    // The dangling id is the intended end state: the card can honestly say
    // "from a note you deleted" instead of pretending it had no origin.
    expect(survivor?.noteId).toBe(note.id);
    expect(getNote(note.id)).toBeNull();
  });
});

describe("listNotes filters", () => {
  test("waiting is notes with undecided proposals, not notes with any", () => {
    const waiting = createNote({ body: "a" });
    const decided = createNote({ body: "b" });
    createExtraction({ noteId: waiting.id, kind: "task", payload: {} });
    const done = createExtraction({
      noteId: decided.id,
      kind: "task",
      payload: {},
    });
    recordExtractionDecision(done.id, "accepted");

    const ids = listNotes({ filter: "waiting" }).map((n) => n.id);
    expect(ids).toEqual([waiting.id]);
  });

  test("unfiled and recorded are independent axes", () => {
    createNote({ body: "unfiled, no audio" });
    createNote({ body: "filed", projectId: "p1" });
    createNote({ body: "recorded", audioPath: "/local/a.m4a" });

    expect(listNotes({ filter: "unfiled" })).toHaveLength(2);
    expect(listNotes({ filter: "recorded" })).toHaveLength(1);
  });

  test("newest thought first, not newest row first", () => {
    const older = createNote({
      body: "written today, thought in March",
      occurredAt: Date.parse("2026-03-14T09:00:00Z"),
    });
    const newer = createNote({ body: "thought just now" });
    expect(listNotes().map((n) => n.id)).toEqual([newer.id, older.id]);
  });
});

describe("getNoteCounts", () => {
  test("counts what notes PRODUCED — the header line's whole argument", () => {
    const note = createNote({ body: "a" });
    const task = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: {},
    });
    const memory = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: {},
    });
    createExtraction({ noteId: note.id, kind: "task", payload: {} });
    recordExtractionDecision(task.id, "accepted");
    recordExtractionDecision(memory.id, "accepted");

    const counts = getNoteCounts();
    expect(counts.notes).toBe(1);
    expect(counts.tasks).toBe(1);
    expect(counts.memories).toBe(1);
    // One note, one undecided proposal — "Waiting on you · 1".
    expect(counts.waiting).toBe(1);
  });

  test("waiting counts notes, not proposals", () => {
    const note = createNote({ body: "a" });
    createExtraction({ noteId: note.id, kind: "task", payload: {} });
    createExtraction({ noteId: note.id, kind: "task", payload: {} });
    createExtraction({ noteId: note.id, kind: "memory", payload: {} });
    expect(getNoteCounts().waiting).toBe(1);
  });
});

describe("listWaitingExtractions", () => {
  test("returns only undecided proposals", () => {
    const note = createNote({ body: "a" });
    const open = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: {},
    });
    const dismissed = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: {},
    });
    recordExtractionDecision(dismissed.id, "dismissed");

    expect(listWaitingExtractions().map((e) => e.id)).toEqual([open.id]);
  });
});

describe("getAcceptRates", () => {
  test("splits by kind AND tier, because they fail differently", () => {
    const note = createNote({ body: "a" });
    const sure = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: {},
      confidenceTier: "confident",
    });
    const unsure = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: {},
      confidenceTier: "unsure",
      reason: "you wrote 'maybe'",
    });
    recordExtractionDecision(sure.id, "accepted");
    recordExtractionDecision(unsure.id, "dismissed");

    const rates = getAcceptRates();
    const confident = rates.find((r) => r.confidenceTier === "confident");
    const hedged = rates.find((r) => r.confidenceTier === "unsure");
    expect(confident).toMatchObject({
      kind: "task",
      accepted: 1,
      dismissed: 0,
    });
    expect(hedged).toMatchObject({ kind: "task", accepted: 0, dismissed: 1 });
  });
});

describe("extraction payloads", () => {
  test("a malformed payload degrades to {} rather than breaking the rail", () => {
    const note = createNote({ body: "a" });
    const extraction = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "fine" },
    });
    getDb().run(
      `UPDATE note_extractions SET payload = '{not json' WHERE id = '${extraction.id}'`,
    );
    const [read] = listExtractionsForNote(note.id);
    expect(read?.payload).toEqual({});
  });
});
