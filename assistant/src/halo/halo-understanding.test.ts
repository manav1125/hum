/**
 * Understanding, and the one thing it is not allowed to do.
 *
 * The episode page's most convincing element is a sentence somebody actually
 * said. That is also the easiest thing for a model to quietly paraphrase, so
 * most of these tests are about the quote check: an unverifiable quote is
 * dropped rather than shown, and the page survives without one.
 */
import { describe, expect, test } from "bun:test";

import { isVerbatim, normaliseUnderstanding } from "./halo-understanding.js";

const TRANSCRIPT = [
  "Dana: So where did legal land on the term?",
  "You: Rachel cleared it yesterday. It's the price that's open.",
  "Dana: If the floor holds at 47, I can take 24 months to my side this week.",
  "You: I'll get you the one-pager before Thursday.",
].join("\n");

describe("isVerbatim", () => {
  test("accepts a real sentence regardless of case and punctuation", () => {
    expect(
      isVerbatim("If the floor holds at 47, I can take 24 months", TRANSCRIPT),
    ).toBe(true);
    expect(
      isVerbatim(
        "if the floor holds at 47 — I can take 24 months!",
        TRANSCRIPT,
      ),
    ).toBe(true);
  });

  test("rejects a plausible paraphrase", () => {
    // This is exactly what a model produces when asked for "the best quote".
    expect(
      isVerbatim("If the floor stays at 47, she can do 24 months", TRANSCRIPT),
    ).toBe(false);
  });

  test("rejects a fragment too short to be evidence of anything", () => {
    expect(isVerbatim("the", TRANSCRIPT)).toBe(false);
  });
});

describe("normaliseUnderstanding", () => {
  const good = {
    title: "Acme landed on 24 months",
    summary: "The floor held at $47 and Dana takes 24 months to her side.",
    pull_quote:
      "If the floor holds at 47, I can take 24 months to my side this week.",
    pull_quote_speaker: "Dana",
    key_takeaways: [
      { label: "Price", value: "floor holds at $47/seat" },
      { label: "Term", value: "24 months" },
    ],
    participants: ["Dana"],
    proposals: [
      {
        title: "Send the one-pager to Dana by Thursday",
        owner: null,
        verb: "file",
        destination_label: "Renew Acme",
        heard_quote: "I'll get you the one-pager before Thursday",
        heard_speaker: "You",
      },
    ],
  };

  test("keeps a real quote, its speaker, and the takeaways block", () => {
    const u = normaliseUnderstanding(good, TRANSCRIPT);
    expect(u.title).toBe("Acme landed on 24 months");
    expect(u.pullQuote).toContain("floor holds at 47");
    expect(u.pullQuoteSpeaker).toBe("Dana");
    expect(u.keyTakeaways).toHaveLength(2);
    expect(u.keyTakeaways[0]).toEqual({
      label: "Price",
      value: "floor holds at $47/seat",
    });
  });

  test("drops a pull-quote that was never said — and its speaker with it", () => {
    // Showing a paraphrase in quotation marks under somebody's name is the
    // one failure the page cannot survive. Better to render without a quote.
    const u = normaliseUnderstanding(
      {
        ...good,
        pull_quote: "The deal is basically done at 47 for two years.",
      },
      TRANSCRIPT,
    );
    expect(u.pullQuote).toBeNull();
    expect(u.pullQuoteSpeaker).toBeNull();
    // Everything else survives.
    expect(u.title).toBe("Acme landed on 24 months");
    expect(u.proposals).toHaveLength(1);
  });

  test("a proposal keeps its receipt when real, and survives without it", () => {
    const u = normaliseUnderstanding(good, TRANSCRIPT);
    expect(u.proposals[0].heardQuote).toContain("one-pager before Thursday");
    expect(u.proposals[0].destinationLabel).toBe("Renew Acme");

    const invented = normaliseUnderstanding(
      {
        ...good,
        proposals: [
          { ...good.proposals[0], heard_quote: "I will send it over tomorrow" },
        ],
      },
      TRANSCRIPT,
    );
    expect(invented.proposals).toHaveLength(1);
    expect(invented.proposals[0].heardQuote).toBeNull();
  });

  test("an unknown verb falls back to file rather than to nothing", () => {
    const u = normaliseUnderstanding(
      { ...good, proposals: [{ ...good.proposals[0], verb: "teleport" }] },
      TRANSCRIPT,
    );
    expect(u.proposals[0].verb).toBe("file");
  });

  test("a chapter that settled nothing is a normal answer", () => {
    const u = normaliseUnderstanding(
      {
        title: "Coffee with Aanya",
        summary: "Nothing settled.",
        pull_quote: null,
        pull_quote_speaker: null,
        key_takeaways: [],
        participants: ["Aanya"],
        proposals: [],
      },
      TRANSCRIPT,
    );
    expect(u.proposals).toEqual([]);
    expect(u.keyTakeaways).toEqual([]);
    expect(u.title).toBe("Coffee with Aanya");
  });

  test("malformed output degrades instead of throwing", () => {
    const u = normaliseUnderstanding(
      {
        title: 42,
        key_takeaways: [{ label: "Price" }, null, "nope"],
        participants: ["Dana", 7],
        proposals: [{ owner: "Dana" }],
      } as never,
      TRANSCRIPT,
    );
    expect(u.title).toBe("");
    expect(u.keyTakeaways).toEqual([]);
    expect(u.participants).toEqual(["Dana"]);
    expect(u.proposals).toEqual([]);
  });
});
