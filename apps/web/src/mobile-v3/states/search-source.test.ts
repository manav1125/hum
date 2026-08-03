/**
 * K4 · Search — what the endpoint returns, and the two distinctions the design
 * brief singles out.
 *
 *   · **A failed fetch is an error state, not an empty one.** These are the
 *     tests that stop a 500 from being rendered as "nothing found", which is
 *     the same class of lie as an empty inbox that is really a broken one.
 *   · **Decision records are not indexed.** Pinned as an explicit assertion so
 *     that the day someone adds a fabricated decision row, a test says no.
 */
import { describe, expect, test } from "bun:test";

import {
  DECISIONS_NOT_INDEXED,
  looksLikeQuestion,
  SEARCHABLE_CATEGORIES,
} from "./search-source";

describe("question vs keyword — answer-first vs typed list", () => {
  test("questions", () => {
    for (const q of [
      "what did we agree with acme on term",
      "Who is Dana?",
      "when does the trial end",
      "should I reply to Rachel",
    ]) {
      expect(looksLikeQuestion(q)).toBe(true);
    }
  });

  test("keywords", () => {
    for (const q of ["acme", "pricing-model-v3", "dana form", "  "]) {
      expect(looksLikeQuestion(q)).toBe(false);
    }
  });
});

describe("the index's real shape", () => {
  test("four categories, and decisions is not one of them", () => {
    expect([...SEARCHABLE_CATEGORIES]).toEqual([
      "conversations",
      "memories",
      "schedules",
      "contacts",
    ]);
    expect(SEARCHABLE_CATEGORIES).not.toContain("decisions");
  });

  test("and the surface says so in words rather than faking a row", () => {
    expect(DECISIONS_NOT_INDEXED).toContain("aren't searchable yet");
  });
});

describe("a failed fetch is an error, never an empty result", () => {
  async function withStubbedSearch(
    stub: (typeof globalThis)["fetch"],
    run: () => Promise<void>,
  ) {
    const real = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("no assistant is 'unavailable', which is not a failure either", async () => {
    const { searchFromPhone } = await import("./search-source");
    const outcome = await searchFromPhone(null, "acme");
    expect(outcome.status).toBe("unavailable");
  });

  test("a 500 surfaces as an error with the status in it", async () => {
    const { searchFromPhone } = await import("./search-source");
    await withStubbedSearch(
      (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof fetch,
      async () => {
        const outcome = await searchFromPhone("a1", "acme");
        expect(outcome.status).toBe("error");
        if (outcome.status === "error") {
          expect(outcome.message).toContain("500");
          expect(outcome.message).toContain("Nothing was searched");
        }
      },
    );
  });

  test("a thrown fetch surfaces as an error, not as zero results", async () => {
    const { searchFromPhone } = await import("./search-source");
    await withStubbedSearch(
      (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
      async () => {
        const outcome = await searchFromPhone("a1", "acme");
        expect(outcome.status).toBe("error");
      },
    );
  });

  test("a superseded debounce is neither a failure nor an empty result", async () => {
    const { searchFromPhone } = await import("./search-source");
    const controller = new AbortController();
    await withStubbedSearch(
      (async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
      async () => {
        const outcome = await searchFromPhone("a1", "acme", {
          signal: controller.signal,
        });
        // Not "error" (it isn't an outage) and deliberately not "ok" with zero
        // rows either — a cancelled request never searched, and folding it into
        // `ok` is the same lie in miniature.
        expect(outcome.status).toBe("cancelled");
      },
    );
  });

  test("real results are flattened with provenance on every row", async () => {
    const { searchFromPhone } = await import("./search-source");
    const body = {
      query: "acme",
      results: {
        conversations: [
          {
            id: "c1",
            title: "Acme terms",
            updatedAt: 1,
            excerpt: "24 months",
            matchCount: 3,
          },
        ],
        memories: [
          {
            id: "m1",
            kind: "semantic",
            text: "Acme agreed 24 months at $47/seat",
            subject: "Acme",
            confidence: 0.9,
            updatedAt: 2,
            source: "lexical",
          },
        ],
        schedules: [],
        contacts: [
          { id: "p1", displayName: "Rachel", notes: null, lastInteraction: 3 },
        ],
      },
    };
    await withStubbedSearch(
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      async () => {
        const outcome = await searchFromPhone("a1", "acme");
        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") return;
        expect(outcome.results).toHaveLength(3);
        // Every row says where it came from.
        for (const r of outcome.results) expect(r.meta.length).toBeGreaterThan(0);
        // …and none of them claims to be a decision.
        expect(outcome.results.some((r) => r.kind === "decision")).toBe(false);
      },
    );
  });
});
