/**
 * Library search's uploads section — the sentences, and the states behind them.
 *
 * The rules under test are the chats index's, reused rather than reinvented:
 * a count prints only when provably whole, a capped set says so, and an outage
 * degrades to a stated bound instead of an empty state that means something
 * else. The one addition is the constraint this section could not have met by
 * copying: with no local uploads to fall back on, "no uploads match" and "I
 * couldn't search uploads" must be different sentences, and the type must not
 * let a surface confuse them.
 *
 * Every guard here is mutation-checked in the accompanying run — see the task
 * report; the assertions are written so that softening the rule breaks them.
 */
import { describe, expect, test } from "bun:test";

import {
  combinedEmptyNote,
  hasUploadSection,
  UPLOAD_SEARCH_LIMIT,
  UPLOADS_SECTION_LABEL,
  uploadsFailureNote,
  uploadsScopeNote,
  type UploadHit,
  type UploadSearchState,
} from "./library-search";

function hit(id: string, filename: string): UploadHit {
  return {
    id,
    original_filename: filename,
    mime_type: "application/pdf",
    size_bytes: 10,
    kind: "document",
    created_at: 1_770_000_000_000,
    thumbnail_base64: null,
    sourceConversation: { id: `c-${id}`, title: "Contract review" },
  } as UploadHit;
}

function whole(rows: UploadHit[], truncated = false): UploadSearchState {
  return { status: "whole", query: "acme", rows, truncated };
}

describe("the section is design's, verbatim", () => {
  test("the heading names the promise it keeps", () => {
    expect(UPLOADS_SECTION_LABEL).toBe("Things you sent · in their chats");
  });
});

// ---------------------------------------------------------------------------
// A count only when it is provably whole
// ---------------------------------------------------------------------------

describe("never a fake number", () => {
  test("a whole answer may print its count", () => {
    expect(uploadsScopeNote(whole([hit("a", "acme.pdf")]))).toBe(
      "1 thing you sent, in its chat.",
    );
    expect(
      uploadsScopeNote(whole([hit("a", "a.pdf"), hit("b", "b.pdf")])),
    ).toBe("2 things you sent, in their chats.");
  });

  test("a capped answer says so instead of printing a total", () => {
    const rows = Array.from({ length: UPLOAD_SEARCH_LIMIT }, (_, i) =>
      hit(`u${i}`, `report-${i}.pdf`),
    );
    const note = uploadsScopeNote(whole(rows, true))!;

    expect(note).toBe(
      `Showing the ${UPLOAD_SEARCH_LIMIT} most recent — there are more.`,
    );
    // The defect this exists to prevent: the page size printed as a total.
    expect(note).not.toMatch(/\d+ things you sent/);
  });

  test("an in-flight search prints no number at all", () => {
    const note = uploadsScopeNote({ status: "searching", query: "acme" })!;
    expect(note).toBe("Looking through what you sent…");
    expect(note).not.toMatch(/\d/);
  });

  test("a failed search never prints a number", () => {
    const note = uploadsScopeNote({
      status: "failed",
      query: "acme",
      note: uploadsFailureNote({ kind: "error", httpStatus: 500 }),
    })!;
    expect(note).toMatch(/couldn't search/);
    // The status code is the only digit allowed — it is a fact about the
    // failure, not a count of anything.
    expect(note.replace("500", "")).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// "None" and "couldn't" are different sentences
// ---------------------------------------------------------------------------

describe("an empty state distinguishes none from couldn't", () => {
  test("no uploads match — the search happened, and found nothing", () => {
    const note = combinedEmptyNote("acme", whole([]));
    expect(note).toContain("what you sent it");
    expect(note).not.toMatch(/couldn't/);
  });

  test("uploads could not be searched — the answer is admitted incomplete", () => {
    const note = combinedEmptyNote("acme", {
      status: "failed",
      query: "acme",
      note: uploadsFailureNote({ kind: "error" }),
    });
    expect(note).toMatch(/couldn't search the things you sent/);
    // The load-bearing clause: without it, an outage reads as an answer.
    expect(note).toContain("isn't the whole answer");
  });

  test("still searching is neither of the above", () => {
    const note = combinedEmptyNote("acme", {
      status: "searching",
      query: "acme",
    });
    expect(note).toMatch(/still looking/i);
    expect(note).not.toMatch(/couldn't/);
  });

  test("the three empty sentences are all different", () => {
    const none = combinedEmptyNote("acme", whole([]));
    const failed = combinedEmptyNote("acme", {
      status: "failed",
      query: "acme",
      note: uploadsFailureNote({ kind: "error" }),
    });
    const searching = combinedEmptyNote("acme", {
      status: "searching",
      query: "acme",
    });
    expect(new Set([none, failed, searching]).size).toBe(3);
  });

  test("a disconnected client says that, rather than blaming the index", () => {
    expect(uploadsFailureNote({ kind: "unavailable" })).toMatch(
      /not connected to your Cue/,
    );
  });

  test("the failure note reassures that nothing was lost", () => {
    expect(uploadsFailureNote({ kind: "error" })).toContain(
      "still in their chats",
    );
  });
});

// ---------------------------------------------------------------------------
// What reaches the screen
// ---------------------------------------------------------------------------

describe("when the section renders", () => {
  test("an idle search renders nothing", () => {
    expect(hasUploadSection({ status: "idle" })).toBe(false);
    expect(uploadsScopeNote({ status: "idle" })).toBeNull();
  });

  test("a search with no upload hits renders nothing", () => {
    // The main results' own empty state covers this case; a heading over zero
    // rows would be noise.
    expect(hasUploadSection(whole([]))).toBe(false);
  });

  test("a FAILED search still renders — silence would read as 'none'", () => {
    expect(
      hasUploadSection({
        status: "failed",
        query: "acme",
        note: uploadsFailureNote({ kind: "error" }),
      }),
    ).toBe(true);
  });

  test("an in-flight search renders, so the section does not pop in late", () => {
    expect(hasUploadSection({ status: "searching", query: "acme" })).toBe(true);
  });

  test("hits render", () => {
    expect(hasUploadSection(whole([hit("a", "acme.pdf")]))).toBe(true);
  });
});
