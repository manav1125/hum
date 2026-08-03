/**
 * A failed search is an error, never an empty result.
 *
 * `searchGlobal` used to return four empty arrays whenever the request failed,
 * so a 500 and "you have nothing" were the same value. These tests hold the
 * line at the seam: every failure mode has to come back as `status: "error"`,
 * and the only way to reach a results array is through `status: "ok"`.
 */
import { describe, expect, test } from "bun:test";

import {
  describeCategories,
  searchFailureMessage,
  searchGlobal,
  SEARCH_CATEGORIES,
} from "./global-search";

async function withStubbedFetch(
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

const okBody = {
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
    memories: [],
    schedules: [],
    contacts: [],
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("searchGlobal — failure is never absence", () => {
  test("a 500 is an error carrying the status, not zero results", async () => {
    await withStubbedFetch(
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "acme");
        expect(outcome.status).toBe("error");
        if (outcome.status !== "error") return;
        expect(outcome.httpStatus).toBe(500);
        expect(outcome.message).toContain("500");
        expect(outcome.message).toContain("Nothing was searched");
        // The thing the old code did: no results array anywhere on a failure.
        expect(outcome).not.toHaveProperty("results");
      },
    );
  });

  test("a 401 is an error too — an expired session is not an empty account", async () => {
    await withStubbedFetch(
      (async () =>
        new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "acme");
        expect(outcome.status).toBe("error");
      },
    );
  });

  test("a dropped connection is an error, not a quiet empty list", async () => {
    await withStubbedFetch(
      (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "acme");
        expect(outcome.status).toBe("error");
        if (outcome.status !== "error") return;
        expect(outcome.message).toContain("Nothing was searched");
      },
    );
  });

  test("no assistant is 'unavailable' — and never reaches the network", async () => {
    let called = false;
    await withStubbedFetch(
      (async () => {
        called = true;
        return jsonResponse(okBody);
      }) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal(null, "acme");
        expect(outcome.status).toBe("unavailable");
        expect(called).toBe(false);
      },
    );
  });

  test("a superseded keystroke is 'cancelled', not an empty 'ok'", async () => {
    const controller = new AbortController();
    await withStubbedFetch(
      (async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "acme", {
          signal: controller.signal,
        });
        expect(outcome.status).toBe("cancelled");
      },
    );
  });

  test("a real answer is 'ok', and an empty 'ok' is the only honest empty", async () => {
    await withStubbedFetch(
      (async () => jsonResponse(okBody)) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "acme");
        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") return;
        expect(outcome.results.conversations).toHaveLength(1);
      },
    );

    await withStubbedFetch(
      (async () =>
        jsonResponse({
          query: "zzz",
          results: {
            conversations: [],
            memories: [],
            schedules: [],
            contacts: [],
          },
        })) as unknown as typeof fetch,
      async () => {
        const outcome = await searchGlobal("a1", "zzz");
        expect(outcome.status).toBe("ok");
        if (outcome.status !== "ok") return;
        expect(outcome.results.conversations).toHaveLength(0);
      },
    );
  });

  test("only the categories asked for are requested", async () => {
    let requested: string | null = null;
    await withStubbedFetch((async (input: RequestInfo | URL) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested = new URL(href, "http://localhost").searchParams.get(
        "categories",
      );
      return jsonResponse(okBody);
    }) as unknown as typeof fetch, async () => {
      await searchGlobal("a1", "acme", {
        categories: ["conversations", "contacts"],
      });
      expect(requested).toBe("conversations,contacts");
    });
  });
});

describe("Cue's own words", () => {
  test("first person, and it says nothing was searched", () => {
    expect(searchFailureMessage(503)).toBe(
      "I couldn't reach my search index (503). Nothing was searched.",
    );
    expect(searchFailureMessage()).toBe(
      "I couldn't reach my search index. Nothing was searched.",
    );
  });

  test("the empty-state sentence can name what was actually searched", () => {
    expect(describeCategories(SEARCH_CATEGORIES)).toBe(
      "conversations, memories, schedules and people",
    );
    expect(describeCategories(["conversations", "schedules", "contacts"])).toBe(
      "conversations, schedules and people",
    );
    expect(describeCategories(["contacts"])).toBe("people");
  });
});
