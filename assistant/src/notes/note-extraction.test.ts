/**
 * The read path: what it costs, what it proposes, and — the part worth the
 * most tests — the two zero-result outcomes that must never become one.
 *
 * "Nothing to file here" and "I couldn't read this one just now" are
 * different sentences to a person: one is about the note, the other about
 * the request. Collapsing them tells someone their writing might be gone
 * when it isn't, which is the single worst thing this feature could say.
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
import {
  _setNoteExtractionOverridesForTests,
  type ExtractedItem,
  hasExtractableSignal,
  parseExtractionResponse,
  readNote,
} from "./note-extraction.js";
import {
  createNote,
  getNote,
  listExtractionsForNote,
  updateNote,
} from "./note-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
  _setNoteExtractionOverridesForTests({});
});

const item = (over: Partial<ExtractedItem> = {}): ExtractedItem => ({
  kind: "task",
  confidenceTier: "confident",
  reason: null,
  payload: { title: "Send the SOC 2 report", detail: "…", dueAt: null },
  ...over,
});

describe("hasExtractableSignal", () => {
  test("reflection costs nothing — no signal, no model call", () => {
    expect(
      hasExtractableSignal(
        "Been thinking about how the team feels lately. Something is off.",
      ),
    ).toBe(false);
  });

  test("catches the grammar of a note to yourself, not just an inbound ask", () => {
    expect(hasExtractableSignal("decide the vendor by Friday")).toBe(true);
    expect(hasExtractableSignal("don't forget the redlines")).toBe(true);
    expect(hasExtractableSignal("they'll approve at $47")).toBe(true);
  });

  test("a fragment too short to carry a commitment is skipped", () => {
    expect(hasExtractableSignal("send")).toBe(false);
  });
});

describe("parseExtractionResponse", () => {
  test("no JSON array at all is a FAILURE, not an empty result", () => {
    expect(parseExtractionResponse("I'm sorry, I can't do that")).toBeNull();
  });

  test("an empty array is a successful read that found nothing", () => {
    expect(parseExtractionResponse("[]")).toEqual([]);
  });

  test("an unsure item with no reason is dropped, not shown bare", () => {
    const parsed = parseExtractionResponse(
      '[{"kind":"task","sure":false,"title":"Maybe call them","detail":"…"}]',
    );
    expect(parsed).toEqual([]);
  });

  test("an unsure item keeps its plain-words reason and its tier", () => {
    const parsed = parseExtractionResponse(
      '[{"kind":"task","sure":false,"reason":"you wrote \\"maybe\\"","title":"Call them","detail":"…"}]',
    );
    expect(parsed?.[0]).toMatchObject({
      confidenceTier: "unsure",
      reason: 'you wrote "maybe"',
    });
  });

  test("a person_trait with no person named is dropped", () => {
    const parsed = parseExtractionResponse(
      '[{"kind":"person_trait","sure":true,"detail":"prefers mornings"}]',
    );
    expect(parsed).toEqual([]);
  });

  test("a past deadline is nulled rather than proposed", () => {
    const now = Date.parse("2026-08-21T10:00:00Z");
    const parsed = parseExtractionResponse(
      '[{"kind":"task","sure":true,"title":"Send it","detail":"…","dueAtIso":"2020-01-01T17:00"}]',
      now,
    );
    expect(parsed?.[0]?.payload.dueAt).toBeNull();
  });

  test("unknown kinds are dropped rather than guessed at", () => {
    const parsed = parseExtractionResponse(
      '[{"kind":"invoice","sure":true,"title":"x","detail":"y"}]',
    );
    expect(parsed).toEqual([]);
  });
});

describe("readNote", () => {
  test("unchanged text is never re-read", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [item()],
    });
    const note = createNote({ body: "decide the vendor by Friday" });

    const first = await readNote(note.id);
    expect(first.status).toBe("done");

    const second = await readNote(note.id);
    expect(second).toEqual({ status: "skipped", reason: "unchanged" });
  });

  test("force re-reads it anyway — that is the 'find things to do' action", async () => {
    let calls = 0;
    _setNoteExtractionOverridesForTests({
      extractor: async () => {
        calls += 1;
        return [item()];
      },
    });
    const note = createNote({ body: "decide the vendor by Friday" });

    await readNote(note.id);
    await readNote(note.id, { force: true });
    expect(calls).toBe(2);
  });

  test("no signal is a real, successful, free read that found nothing", async () => {
    let called = false;
    _setNoteExtractionOverridesForTests({
      extractor: async () => {
        called = true;
        return [item()];
      },
    });
    const note = createNote({ body: "Thinking about the team lately." });

    const outcome = await readNote(note.id);
    expect(outcome).toEqual({ status: "done", proposals: [] });
    expect(called).toBe(false);
    expect(getNote(note.id)?.extractionState).toBe("done");
  });

  test("a failed request is NOT 'nothing to file', and does not mark the text read", async () => {
    _setNoteExtractionOverridesForTests({ extractor: async () => null });
    const note = createNote({ body: "decide the vendor by Friday" });

    const outcome = await readNote(note.id);
    expect(outcome).toEqual({ status: "failed" });

    const after = getNote(note.id);
    expect(after?.extractionState).toBe("failed");
    // If a failed read stamped the hash, "Try again" would be a no-op.
    expect(after?.lastReadHash).toBeNull();
  });

  test("try-again after a failure actually re-reads", async () => {
    _setNoteExtractionOverridesForTests({ extractor: async () => null });
    const note = createNote({ body: "decide the vendor by Friday" });
    await readNote(note.id);

    _setNoteExtractionOverridesForTests({ extractor: async () => [item()] });
    const retry = await readNote(note.id);
    expect(retry.status).toBe("done");
    expect(listExtractionsForNote(note.id)).toHaveLength(1);
  });

  test("proposes — and writes nothing but proposals", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [item(), item({ kind: "memory" })],
    });
    const note = createNote({ body: "decide the vendor by Friday" });
    await readNote(note.id);

    const proposals = listExtractionsForNote(note.id);
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.state === "proposed")).toBe(true);
    expect(proposals.every((p) => p.acceptedRefId === null)).toBe(true);
  });

  test("re-reading an edited note does not stack duplicate findings", async () => {
    _setNoteExtractionOverridesForTests({
      extractor: async () => [item()],
    });
    const note = createNote({ body: "decide the vendor by Friday" });
    await readNote(note.id);

    updateNote(note.id, { body: "decide the vendor by Friday, seriously" });
    await readNote(note.id);

    expect(listExtractionsForNote(note.id)).toHaveLength(1);
  });

  test("a missing note is skipped, never an error", async () => {
    expect(await readNote("nope")).toEqual({
      status: "skipped",
      reason: "missing",
    });
  });
});
