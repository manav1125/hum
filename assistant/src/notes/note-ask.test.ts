/**
 * Ask — the citation rule, which is the only thing here that can be dishonest.
 *
 * "An unsourced sentence never renders" is enforced on the model's output in
 * code rather than requested in the prompt, because a prompt instruction is a
 * hope and this is a guarantee. These tests are that guarantee: they drive
 * the real stripper with the shapes a model actually produces — a sentence
 * with no marker, a marker pointing at evidence that does not exist, an
 * answer that is entirely uncited.
 *
 * The consequence is deliberate and worth stating: a TRUE sentence the model
 * forgot to cite gets deleted. That is the right way to be wrong. A missing
 * sentence is a smaller failure than a confident unsourced one in a product
 * whose whole pitch is that it does not make things up.
 */

import { describe, expect, test } from "bun:test";

import { splitSentences, stripUnsourcedSentences } from "./note-ask.js";

const valid = (...ns: number[]) => new Set(ns);

describe("splitSentences", () => {
  test("splits on terminators and keeps them", () => {
    expect(splitSentences("One thing [1]. Another [2].")).toEqual([
      "One thing [1].",
      "Another [2].",
    ]);
  });

  test("blank input yields nothing rather than one empty sentence", () => {
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});

describe("stripUnsourcedSentences", () => {
  test("keeps a sentence that cites real evidence", () => {
    const out = stripUnsourcedSentences(
      "They approve at $47 a seat [1].",
      valid(1, 2),
    );
    expect(out).toBe("They approve at $47 a seat [1].");
  });

  test("deletes a sentence with no citation at all", () => {
    const out = stripUnsourcedSentences(
      "They approve at $47 a seat [1]. They also seem keen on the migration.",
      valid(1),
    );
    expect(out).toBe("They approve at $47 a seat [1].");
  });

  test("deletes a sentence citing evidence that does not exist", () => {
    // A fabricated citation is worse than none: the number makes it read as
    // MORE trustworthy than an uncited claim, not less.
    const out = stripUnsourcedSentences(
      "They approve at $47 [1]. Rachel signs on Wednesday [9].",
      valid(1, 2),
    );
    expect(out).toBe("They approve at $47 [1].");
  });

  test("keeps a sentence citing several real sources", () => {
    const out = stripUnsourcedSentences("Both agree [1][2].", valid(1, 2));
    expect(out).toBe("Both agree [1][2].");
  });

  test("drops the whole answer when nothing in it is sourced", () => {
    // The caller turns this into `nothing_found`: there is no honest way to
    // render an answer whose every claim was invented.
    expect(stripUnsourcedSentences("It all looks fine to me.", valid(1))).toBe(
      "",
    );
  });

  test("a lead-in ending in a colon is structure, not a claim", () => {
    const out = stripUnsourcedSentences(
      "Four things, and two aren't done: They approve at $47 [1].",
      valid(1),
    );
    expect(out).toContain("Four things");
    expect(out).toContain("$47 [1]");
  });

  test("MUTATION CHECK: a citation to 0 is not treated as valid", () => {
    expect(stripUnsourcedSentences("Something [0].", valid(1))).toBe("");
  });
});
