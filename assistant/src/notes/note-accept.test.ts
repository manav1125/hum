/**
 * Acceptance — the single door between "Cue found something" and "it's in
 * your work".
 *
 * Two properties matter more than the happy path:
 *
 *   · accepting twice must not create the thing twice, and
 *   · a failed write must leave the proposal `proposed`. A row marked
 *     accepted with nothing behind it makes the rail say "Filed 3 tasks"
 *     when two landed, which is worse than saying it could not.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { rm } from "node:fs/promises";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getConceptsDir,
  readPage,
  writePage,
} from "../memory/v2/page-store.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getWorkItem } from "../work-items/work-item-store.js";
import {
  acceptExtraction,
  dismissExtraction,
  undoExtraction,
} from "./note-accept.js";
import {
  createExtraction,
  createNote,
  getExtraction,
  type NoteConflict,
} from "./note-store.js";

initializeDb();

beforeEach(async () => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  await rm(getConceptsDir(getWorkspaceDir()), { recursive: true, force: true });
});

const CONFLICT: NoteConflict = {
  existing: "Acme's ceiling is $52 a seat.",
  existingSource: "memory · acme",
  existingAt: Date.parse("2026-08-04T09:00:00Z"),
  incoming: "They'll approve at $47 a seat.",
  incomingSource: "this note",
  incomingAt: Date.parse("2026-08-21T14:22:00Z"),
};

describe("accepting a task", () => {
  test("creates a work item that remembers the note", async () => {
    const note = createNote({ body: "send the SOC 2 report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the SOC 2 report", detail: "To Dana." },
    });

    const result = await acceptExtraction(proposal.id);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;

    expect(result.refType).toBe("work_item");
    const item = getWorkItem(result.refId);
    expect(item?.title).toBe("Send the SOC 2 report");
    expect(item?.noteId).toBe(note.id);
    expect(getExtraction(proposal.id)?.state).toBe("accepted");
  });

  test("accepting twice does not create the thing twice", async () => {
    const note = createNote({ body: "send the report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the report", detail: "…" },
    });

    await acceptExtraction(proposal.id);
    const again = await acceptExtraction(proposal.id);

    expect(again.status).toBe("already_decided");
    const rows = getDb().all("SELECT id FROM work_items") as unknown[];
    expect(rows).toHaveLength(1);
  });
});

describe("accepting a memory", () => {
  test("writes the fact to a concept page", async () => {
    const note = createNote({ body: "they'll approve at $47" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: { detail: "Acme will approve at $47 a seat." },
    });

    const result = await acceptExtraction(proposal.id);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;

    const page = await readPage(getWorkspaceDir(), result.refId);
    expect(page?.body).toContain("$47");
    // Any AI-written line in memory says where it came from.
    expect(page?.body).toContain("from your note");
  });

  test("keep_both is the default and loses nothing", async () => {
    await writePage(getWorkspaceDir(), {
      slug: "acme",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Acme's ceiling is $52 a seat.\n",
    });
    const note = createNote({ body: "they'll approve at $47" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: { detail: "They'll approve at $47 a seat." },
      conflict: CONFLICT,
    });

    // No resolution passed at all — the default must be the safe one.
    const result = await acceptExtraction(proposal.id);
    expect(result.status).toBe("accepted");

    const page = await readPage(getWorkspaceDir(), "acme");
    expect(page?.body).toContain("$52");
    expect(page?.body).toContain("$47");
    expect(getExtraction(proposal.id)?.conflictResolution).toBe("keep_both");
  });

  test("replace swaps the contradicted sentence, and only it", async () => {
    await writePage(getWorkspaceDir(), {
      slug: "acme",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Acme's ceiling is $52 a seat.\nRachel signs the paper.\n",
    });
    const note = createNote({ body: "they'll approve at $47" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: { detail: "They'll approve at $47 a seat." },
      conflict: CONFLICT,
    });

    await acceptExtraction(proposal.id, { resolution: "replace" });

    const page = await readPage(getWorkspaceDir(), "acme");
    expect(page?.body).not.toContain("$52");
    expect(page?.body).toContain("$47");
    expect(page?.body).toContain("Rachel signs the paper.");
  });

  test("ignore records the decision and writes nothing", async () => {
    const note = createNote({ body: "they'll approve at $47" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: { detail: "They'll approve at $47 a seat." },
      conflict: CONFLICT,
    });

    const result = await acceptExtraction(proposal.id, {
      resolution: "ignore",
    });
    expect(result.status).toBe("dismissed");
    expect(await readPage(getWorkspaceDir(), "acme")).toBeNull();
  });
});

describe("accepting a person trait", () => {
  test("creates the contact rather than dropping the trait", async () => {
    const note = createNote({ body: "Rachel is out Thursday and Friday" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "person_trait",
      payload: {
        person: "Rachel Whitman",
        detail: "Out Thursdays and Fridays",
      },
    });

    const result = await acceptExtraction(proposal.id);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.refType).toBe("contact");
  });
});

describe("when the write fails", () => {
  test("the proposal stays proposed so the owner can try again", async () => {
    const note = createNote({ body: "something" });
    // A memory proposal carrying no text cannot be written anywhere.
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: {},
    });

    const result = await acceptExtraction(proposal.id);
    expect(result.status).toBe("failed");
    expect(getExtraction(proposal.id)?.state).toBe("proposed");
    expect(getExtraction(proposal.id)?.decidedAt).toBeNull();
  });
});

describe("dismissing", () => {
  test("writes nothing anywhere", async () => {
    const note = createNote({ body: "send the report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the report" },
    });

    const result = dismissExtraction(proposal.id);
    expect(result.status).toBe("dismissed");
    expect(getDb().all("SELECT id FROM work_items") as unknown[]).toHaveLength(
      0,
    );
    expect(getExtraction(proposal.id)?.acceptedRefId).toBeNull();
  });

  test("a dismissed proposal cannot then be accepted", async () => {
    const note = createNote({ body: "send the report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the report" },
    });
    dismissExtraction(proposal.id);

    expect((await acceptExtraction(proposal.id)).status).toBe(
      "already_decided",
    );
  });
});

describe("undo — a reversal, not a delete", () => {
  test("takes back an accepted task and reopens the proposal", async () => {
    const note = createNote({ body: "send the report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the report", detail: "…" },
    });
    const accepted = await acceptExtraction(proposal.id);
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    const undone = await undoExtraction(proposal.id);

    expect(undone.status).toBe("undone");
    expect(getWorkItem(accepted.refId)).toBeUndefined();
    // Reopened, so it can be accepted again — undo is meant to make Accept a
    // decision you do not have to be sure about.
    expect(getExtraction(proposal.id)?.state).toBe("proposed");
    expect(getExtraction(proposal.id)?.acceptedRefId).toBeNull();
  });

  test("REFUSES once Cue has started, rather than destroying the run", async () => {
    const note = createNote({ body: "send the report" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "Send the report", detail: "…" },
    });
    const accepted = await acceptExtraction(proposal.id);
    if (accepted.status !== "accepted") return;

    getDb().run(
      `UPDATE work_items SET status = 'running' WHERE id = '${accepted.refId}'`,
    );

    const undone = await undoExtraction(proposal.id);

    expect(undone.status).toBe("too_late");
    // The work survives, and the row still says accepted — because it is.
    expect(getWorkItem(accepted.refId)).toBeDefined();
    expect(getExtraction(proposal.id)?.state).toBe("accepted");
  });

  test("takes back exactly the line it wrote to memory, and nothing else", async () => {
    await writePage(getWorkspaceDir(), {
      slug: "acme",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Something somebody else wrote.\n",
    });
    const note = createNote({ body: "they'll approve at $47" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "memory",
      payload: { detail: "They'll approve at $47 a seat." },
      conflict: CONFLICT,
    });
    await acceptExtraction(proposal.id, { resolution: "keep_both" });

    await undoExtraction(proposal.id);

    const page = await readPage(getWorkspaceDir(), "acme");
    expect(page?.body).not.toContain("$47");
    // The pre-existing line is untouched: undo removes what acceptance
    // added, never what was already there.
    expect(page?.body).toContain("Something somebody else wrote.");
  });

  test("a proposal that was never accepted has nothing to undo", async () => {
    const note = createNote({ body: "x" });
    const proposal = createExtraction({
      noteId: note.id,
      kind: "task",
      payload: { title: "T" },
    });
    expect((await undoExtraction(proposal.id)).status).toBe("not_accepted");
  });
});
