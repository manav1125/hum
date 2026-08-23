/**
 * Inbound capture — and the one restraint that keeps it safe.
 *
 * **An arrival becomes a note, never a task.** Without that, a wearable that
 * hears six hours of someone's day turns straight into work items they never
 * agreed to — the silent-write problem, at volume, from a device they are
 * not even looking at. As a note it obeys acceptance like anything typed.
 *
 * The other thing worth asserting is the summary label. Halo and meeting
 * captures arrive as Cue's prose over someone's speech, and prose that is not
 * labelled a summary reads as a quote — which puts words in people's mouths.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { arrivalProvenance, landArrivalAsNote } from "./note-arrivals.js";
import { listExtractionsForNote } from "./note-store.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM note_extractions");
  db.run("DELETE FROM notes");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
});

describe("an arrival becomes a note, never a task", () => {
  test("Halo lands as an unfiled note with nothing proposed", () => {
    const note = landArrivalAsNote({
      channel: "halo",
      title: "Kitchen conversation about the Q4 plan",
      body: "Two people, six minutes. Hiring came up twice.",
    });

    expect(note).not.toBeNull();
    expect(note?.source).toBe("arrival");
    expect(note?.sourceDetail).toBe("halo");
    // Nothing filed, nothing proposed, nothing in HQ. The owner decides.
    expect(note?.projectId).toBeNull();
    expect(note?.extractionState).toBe("idle");
    expect(listExtractionsForNote(note!.id)).toEqual([]);
    expect(getDb().all("SELECT id FROM work_items") as unknown[]).toHaveLength(
      0,
    );
  });

  test("so does a forwarded email and a meeting capture", () => {
    for (const channel of ["email", "meeting"] as const) {
      const note = landArrivalAsNote({
        channel,
        title: "Tooling quote",
        body: "Shenzhen is six weeks and cheapest.",
      });
      expect(note?.source).toBe("arrival");
      expect(note?.sourceDetail).toBe(channel);
    }
    expect(getDb().all("SELECT id FROM work_items") as unknown[]).toHaveLength(
      0,
    );
  });
});

describe("what it says about itself", () => {
  test("Cue's prose over someone's speech is labelled a summary", () => {
    // Prose that is not labelled a summary reads as a quote, which puts words
    // in people's mouths.
    expect(
      landArrivalAsNote({
        channel: "halo",
        title: "Kitchen conversation",
        body: "Hiring came up twice.",
      })?.bodyIsSummary,
    ).toBe(true);

    expect(
      landArrivalAsNote({
        channel: "meeting",
        title: "Weekly sync",
        body: "Six action items, four already yours.",
      })?.bodyIsSummary,
    ).toBe(true);
  });

  test("a forwarded email is the sender's own words, not a summary", () => {
    expect(
      landArrivalAsNote({
        channel: "email",
        title: "Tooling quote",
        body: "Shenzhen is six weeks and cheapest.",
      })?.bodyIsSummary,
    ).toBe(false);
  });

  test("an explicit flag still wins over the channel default", () => {
    expect(
      landArrivalAsNote({
        channel: "halo",
        title: "Verbatim",
        body: "exactly what was said",
        bodyIsSummary: false,
      })?.bodyIsSummary,
    ).toBe(false);
  });

  test("audio is recorded as local, and says so on the card", () => {
    const note = landArrivalAsNote({
      channel: "halo",
      title: "Kitchen conversation",
      body: "Hiring came up twice.",
      audioPath: "/local/halo/0914.m4a",
      audioDurationMs: 360_000,
    });
    expect(note?.audioPath).toBe("/local/halo/0914.m4a");
    expect(arrivalProvenance("halo", true)).toBe("from Halo · audio on device");
    expect(arrivalProvenance("email", false)).toContain("notes@");
  });
});

describe("when it happened", () => {
  test("the note dates from the conversation, not from the sync", () => {
    // A kitchen conversation at 09:14 that syncs at 18:00 belongs at 09:14,
    // or the day reads out of order.
    const when = Date.parse("2026-08-21T09:14:00Z");
    const note = landArrivalAsNote({
      channel: "halo",
      title: "Kitchen conversation",
      body: "Hiring came up twice.",
      occurredAt: when,
    });
    expect(note?.occurredAt).toBe(when);
  });
});

describe("it never takes down its caller", () => {
  test("an empty capture is dropped rather than saved blank", () => {
    expect(
      landArrivalAsNote({ channel: "halo", title: "Silence", body: "   " }),
    ).toBeNull();
  });

  test("a missing title still produces a usable card", () => {
    const note = landArrivalAsNote({
      channel: "halo",
      title: "",
      body: "Hiring came up twice.",
    });
    expect(note?.title).toBe("Untitled note");
  });
});
