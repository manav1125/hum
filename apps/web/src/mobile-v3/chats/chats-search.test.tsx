/**
 * The phone's Chats search reaches every thread — or says what it reached.
 *
 * The shipped bug was not a wrong result, it was a confident one. The box
 * filtered `title.includes(q)` over the drained window (page 0 is 50 rows; the
 * owner has 420 reachable and 1188 in the database) and rendered "No chats
 * match." — which is a sentence about the corpus, produced by a function that
 * had seen the first page of it. Indistinguishable from "you never had that
 * conversation".
 *
 * So these tests hold two lines, and the second is the one that rots first:
 *
 *   1. A thread the client has NEVER fetched is findable. That is the fix, and
 *      it can only be true if the query left the device.
 *   2. When the index cannot be reached, the surface degrades to the old local
 *      filter but NEVER renders an empty state that reads like an answer. The
 *      bound is named, in words, on screen.
 *
 * The component case is included on purpose: the pure helpers can be perfect
 * while the JSX still prints "No chats match." next to them, which is exactly
 * how this class of defect survives a green suite.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

import type { Conversation } from "@/types/conversation-types";

import {
  CHAT_SEARCH_LIMIT,
  loadedOnlyNote,
  localTitleMatches,
  mergeSearchHits,
  runChatSearch,
  scopeNote,
  wholeScopeNote,
} from "./chats-search";
import { Mv3ChatsIndex } from "./mv3-chats-index";

afterEach(cleanup);

const NOW = 1_800_000_000_000;

function conv(over: Partial<Conversation> & { conversationId: string }): Conversation {
  return { lastMessageAt: NOW, ...over };
}

/** The window a phone has actually drained — 2 of the owner's 1188. */
const LOADED: Conversation[] = [
  conv({ conversationId: "loaded-1", title: "Standup notes", lastMessageAt: NOW }),
  conv({ conversationId: "loaded-2", title: "Acme pricing", lastMessageAt: NOW - 10 }),
];

/** A thread from two weeks ago. It is NOT in `LOADED` — that is the point. */
const OLD_HIT = {
  id: "old-thread",
  title: "Vendor contract renewal",
  updatedAt: NOW - 14 * 86_400_000,
  excerpt: "24 months at $47/seat",
  matchCount: 3,
};

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface SearchStub {
  status?: number;
  conversations?: unknown[];
}

/** Captures the URLs the code actually requested, so "server-side" is proven. */
function stubFetch(stub: SearchStub) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    // The generated client calls `fetch(new Request(...))`, and `String(request)`
    // is "[object Request]" — a stub that matched on that would silently answer
    // every call from the wrong branch.
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    calls.push(url);
    if (url.includes("/search/global")) {
      if (stub.status && stub.status !== 200) {
        return new Response("boom", { status: stub.status });
      }
      return new Response(
        JSON.stringify({
          query: "q",
          results: {
            conversations: stub.conversations ?? [],
            memories: [],
            schedules: [],
            contacts: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // The receipts query the index also mounts.
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

async function withFetch(stub: SearchStub, run: (calls: string[]) => Promise<void>) {
  const { calls, restore } = stubFetch(stub);
  try {
    await run(calls);
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// 1. The fix: search leaves the device and reaches unloaded threads
// ---------------------------------------------------------------------------

describe("runChatSearch — the corpus, not the cache", () => {
  test("finds a thread that was never loaded, and asks the server for it", async () => {
    await withFetch({ conversations: [OLD_HIT] }, async (calls) => {
      const state = await runChatSearch("a1", "vendor", LOADED);

      expect(state?.status).toBe("whole");
      if (state?.status !== "whole") return;

      // THE regression. The old client-side filter could never produce this
      // row: `old-thread` is not in LOADED and its title match lives in a page
      // the phone has not fetched.
      expect(state.rows.map((r) => r.conversationId)).toContain("old-thread");
      expect(state.rows[0]?.title).toBe("Vendor contract renewal");

      // And it is genuinely server-side, scoped to conversations.
      const searchCall = calls.find((u) => u.includes("/search/global"));
      expect(searchCall).toBeDefined();
      expect(searchCall).toContain("categories=conversations");
      expect(searchCall).toContain(`limit=${CHAT_SEARCH_LIMIT}`);
    });
  });

  test("a full page is reported as bounded, not as a total", async () => {
    const many = Array.from({ length: CHAT_SEARCH_LIMIT }, (_, i) => ({
      ...OLD_HIT,
      id: `hit-${i}`,
      title: `Thread ${i}`,
    }));
    await withFetch({ conversations: many }, async () => {
      const state = await runChatSearch("a1", "thread", []);
      expect(state?.status).toBe("whole");
      if (state?.status !== "whole") return;
      expect(state.truncated).toBe(true);
      // Never "100 matches" — the cap proves only "at least 100".
      expect(scopeNote(state)).toContain("there are more");
      expect(scopeNote(state)).not.toMatch(/^100 matches/);
    });
  });

  test("an exact count prints only when the index answered under the cap", () => {
    expect(wholeScopeNote(3, false)).toBe("3 matches, including older threads.");
    expect(wholeScopeNote(1, false)).toBe("1 match, including older threads.");
    expect(wholeScopeNote(CHAT_SEARCH_LIMIT, true)).toContain("there are more");
  });
});

// ---------------------------------------------------------------------------
// 2. Failure names its bound instead of impersonating an answer
// ---------------------------------------------------------------------------

describe("runChatSearch — a failure is never an empty answer", () => {
  test("a 500 degrades to the loaded window and says so, carrying the code", async () => {
    await withFetch({ status: 500 }, async () => {
      const state = await runChatSearch("a1", "acme", LOADED);

      expect(state?.status).toBe("loaded_only");
      if (state?.status !== "loaded_only") return;

      // Fail-open: the local match is still shown. A search outage may not
      // hide a conversation the user can see.
      expect(state.rows.map((r) => r.conversationId)).toEqual(["loaded-2"]);
      expect(state.note).toContain("500");
      expect(state.note).toContain("older threads weren't searched");
      // The distinguishing claim it must NOT make.
      expect(state.note).not.toContain("No chats match");
    });
  });

  test("no assistant is 'not connected', not 'nothing found'", async () => {
    const state = await runChatSearch(null, "acme", LOADED);
    expect(state?.status).toBe("loaded_only");
    if (state?.status !== "loaded_only") return;
    expect(state.note).toContain("older threads weren't searched");
  });

  test("a superseded keystroke returns null, never an empty result set", async () => {
    const controller = new AbortController();
    controller.abort();
    await withFetch({ conversations: [OLD_HIT] }, async () => {
      const state = await runChatSearch("a1", "vendor", LOADED, controller.signal);
      expect(state).toBeNull();
    });
  });

  test("both degraded reasons name the same bound", () => {
    expect(loadedOnlyNote({ kind: "error", httpStatus: 503 })).toContain(
      "older threads weren't searched",
    );
    expect(loadedOnlyNote({ kind: "unavailable" })).toContain(
      "older threads weren't searched",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The merge
// ---------------------------------------------------------------------------

describe("mergeSearchHits", () => {
  test("keeps the local object for a hit that is loaded, so receipts survive", () => {
    const rows = mergeSearchHits(
      [{ ...OLD_HIT, id: "loaded-2", title: "stale server title" }],
      LOADED,
      "acme",
    );
    expect(rows).toHaveLength(1);
    // The local copy wins — a rename a second ago must not be undone by the
    // index's older row.
    expect(rows[0]?.title).toBe("Acme pricing");
  });

  test("unions a local-only match the index has not indexed yet", () => {
    const draft = conv({ conversationId: "draft-1", title: "Acme draft" });
    const rows = mergeSearchHits([OLD_HIT], [...LOADED, draft], "acme");
    const ids = rows.map((r) => r.conversationId);
    expect(ids).toContain("old-thread"); // server
    expect(ids).toContain("draft-1"); // local-only
  });

  test("drops a hit the user has archived locally", () => {
    const archived = conv({
      conversationId: "old-thread",
      title: "Vendor contract renewal",
      archivedAt: NOW,
    });
    const rows = mergeSearchHits([OLD_HIT], [archived], "vendor");
    expect(rows).toHaveLength(0);
  });

  test("orders newest first across both sources", () => {
    const rows = mergeSearchHits([OLD_HIT], LOADED, "standup");
    expect(rows[0]?.conversationId).toBe("loaded-1");
    expect(rows.at(-1)?.conversationId).toBe("old-thread");
  });

  test("localTitleMatches ignores archived rows", () => {
    const archived = conv({ conversationId: "a", title: "Acme", archivedAt: NOW });
    expect(localTitleMatches([archived], "acme")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The surface — where the sentence is actually printed
// ---------------------------------------------------------------------------

function renderIndex() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client },
        createElement(Mv3ChatsIndex, {
        assistantId: "a1",
        conversations: LOADED,
        processingConversationIds: new Set<string>(),
        attentionConversationIds: new Set<string>(),
          onSelectConversation: () => {},
          onStartNewConversation: () => {},
        }),
      ),
    ),
  );
}

function typeQuery(text: string) {
  fireEvent.change(screen.getByLabelText("Search chats"), {
    target: { value: text },
  });
}

describe("Mv3ChatsIndex — the sentence on screen", () => {
  test("an unreachable index never renders 'No chats match'", async () => {
    await withFetch({ status: 500 }, async () => {
      renderIndex();
      // A query that matches nothing locally — the exact shape that used to
      // print a confident empty state.
      typeQuery("vendor contract");

      await waitFor(() => {
        expect(
          screen.getByText(/older threads weren't searched/i),
        ).toBeDefined();
      });

      expect(screen.queryByText(/No chats match/i)).toBeNull();
      // What it says instead is scoped to what it actually looked at.
      expect(
        screen.getByText(/Nothing in the chats already loaded matches/i),
      ).toBeDefined();
    });
  });

  test("a search that reached everything may say so, and lists unloaded threads", async () => {
    await withFetch({ conversations: [OLD_HIT] }, async () => {
      renderIndex();
      typeQuery("vendor");

      await waitFor(() => {
        expect(screen.getByText("Vendor contract renewal")).toBeDefined();
      });
      expect(
        screen.getByText(/1 match, including older threads/i),
      ).toBeDefined();
      expect(screen.queryByText(/weren't searched/i)).toBeNull();
    });
  });

  test("a genuine no-match says so only alongside the scope it searched", async () => {
    await withFetch({ conversations: [] }, async () => {
      renderIndex();
      typeQuery("zzzz");

      await waitFor(() => {
        expect(screen.getByText(/No chats match/i)).toBeDefined();
      });
      expect(
        screen.getByText(/Searched everything, including older threads/i),
      ).toBeDefined();
    });
  });
});
