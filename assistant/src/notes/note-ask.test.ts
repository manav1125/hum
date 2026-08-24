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

import {
  matchesOpenWorkItem,
  splitAskBlocks,
  splitSentences,
  stripUnsourcedSentences,
} from "./note-ask.js";

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

/**
 * R2's two additions ride on the same model call, which means the only thing
 * standing between a good answer and a mangled one is this parser.
 */
describe("splitAskBlocks", () => {
  const REPLY = [
    "You owe Acme four things [1]. The SOC 2 report has been asked for twice [2].",
    "",
    "COMMITMENTS",
    "· Send Dana the SOC 2 report",
    "· Get the redlines back to Rachel",
    "",
    "FOLLOW-UPS",
    "· What changed since March?",
    "· Who else knows about the migration promise?",
  ].join("\n");

  test("the prose never carries its own scaffolding", () => {
    const out = splitAskBlocks(REPLY);
    expect(out.prose).toContain("You owe Acme four things [1].");
    expect(out.prose).not.toContain("COMMITMENTS");
    expect(out.prose).not.toContain("FOLLOW-UPS");
    expect(out.prose).not.toContain("Send Dana");
  });

  test("bullets are read as lines, markers stripped", () => {
    expect(splitAskBlocks(REPLY).commitments).toEqual([
      "Send Dana the SOC 2 report",
      "Get the redlines back to Rachel",
    ]);
  });

  test("follow-ups are capped at three however many arrive", () => {
    const many = "FOLLOW-UPS\n· a?\n· b?\n· c?\n· d?\n· e?";
    expect(splitAskBlocks(many).followUps).toHaveLength(3);
  });

  test("an answer with no blocks is left exactly as it was", () => {
    const plain = "Just the answer [1].";
    expect(splitAskBlocks(plain)).toEqual({
      prose: plain,
      commitments: [],
      followUps: [],
    });
  });

  test("either block alone still parses", () => {
    const only = "Answer [1].\n\nFOLLOW-UPS\n· what next?";
    const out = splitAskBlocks(only);
    expect(out.prose).toBe("Answer [1].");
    expect(out.commitments).toEqual([]);
    expect(out.followUps).toEqual(["what next?"]);
  });
});

/**
 * The match decides whether something reads as "already tracked". A false
 * positive HIDES something the owner still owes, so the bias is toward
 * saying no.
 */
describe("matchesOpenWorkItem", () => {
  test("the same commitment worded differently still matches", () => {
    expect(
      matchesOpenWorkItem("Send the SOC 2 report", [
        "Send Dana the SOC 2 report",
      ]),
    ).toBe(true);
  });

  test("a different errand with shared filler words does not", () => {
    expect(
      matchesOpenWorkItem("Send the SOC 2 report", ["Send the invoice"]),
    ).toBe(false);
  });

  test("nothing open means nothing matches", () => {
    expect(matchesOpenWorkItem("Send the report", [])).toBe(false);
  });

  test("a title of only filler words never claims a match", () => {
    expect(matchesOpenWorkItem("the and for", ["Send the report"])).toBe(false);
  });
});
