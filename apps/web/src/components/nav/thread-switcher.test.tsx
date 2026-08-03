/**
 * "Where are my conversations?" — the regression guard.
 *
 * The owner tested the build on his phone with 151 threads and could not get
 * back to any of them: a conversation's header read `‹ Cue ⋯`, and the only
 * door to the list was a row inside the top-RIGHT sheet. What he asked for was
 * the convention every other assistant uses — a control top-left that opens
 * recent threads.
 *
 * Three things have to stay true for that to keep working, and each is failed
 * separately below:
 *
 *  1. **The sheet lists real threads and opens one in a tap.** Not a link to a
 *     list — a switcher.
 *  2. **The conversation header carries the control.** The corner chrome is
 *     exact-matched to the tab landings, so on `/conversations/:id` nothing
 *     global paints a ☰; if this header stops rendering its own, the surface
 *     silently returns to having no door.
 *  3. **It fits.** The header is now four controls and a title. happy-dom has
 *     no layout engine (`getBoundingClientRect()` is all zeros), so — exactly
 *     as `corner-chrome.test.tsx` does — the assertion is made against the
 *     geometry the header DECLARES, from the same module the header styles
 *     itself from. The last time a control was added to a phone header without
 *     that arithmetic, the Work title shipped reading `☰ork`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { CONVERSATION_LIST_PAGE_SIZE } from "@/utils/conversation-list-fetchers";
import { routes } from "@/utils/routes";

import {
  HEADER_CONTROL,
  HEADER_GAP,
  MIN_TITLE_WIDTH,
  NARROWEST_PHONE,
  conversationTitleWidth,
} from "./conversation-header-metrics";

const ASSISTANT_ID = "asst-1";

let list: {
  conversations: {
    conversationId: string;
    title?: string;
    lastMessageAt?: number;
    archivedAt?: number;
  }[];
  isLoading: boolean;
  isError: boolean;
} = { conversations: [], isLoading: false, isError: false };

const conversationQueriesActual = await import("@/hooks/conversation-queries");
mock.module("@/hooks/conversation-queries", () => ({
  ...conversationQueriesActual,
  useConversationListQuery: () => ({
    ...list,
    isPending: list.isLoading,
    error: null,
    refetch: () => {},
  }),
}));

const {
  RecentThreadsSheet,
  RECENT_THREADS_SHOWN,
  allConversationsSub,
  recentThreads,
} = await import("./recent-threads-sheet");

function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

function renderSheet() {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: [routes.conversation("c-open")] },
        createElement(RecentThreadsSheet, {
          open: true,
          onClose: () => {},
          assistantId: ASSISTANT_ID,
        }),
        createElement(LocationProbe),
      ),
    ),
  );
}

const keys = () =>
  screen
    .getAllByRole("menuitem")
    .map((el) => el.getAttribute("data-menu-key") ?? "");

const rowFor = (key: string) =>
  screen
    .getAllByRole("menuitem")
    .find((el) => el.getAttribute("data-menu-key") === key);

afterEach(() => {
  list = { conversations: [], isLoading: false, isError: false };
  cleanup();
});

describe("the switcher lists threads, and opens them", () => {
  test("a thread row lands in that thread", () => {
    list.conversations = [{ conversationId: "c1", title: "Acme pricing" }];
    renderSheet();
    fireEvent.click(rowFor("thread:c1")!);
    expect(screen.getByTestId("path").textContent).toBe(
      routes.conversation("c1"),
    );
  });

  test("most recent first — a switcher ordered any other way is a list", () => {
    list.conversations = [
      { conversationId: "b", title: "B", lastMessageAt: 2 },
      { conversationId: "c", title: "C", lastMessageAt: 3 },
      { conversationId: "a", title: "A", lastMessageAt: 1 },
    ];
    renderSheet();
    expect(keys().slice(0, 3)).toEqual(["thread:c", "thread:b", "thread:a"]);
  });

  test("archived threads are not 'recent'", () => {
    list.conversations = [
      { conversationId: "live", title: "Live", lastMessageAt: 1 },
      { conversationId: "gone", title: "Gone", lastMessageAt: 99, archivedAt: 100 },
    ];
    renderSheet();
    expect(keys()).not.toContain("thread:gone");
  });

  test("a long history hands off to the full list rather than growing", () => {
    list.conversations = Array.from({ length: 151 }, (_, i) => ({
      conversationId: `c${i}`,
      title: `Thread ${i}`,
      lastMessageAt: i,
    }));
    renderSheet();
    expect(keys().filter((k) => k.startsWith("thread:")).length).toBe(
      RECENT_THREADS_SHOWN,
    );
    fireEvent.click(rowFor("all-conversations")!);
    expect(screen.getByTestId("path").textContent).toBe(routes.conversations);
  });

  test("an untitled thread is not labelled the same as the New chat action", () => {
    list.conversations = [{ conversationId: "c1" }];
    renderSheet();
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels.filter((l) => l?.includes("New chat")).length).toBe(1);
  });
});

describe("the count beside the full list is real, or absent", () => {
  const allSub = () =>
    rowFor("all-conversations")!.textContent!.replace(/›/g, "").trim();

  test("151 loaded of 420 is NOT a total, and is not printed as one", () => {
    // The exact defect, from prod: the phone's sheet said "All conversations
    // 151" while `?limit=500` returned 420 and the table held 1188. 151 was
    // page 0 plus the two drained pages plus a draft — the client's window.
    list.conversations = Array.from({ length: 151 }, (_, i) => ({
      conversationId: `c${i}`,
    }));
    renderSheet();
    expect(allSub()).not.toContain("151");
    expect(allSub()).toBe("All conversationsEverything, including older threads");
  });

  test("a list shorter than one page IS the whole list, so it counts", () => {
    // Page 0 asks for PAGE_SIZE and returns min(pageSize, total); holding
    // fewer than a page is proof there was no second one.
    list.conversations = Array.from(
      { length: CONVERSATION_LIST_PAGE_SIZE - 1 },
      (_, i) => ({ conversationId: `c${i}` }),
    );
    renderSheet();
    expect(allSub()).toBe(
      `All conversations${CONVERSATION_LIST_PAGE_SIZE - 1}`,
    );
  });

  test("exactly one page is already unprovable — no number", () => {
    list.conversations = Array.from(
      { length: CONVERSATION_LIST_PAGE_SIZE },
      (_, i) => ({ conversationId: `c${i}` }),
    );
    renderSheet();
    expect(allSub()).not.toContain(String(CONVERSATION_LIST_PAGE_SIZE));
  });

  test("a read in flight prints nothing — 0 would be a claim", () => {
    list = { conversations: [], isLoading: true, isError: false };
    renderSheet();
    expect(allSub()).toBe("All conversations");
    expect(screen.getByText(/Loading your chats/i)).toBeDefined();
  });

  test("a FAILED read keeps the door and says why the list is short", () => {
    // Fail-open. A timeout is not a judgement about the user's content, so it
    // may not remove the row — and it may not invent a count either.
    list = { conversations: [], isLoading: false, isError: true };
    renderSheet();
    expect(keys()).toContain("all-conversations");
    expect(allSub()).toBe("All conversations");
    expect(screen.getByText(/Couldn't load your chats/i)).toBeDefined();
  });

  test("genuinely empty says so, and does not read as a failure", () => {
    renderSheet();
    expect(screen.getByText(/No chats yet/i)).toBeDefined();
    expect(keys()).toEqual(["all-conversations", "new-chat"]);
  });
});

describe("allConversationsSub — one rule, both sheets", () => {
  test.each([
    [0, { isLoading: false, isError: false }, null],
    [12, { isLoading: true, isError: false }, null],
    [12, { isLoading: false, isError: true }, null],
    [12, { isLoading: false, isError: false }, "12"],
  ] as const)("%p rows, %p → %p", (n, state, expected) => {
    expect(allConversationsSub(n, state)).toBe(expected);
  });

  test("past the page boundary it stops being a number", () => {
    expect(allConversationsSub(CONVERSATION_LIST_PAGE_SIZE, {
      isLoading: false,
      isError: false,
    })).not.toMatch(/^\d+$/);
  });
});

describe("the handoff target can actually reach the rest", () => {
  test("the phone's conversations index pages past the drain cap", async () => {
    // The switcher shows seven and points at "All conversations". That row is
    // only honest if the destination can get past the ~150 the boot drain
    // holds — otherwise the deeper history is unreachable from anywhere, and
    // the person cannot tell an absent thread from a capped one.
    const source = await Bun.file(
      new URL("../../mobile-v3/chats/chats-index-page.tsx", import.meta.url)
        .pathname,
    ).text();
    expect(source).toContain("loadMoreConversations");
    expect(source).toContain("onLoadMore");
  });
});

describe("recentThreads is the ordering, not the render", () => {
  test("undated threads sort last rather than crashing the compare", () => {
    const out = recentThreads([
      { conversationId: "none" },
      { conversationId: "dated", lastMessageAt: 5 },
      { conversationId: "created", createdAt: 3 },
    ]);
    expect(out.map((c) => c.conversationId)).toEqual([
      "dated",
      "created",
      "none",
    ]);
  });

  test("it does not mutate the caller's array", () => {
    const input = [
      { conversationId: "a", lastMessageAt: 1 },
      { conversationId: "b", lastMessageAt: 2 },
    ];
    recentThreads(input);
    expect(input.map((c) => c.conversationId)).toEqual(["a", "b"]);
  });
});

/* -------------------------------------------------------------------------- *
 * The conversation header still carries the control, and it still fits.       *
 * -------------------------------------------------------------------------- */

const CHAT_VIEW = new URL(
  "../../domains/chat/components/mobile-chat-view.tsx",
  import.meta.url,
).pathname;

describe("the conversation header's top-left", () => {
  test("renders the ☰ switcher beside the ‹ back", async () => {
    // Nothing global paints a ☰ on `/conversations/:id` — `overflowVisible` is
    // exact-matched to the tab landings. If this header stops rendering its
    // own, the screen is back to the one the report was filed against.
    const source = await Bun.file(CHAT_VIEW).text();
    expect(source).toContain('data-slot="mv3-thread-switcher"');
    expect(source).toContain('aria-label="Your chats"');
    expect(source).toContain("<RecentThreadsSheet");
    // …and the back chevron is still there. The switcher was added BESIDE it,
    // not in place of it: they are different exits.
    expect(source).toContain('aria-label="Back"');
  });

  test("takes its geometry from the module this test measures", async () => {
    // The `☰ork` lesson, one level up: an assertion about declared geometry is
    // worth nothing if the header declares its own numbers somewhere else.
    const source = await Bun.file(CHAT_VIEW).text();
    expect(source).toContain("conversation-header-metrics");
    expect(source).toContain("HEADER_CONTROL");
    expect(source).toContain("HEADER_GUTTER");
  });
});

describe("four controls and a title still fit the narrowest phone", () => {
  test("the title keeps a legible share with ‹ and ☰ both present", () => {
    expect(
      conversationTitleWidth(NARROWEST_PHONE, 2),
    ).toBeGreaterThanOrEqual(MIN_TITLE_WIDTH);
  });

  test("the switcher costs one control's width and no more", () => {
    expect(
      conversationTitleWidth(NARROWEST_PHONE, 1) -
        conversationTitleWidth(NARROWEST_PHONE, 2),
    ).toBe(HEADER_CONTROL + HEADER_GAP);
  });

  test("the budget has teeth — a THIRD leading control would fail it", () => {
    // The mutation check, written down: this is the assertion that stops the
    // next well-meant icon from being added to this row on feel.
    expect(conversationTitleWidth(NARROWEST_PHONE, 3)).toBeLessThan(
      MIN_TITLE_WIDTH,
    );
  });
});
