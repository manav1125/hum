/**
 * The offline contract — the half of Notes that decides whether the feature
 * gets used at all.
 *
 * Notes is the most offline-critical surface in the product: lifts, planes,
 * walking, the Tube. The split the design draws is what these tests assert,
 * in both directions:
 *
 *   **Works with no signal** — writing, editing, deleting, and reading back
 *   everything already on this device.
 *   **Queues** — finding things to do, and filing to a project.
 *
 * The tests that matter most are the ones about *not losing things*: a failed
 * push must leave the queue intact, and a replayed push must not duplicate a
 * note or clobber an edit made in between. Between writing a note on a plane
 * and landing, the local store is the only copy that exists.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  _resetLocalStoreForTests,
  deleteNoteLocally,
  enqueue,
  getLocalNote,
  listLocalNotes,
  listQueue,
  mintNoteId,
  mirrorServerNotes,
  saveNoteLocally,
  type LocalNote,
} from "@/stores/note-local-store";
import type { Note } from "@/types/notes";

/**
 * Every push is stubbed at the SDK seam and records what it was asked to do,
 * so a drain can be driven through failure and recovery without a daemon.
 * Only the four functions the sync worker calls are overridden; the rest of
 * the module stays real (see assistant/CLAUDE.md on exhaustive factories).
 */
const sdkActual = await import("@/generated/daemon/sdk.gen");

interface Call {
  op: string;
  id?: string;
}
const calls: Call[] = [];
let failNext = false;

function stub(op: string) {
  return async (options: {
    path?: { id?: string };
    body?: { id?: string };
  }) => {
    calls.push({ op, id: options.path?.id ?? options.body?.id });
    if (failNext) return { error: "offline" };
    return { data: {} };
  };
}

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  notesPost: stub("create"),
  notesByIdPatch: stub("update"),
  notesByIdDelete: stub("delete"),
  notesByIdReadPost: stub("read"),
}));

// Imported AFTER the mock so it binds the stubs.
const { drainQueue } = await import("@/stores/note-sync");

function localNote(over: Partial<LocalNote> = {}): LocalNote {
  const now = Date.now();
  return {
    id: mintNoteId(),
    title: "Walking to the office",
    body: "Don't lead with price. Lead with the migration support.",
    source: "typed",
    sourceDetail: null,
    projectId: null,
    audioPath: null,
    audioDurationMs: null,
    transcript: null,
    bodyIsSummary: false,
    extractionState: "idle",
    lastReadHash: null,
    lastReadAt: null,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    pending: true,
    ...over,
  };
}

beforeEach(async () => {
  await _resetLocalStoreForTests();
  calls.length = 0;
  failNext = false;
});

afterEach(async () => {
  await _resetLocalStoreForTests();
});

describe("capture with no signal", () => {
  test("a note is durable on this device before anything is pushed", async () => {
    const note = localNote();
    await saveNoteLocally(note);

    // No drain has run. The note exists anyway — that is the contract behind
    // printing "your note is saved".
    expect(calls).toEqual([]);
    expect((await getLocalNote(note.id))?.body).toBe(note.body);
  });

  test("it keeps the id it was minted with", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: Date.now() });

    await drainQueue("asst-1");
    expect(calls).toEqual([{ op: "create", id: note.id }]);
  });

  test("reading back everything already here needs no network", async () => {
    await saveNoteLocally(localNote({ occurredAt: 1 }));
    await saveNoteLocally(localNote({ occurredAt: 3 }));
    await saveNoteLocally(localNote({ occurredAt: 2 }));

    const notes = await listLocalNotes();
    expect(notes.map((n) => n.occurredAt)).toEqual([3, 2, 1]);
    expect(calls).toEqual([]);
  });
});

describe("the queue survives a failed push", () => {
  test("a drain that fails leaves the queue exactly as it was", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: Date.now() });

    failNext = true;
    const result = await drainQueue("asst-1");

    expect(result).toEqual({ pushed: 0, remaining: 1 });
    // The note that was hardest to capture is exactly the one a cleared queue
    // would lose.
    expect(await listQueue()).toHaveLength(1);
    expect((await getLocalNote(note.id))?.pending).toBe(true);
  });

  test("it drains once the connection is back", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: Date.now() });

    failNext = true;
    await drainQueue("asst-1");
    failNext = false;
    const result = await drainQueue("asst-1");

    expect(result).toEqual({ pushed: 1, remaining: 0 });
    expect(await listQueue()).toEqual([]);
    expect((await getLocalNote(note.id))?.pending).toBe(false);
  });

  test("it stops at the first failure rather than hammering a dead network", async () => {
    for (let i = 0; i < 3; i += 1) {
      const note = localNote();
      await saveNoteLocally(note);
      await enqueue({ op: "create", noteId: note.id, at: Date.now() + i });
    }

    failNext = true;
    await drainQueue("asst-1");

    // One attempt, not three. There is no retry loop here by design.
    expect(calls).toHaveLength(1);
  });
});

describe("ordering and idempotency", () => {
  test("operations replay oldest first, so an update never precedes its create", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: 1 });
    await enqueue({ op: "update", noteId: note.id, at: 2 });

    await drainQueue("asst-1");
    expect(calls.map((c) => c.op)).toEqual(["create", "update"]);
  });

  test("a create for a note already deleted locally is skipped, not resurrected", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: 1 });
    await enqueue({ op: "delete", noteId: note.id, at: 2 });
    await deleteNoteLocally(note.id);

    await drainQueue("asst-1");

    // The create finds nothing locally and is dropped; only the delete is
    // pushed. Pushing the create would put a thrown-away thought back.
    expect(calls.map((c) => c.op)).toEqual(["delete"]);
  });

  test("a replayed drain does not duplicate — the id makes the push idempotent", async () => {
    const note = localNote();
    await saveNoteLocally(note);
    await enqueue({ op: "create", noteId: note.id, at: 1 });

    await drainQueue("asst-1");
    await drainQueue("asst-1");

    // Only one push, because the queue was cleared on success. Even if it had
    // replayed, the daemon resolves the same id to the same row.
    expect(calls).toHaveLength(1);
  });
});

describe("mirroring the daemon's copy", () => {
  const serverNote = (over: Partial<Note> = {}): Note =>
    ({ ...localNote(), ...over }) as Note;

  test("a fetched note lands locally so the next offline read has it", async () => {
    const note = serverNote();
    await mirrorServerNotes([note]);

    const local = await getLocalNote(note.id);
    expect(local?.pending).toBe(false);
  });

  test("REGRESSION: it must not overwrite an unsent local edit", async () => {
    // The failure this guards: sync silently undoing the last thing someone
    // typed, because a stale server row arrived after their edit.
    const note = localNote({ body: "what I just typed", pending: true });
    await saveNoteLocally(note);

    await mirrorServerNotes([
      { ...note, body: "the old server copy", pending: false } as Note,
    ]);

    expect((await getLocalNote(note.id))?.body).toBe("what I just typed");
  });
});
