/**
 * Tidying — the place the design diverges hardest from Mem.
 *
 * An assistant that silently rewrites what you typed makes the note
 * untrustworthy as a record of what you actually thought, which is the only
 * reason to keep notes at all. So the tests here are about the two ways that
 * could happen anyway:
 *
 *  · a "tidy" that quietly became a rewrite, and
 *  · an accepted tidy that left the original unrecoverable.
 *
 * The second is the subtle one. "The original is always recoverable, even
 * after you accept" is a promise that has to survive the session it was made
 * in — an undo that only works until you close the note is not the promise.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createNote, getNote } from "./note-store.js";
import {
  _setNoteTidyOverridesForTests,
  applyTidy,
  looksLikeRewrite,
  proposeTidy,
} from "./note-tidy.js";

initializeDb();

const SHORTHAND =
  "dana call — wants 24mo but pushed back on 52, said procurement ok at 47 if loyalty disc holds. rachel needs redlines b4 signoff, out thu+fri.";

const TIDIED =
  "Dana wants a 24-month term but pushed back on $52 a seat — procurement will approve at $47 if the loyalty discount holds. Rachel needs the redlines before sign-off; she's out Thursday and Friday.";

beforeEach(() => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
  _setNoteTidyOverridesForTests({});
});

describe("looksLikeRewrite", () => {
  test("expanding the owner's own shorthand is a tidy, not a rewrite", () => {
    // "thu+fri" → "Thursday and Friday" legitimately grows the text.
    expect(looksLikeRewrite(SHORTHAND, TIDIED)).toBe(false);
  });

  test("a result that ballooned added something", () => {
    expect(looksLikeRewrite("short note", "x".repeat(500))).toBe(true);
  });

  test("a result that collapsed dropped something", () => {
    expect(looksLikeRewrite("a".repeat(200), "tiny")).toBe(true);
  });
});

describe("proposeTidy", () => {
  test("returns BOTH texts and writes nothing", async () => {
    _setNoteTidyOverridesForTests({ tidy: async () => TIDIED });
    const note = createNote({ body: SHORTHAND });

    const result = await proposeTidy(note.id);

    expect(result.status).toBe("tidied");
    if (result.status !== "tidied") return;
    expect(result.original).toBe(SHORTHAND);
    expect(result.tidied).toBe(TIDIED);
    // Untouched until the owner chooses — that is what a diff is FOR.
    expect(getNote(note.id)?.body).toBe(SHORTHAND);
  });

  test("REFUSES a result that is a rewrite, and keeps the owner's words", async () => {
    _setNoteTidyOverridesForTests({
      tidy: async () => "Completely different, much longer text. ".repeat(20),
    });
    const note = createNote({ body: SHORTHAND });

    expect((await proposeTidy(note.id)).status).toBe("refused");
    expect(getNote(note.id)?.body).toBe(SHORTHAND);
  });

  test("a failed request is not a refusal — they mean different things", async () => {
    _setNoteTidyOverridesForTests({ tidy: async () => null });
    const note = createNote({ body: SHORTHAND });
    expect((await proposeTidy(note.id)).status).toBe("failed");
  });
});

describe("applyTidy", () => {
  test("keep_mine writes nothing at all", () => {
    const note = createNote({ body: SHORTHAND });
    applyTidy(note.id, "keep_mine", TIDIED);
    expect(getNote(note.id)?.body).toBe(SHORTHAND);
    expect(getNote(note.id)?.bodyIsSummary).toBe(false);
  });

  test("THE PROMISE: use_tidied keeps the original recoverable", () => {
    // "Your original is always recoverable, even after you accept." An undo
    // that only works until you close the note is not that promise.
    const note = createNote({ body: SHORTHAND });
    applyTidy(note.id, "use_tidied", TIDIED);

    const after = getNote(note.id);
    expect(after?.body).toBe(TIDIED);
    expect(after?.transcript).toBe(SHORTHAND);
  });

  test("an accepted tidy is labelled as Cue's words", () => {
    const note = createNote({ body: SHORTHAND });
    applyTidy(note.id, "use_tidied", TIDIED);
    // The same rule that stops a voice summary being read as a transcript.
    expect(getNote(note.id)?.bodyIsSummary).toBe(true);
  });

  test("use_tidied never overwrites a voice note's real transcript", () => {
    const note = createNote({
      body: SHORTHAND,
      transcript: "what was actually said out loud",
    });
    applyTidy(note.id, "use_tidied", TIDIED);
    expect(getNote(note.id)?.transcript).toBe(
      "what was actually said out loud",
    );
  });

  test("keep_both keeps the owner's words first", () => {
    const note = createNote({ body: SHORTHAND });
    applyTidy(note.id, "keep_both", TIDIED);

    const body = getNote(note.id)?.body ?? "";
    expect(body.indexOf(SHORTHAND)).toBeLessThan(body.indexOf(TIDIED));
    expect(body).toContain("Tidied by Cue");
  });
});
