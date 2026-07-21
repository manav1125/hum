/**
 * Mid-run progress notes: the pure tool-event → activity-line mapping, plus
 * the store round-trip for `lastProgressNote` (stamped by the runner while an
 * item is running, exposed on GET work-items).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { resetDbForTesting } from "../__tests__/db-test-helpers.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { progressNoteForToolStart } from "./work-item-runner.js";
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
} from "./work-item-store.js";

describe("progressNoteForToolStart", () => {
  test("web_search surfaces the query", () => {
    expect(
      progressNoteForToolStart("web_search", { query: "cue launch dates" }),
    ).toBe('Searching "cue launch dates"');
    expect(progressNoteForToolStart("web_search", {})).toBe(
      "Searching the web",
    );
  });

  test("web_search truncates long queries", () => {
    const long = "x".repeat(80);
    const note = progressNoteForToolStart("web_search", { query: long });
    expect(note.length).toBeLessThanOrEqual('Searching ""'.length + 60);
    expect(note).toContain("...");
  });

  test("web_fetch surfaces the domain", () => {
    expect(
      progressNoteForToolStart("web_fetch", {
        url: "https://example.com/a/b?q=1",
      }),
    ).toBe("Reading example.com");
    expect(progressNoteForToolStart("web_fetch", { url: "not a url" })).toBe(
      "Reading a page",
    );
    expect(progressNoteForToolStart("web_fetch", {})).toBe("Reading a page");
  });

  test("skill_execute uses its activity line when present", () => {
    expect(
      progressNoteForToolStart("skill_execute", {
        activity: "Compiling the weekly digest",
      }),
    ).toBe("Compiling the weekly digest");
  });

  test("file reads name the file instead of the tool", () => {
    expect(
      progressNoteForToolStart("file_read", { path: "/tmp/wk/notes/plan.md" }),
    ).toBe("Reading plan.md");
    expect(
      progressNoteForToolStart("file_write", { path: "/tmp/wk/out/draft.md" }),
    ).toBe("Writing draft.md");
  });

  test("a project-knowledge file read says where the file came from", () => {
    const knowledge = new Map([
      ["/tmp/wk/knowledge/abc123.pdf", "Q2-deck.pdf"],
      ["abc123.pdf", "Q2-deck.pdf"],
    ]);
    expect(
      progressNoteForToolStart(
        "file_read",
        { path: "/tmp/wk/knowledge/abc123.pdf" },
        knowledge,
      ),
    ).toBe("Reading Q2-deck.pdf from project knowledge");
    // A path that is not project knowledge is still named honestly — never
    // labelled as knowledge it isn't.
    expect(
      progressNoteForToolStart(
        "file_read",
        { path: "/tmp/other.pdf" },
        knowledge,
      ),
    ).toBe("Reading other.pdf");
  });

  test("any tool's own activity line beats a generic label", () => {
    expect(
      progressNoteForToolStart("bash", {
        activity: "Converting the deck to PDF",
      }),
    ).toBe("Converting the deck to PDF");
    const long = "x".repeat(200);
    expect(
      progressNoteForToolStart("bash", { activity: long }).length,
    ).toBeLessThanOrEqual(120);
  });

  test("other tools get a humanized 'Running …' label", () => {
    expect(progressNoteForToolStart("file_read", {})).toBe("Running file read");
    expect(progressNoteForToolStart("bash", {})).toBe("Running bash");
  });
});

describe("lastProgressNote store round-trip", () => {
  // Heal a singleton an earlier test file may have opened inside its own
  // (since-deleted) per-test workspace override, then (re)initialize against
  // the preload workspace.
  resetDbForTesting();
  initializeDb();

  let taskId = "";

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    taskId = createTask({ title: "Progress task", template: "do it" }).id;
  });

  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  test("stamps, reads back, and clears the progress note", () => {
    const item = createWorkItem({ taskId, title: "Long research" });
    expect(item.lastProgressNote).toBeNull();

    updateWorkItem(item.id, { status: "running" });
    updateWorkItem(item.id, { lastProgressNote: 'Searching "cue pricing"' });

    expect(getWorkItem(item.id)!.lastProgressNote).toBe(
      'Searching "cue pricing"',
    );
    // The list surface (GET work-items) carries the note too.
    const listed = listWorkItems({ status: "running" });
    expect(listed[0]!.lastProgressNote).toBe('Searching "cue pricing"');

    // Terminal transition clears it, so finished items never show a stale
    // "Searching…" line.
    updateWorkItem(item.id, {
      status: "awaiting_review",
      lastProgressNote: null,
    });
    expect(getWorkItem(item.id)!.lastProgressNote).toBeNull();
  });
});
