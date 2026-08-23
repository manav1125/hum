/**
 * Voice notes — and the one thing a recorded note must never do.
 *
 * **Launder a summary as a transcript.** What was said and what Cue made of
 * it are two artefacts; collapsing them is how somebody ends up quoting a
 * sentence to a colleague that nobody actually said. So the tests here are
 * mostly about which column holds what, and about `bodyIsSummary` being right
 * in BOTH directions — a transcript labelled a summary is the same lie
 * pointing the other way.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { alignSummaryToTranscript } from "./note-voice.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM note_extractions");
  getDb().run("DELETE FROM notes");
});

describe("alignSummaryToTranscript", () => {
  const TRANSCRIPT =
    "so the migration is the real objection here not the price at all " +
    "and then rachel said she needs the redlines before she can sign anything";

  test("locates a sentence in the first half of the recording", () => {
    const [first] = alignSummaryToTranscript(
      "Migration is the real objection.",
      TRANSCRIPT,
      60_000,
    );
    expect(first?.atMs).not.toBeNull();
    expect(first!.atMs!).toBeLessThan(30_000);
  });

  test("locates a later sentence later", () => {
    const sentences = alignSummaryToTranscript(
      "Migration is the objection. Rachel needs the redlines.",
      TRANSCRIPT,
      60_000,
    );
    expect(sentences).toHaveLength(2);
    expect(sentences[1]!.atMs!).toBeGreaterThan(sentences[0]!.atMs!);
  });

  test("HONEST: a sentence it cannot locate gets null, never a guess", () => {
    // A link that plays the wrong moment defeats the entire point of being
    // able to check the summary against its source.
    const [only] = alignSummaryToTranscript(
      "Something about kangaroos entirely.",
      TRANSCRIPT,
      60_000,
    );
    expect(only?.atMs).toBeNull();
  });

  test("no duration means nothing is tappable, rather than everything at 0", () => {
    const sentences = alignSummaryToTranscript(
      "Migration is the objection.",
      TRANSCRIPT,
      null,
    );
    expect(sentences[0]?.atMs).toBeNull();
  });

  test("an empty transcript yields sentences with no moments", () => {
    const sentences = alignSummaryToTranscript("A claim.", "", 60_000);
    expect(sentences).toEqual([{ text: "A claim.", atMs: null }]);
  });
});
