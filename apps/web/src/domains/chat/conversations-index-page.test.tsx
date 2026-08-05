/**
 * The desktop **All conversations** index.
 *
 * The route this page replaces redirected on desktop, which is what made the
 * rail's "All conversations ›" row inert. `routes.test.ts` asserts the route is
 * no longer a redirect and `assistant-side-menu.click-through.test.tsx` asserts
 * the row reaches it; this file asserts the page itself is worth arriving at.
 *
 * What is pinned down here is the house rules rather than the pixels:
 *
 * - **v16 D3** — *"people find threads by remembering a sentence, not a title"*
 *   → search renders the **excerpt**, and the two things the API cannot support
 *   (the thing chip, "Unattached · N") are said out loud rather than drawn.
 * - **§11.3** — *"Pinned | Top of conversation list"* → the PINNED section
 *   leads, and everything else buckets strictly by recency.
 * - **An honest empty state** — an empty list says *why*, and a fetch that
 *   failed reads as an error, never as "you have no conversations".
 * - **No colour-only state** — unread carries a glyph and a word, not a hue.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

const okResponse = { response: new Response(), error: undefined };

interface RawConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  conversationType: string;
  source: string;
  groupId: string | null;
  isPinned?: true;
  isProcessing?: boolean;
  assistantAttention?: { hasUnseenLatestAssistantMessage: boolean };
}

let conversations: RawConversation[] = [];
let groups: {
  id: string;
  name: string;
  sortPosition: number;
  isSystemGroup: boolean;
}[] = [];
let searchResults: unknown[] = [];
let listFails = false;

interface RawBookmark {
  id: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  messagePreview: string;
  messageRole: string;
  messageCreatedAt: number;
  createdAt: number;
}

let bookmarks: RawBookmark[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  conversationsGet: mock(async () => {
    if (listFails) throw new Error("gateway 401");
    return { data: { conversations }, ...okResponse };
  }),
  groupsGet: mock(async () => ({ data: { groups }, ...okResponse })),
  conversationsSearchGet: mock(
    async (options?: { query?: { q?: string } }) => ({
      data: { query: options?.query?.q ?? "", results: searchResults },
      ...okResponse,
    }),
  ),
  // The Bookmarked filter's data (v37 ruling 3). Mocked for every test in
  // this file because the page warms the bookmark mirror on mount.
  bookmarksGet: mock(async () => ({ data: { bookmarks }, ...okResponse })),
  bookmarksBymessageByMessageIdDelete: mock(
    async (options: { path: { messageId: string } }) => {
      bookmarks = bookmarks.filter(
        (b) => b.messageId !== options.path.messageId,
      );
      return { data: { ok: true }, ...okResponse };
    },
  ),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => "asst-1" },
  },
}));

mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: (selector: (s: unknown) => unknown) =>
    selector({ assistantState: { kind: "active" } }),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

// The phone branch renders the mobile-v3 index, which this file is not about.
const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  useMobileLayout: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { CONVERSATION_LIST_PAGE_SIZE } =
  await import("@/utils/conversation-list-fetchers");

const { ConversationsIndexPage, buildFilters } =
  await import("./conversations-index-page");
const { useBookmarkStore, _resetInflightLoadForTesting } =
  await import("@/stores/bookmark-store");

function LocationProbe() {
  const { pathname } = useLocation();
  return createElement("div", { "data-testid": "pathname" }, pathname);
}

function renderPage(initialEntry = "/assistant/conversations") {
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
        { initialEntries: [initialEntry] },
        createElement(ConversationsIndexPage),
        createElement(LocationProbe),
      ),
    ),
  );
}

const DAY = 86_400_000;

/** Local midnight, matching the component's own day boundary. */
function startOfToday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function conversation(
  id: string,
  title: string,
  extra: Partial<RawConversation> = {},
): RawConversation {
  const at = extra.lastMessageAt ?? Date.now();
  return {
    id,
    title,
    createdAt: at,
    updatedAt: at,
    lastMessageAt: at,
    conversationType: "standard",
    source: "vellum",
    groupId: null,
    ...extra,
  };
}

/** The `<section>` a recency heading owns, so bucket membership is checkable. */
function bucket(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const section = heading.closest("section");
  if (!section) throw new Error(`No section for ${label}`);
  return section as HTMLElement;
}

beforeEach(() => {
  conversations = [];
  groups = [];
  searchResults = [];
  listFails = false;
  isMobileRef.value = false;
  bookmarks = [];
  // The bookmark mirror is module-level state; start each test empty.
  _resetInflightLoadForTesting();
  useBookmarkStore.setState({
    bookmarks: [],
    bookmarkedMessageIds: new Set<string>(),
    isLoading: false,
    loadFailed: false,
    loadedAssistantId: null,
  });
});

afterEach(cleanup);

describe("the index lists what the rail's five-row peek cannot", () => {
  test("every conversation, under a census counted from the rows themselves", async () => {
    conversations = [
      conversation("c1", "Renewal terms"),
      conversation("c2", "Dinner conflict"),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Renewal terms")).toBeDefined();
    });
    expect(screen.getByText("Dinner conflict")).toBeDefined();
    // "N conversations · M this week" — both legs are counted from the list in
    // hand, so the headline can never disagree with what is drawn.
    expect(screen.getByText("2 conversations · 2 this week")).toBeDefined();
  });

  test("a row opens the conversation", async () => {
    conversations = [conversation("c1", "Renewal terms")];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Renewal terms")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Renewal terms"));
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/assistant/conversations/c1",
    );
  });
});

describe("a window is not a total, and it is not the end of the list", () => {
  // Prod, the owner's account: this page would have said "150 conversations"
  // while `?limit=500` returned 420 and the table held 1188 — the foreground
  // list resolves page 0 and drains two more, and nothing here could ask for
  // page 4. Conversation #200 was unreachable from the surface called "All
  // conversations".
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      conversation(`c${i}`, `Thread ${i}`, {
        lastMessageAt: Date.now() - i * 1000,
      }),
    );

  test("at a page boundary the census hedges and offers the rest", async () => {
    conversations = many(CONVERSATION_LIST_PAGE_SIZE + 10);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Thread 0")).toBeDefined();
    });
    expect(screen.getByText(/conversations so far ·/)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Load older conversations" }),
    ).toBeDefined();
  });

  test("once the continuation says there is no more, both go away", async () => {
    conversations = many(CONVERSATION_LIST_PAGE_SIZE + 10);
    renderPage();
    const button = await screen.findByRole("button", {
      name: "Load older conversations",
    });
    fireEvent.click(button);
    // The mock's page reports no `hasMore`, i.e. this was the last page.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Load older conversations" }),
      ).toBeNull();
    });
    // …and the hedge goes with it: the list is now provably whole.
    expect(screen.queryByText(/so far/)).toBeNull();
  });

  test("a short list is the whole list — no hedge, no dead button", async () => {
    conversations = many(3);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Thread 0")).toBeDefined();
    });
    expect(screen.queryByText(/so far/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Load older conversations" }),
    ).toBeNull();
  });
});

describe("pinned leads, then strict recency (§11.3)", () => {
  test("a known set lands in the right buckets", async () => {
    const now = Date.now();
    conversations = [
      conversation("old", "Airtel deadline prep", {
        lastMessageAt: now - 30 * DAY,
      }),
      conversation("mid", "Watcher provision trigger", {
        lastMessageAt: now - 3 * DAY,
      }),
      conversation("yday", "Flight detail inquiry", {
        // Noon yesterday, derived from the calendar rather than from a
        // duration. `now - 30h` was a time bomb: "yesterday" is the calendar
        // day before today, so a 30-hour-old row only lands there when the
        // suite runs after 06:00. Before that it falls into EARLIER THIS
        // WEEK, the YESTERDAY heading never renders, and the failure reads
        // as a bucketing bug rather than as a fixture that cannot tell a
        // duration from a date. It fails here at 03:00 and passes at 09:00.
        lastMessageAt: startOfToday(now) - 12 * 60 * 60 * 1000,
      }),
      conversation("today", "Amex suspension steps", { lastMessageAt: now }),
      conversation("pin", "Acme pricing", {
        lastMessageAt: now - 40 * DAY,
        isPinned: true,
      }),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Amex suspension steps")).toBeDefined();
    });

    // Pinned outranks its own age — a 40-day-old pinned row still leads.
    expect(within(bucket("PINNED")).getByText("Acme pricing")).toBeDefined();
    expect(
      within(bucket("TODAY")).getByText("Amex suspension steps"),
    ).toBeDefined();
    expect(
      within(bucket("YESTERDAY")).getByText("Flight detail inquiry"),
    ).toBeDefined();
    expect(
      within(bucket("EARLIER THIS WEEK")).getByText(
        "Watcher provision trigger",
      ),
    ).toBeDefined();
    expect(
      within(bucket("EARLIER")).getByText("Airtel deadline prep"),
    ).toBeDefined();

    // PINNED is first on the page, not merely present.
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings[0]?.textContent).toBe("PINNED");
  });

  test("an undated row sinks to EARLIER rather than being given a time", async () => {
    conversations = [
      conversation("dated", "Kids activity schedule"),
      {
        ...conversation("undated", "Imported thread"),
        createdAt: 0,
        updatedAt: 0,
        lastMessageAt: null,
      },
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Imported thread")).toBeDefined();
    });
    expect(
      within(bucket("EARLIER")).getByText("Imported thread"),
    ).toBeDefined();
    // …and no invented timestamp beside it.
    const row = screen.getByText("Imported thread").closest("button");
    expect(row?.textContent).toBe("·Imported thread");
  });
});

describe("states carry a glyph and a word, never a hue alone", () => {
  test("unread says so", async () => {
    conversations = [
      conversation("c1", "Renewal terms", {
        assistantAttention: { hasUnseenLatestAssistantMessage: true },
      }),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Renewal terms")).toBeDefined();
    });
    const row = screen.getByText("Renewal terms").closest("button");
    expect(row?.textContent).toContain("●");
    expect(row?.textContent).toContain("unread");
  });

  test("a running turn says so, and outranks unread", async () => {
    conversations = [
      conversation("c1", "Renewal terms", {
        isProcessing: true,
        assistantAttention: { hasUnseenLatestAssistantMessage: true },
      }),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Renewal terms")).toBeDefined();
    });
    const row = screen.getByText("Renewal terms").closest("button");
    expect(row?.textContent).toContain("◐");
    expect(row?.textContent).toContain("running");
    expect(row?.textContent).not.toContain("unread");
  });
});

describe("the ▤ chip is a real group, and only a real group", () => {
  test("a filed conversation wears its group's name", async () => {
    groups = [
      { id: "g1", name: "Renew Acme", sortPosition: 0, isSystemGroup: false },
    ];
    conversations = [conversation("c1", "Acme pricing", { groupId: "g1" })];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Acme pricing")).toBeDefined();
    });
    // The chip is on the row, not only in the filter bar above it.
    const row = screen.getByText("Acme pricing").closest("button");
    expect(row?.textContent).toContain("▤ Renew Acme");
  });

  test("a groupId with no matching group draws no chip", async () => {
    // The group list and the conversation list are separate reads and can
    // disagree. An unresolvable id must not become a chip with an id in it.
    groups = [];
    conversations = [conversation("c1", "Acme pricing", { groupId: "g-gone" })];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Acme pricing")).toBeDefined();
    });
    expect(screen.queryByText(/g-gone/)).toBeNull();
  });
});

describe("filters only exist when something is behind them", () => {
  test("Unread appears with a count and narrows the list", async () => {
    conversations = [
      conversation("c1", "Renewal terms", {
        assistantAttention: { hasUnseenLatestAssistantMessage: true },
      }),
      conversation("c2", "Dinner conflict"),
    ];
    renderPage();
    const chip = await screen.findByRole("button", { name: /Unread/ });
    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.queryByText("Dinner conflict")).toBeNull();
    });
    expect(screen.getByText("Renewal terms")).toBeDefined();
  });

  test("the chip you are standing on survives its count reaching zero", () => {
    // Otherwise the view silently resets to All and the user is never told why
    // their filter emptied — and the "Nothing under X" state below would be
    // unreachable code pretending to be a feature.
    const read = [{ conversationId: "c1" }] as never;
    const withUnread = buildFilters(read, [], "all");
    expect(withUnread.some((f) => f.id === "unread")).toBe(false);

    const held = buildFilters(read, [], "unread");
    const unread = held.find((f) => f.id === "unread");
    expect(unread?.count).toBe(0);
    expect(unread?.emptyLine).toContain("nothing is waiting to be read");
  });

  test("no unread rows, no Unread chip", async () => {
    conversations = [conversation("c2", "Dinner conflict")];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Dinner conflict")).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /Unread/ })).toBeNull();
  });
});

describe("an empty list says why it is empty", () => {
  test("no conversations — a sentence and a way out, not a bare 'none'", async () => {
    conversations = [];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No conversations yet")).toBeDefined();
    });
    expect(
      screen.getByText(/Nothing has been said to Cue on this assistant/),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Start a conversation" }),
    ).toBeDefined();
    // The failure bar: a bare "none" with no explanation.
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});

describe("a failed fetch is an error, not an empty list", () => {
  test("it reads differently and never claims there are no conversations", async () => {
    listFails = true;
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t read your conversations");
    expect(alert.textContent).toContain("not because there is nothing there");
    // The empty-state copy must not appear on an error.
    expect(screen.queryByText("No conversations yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });
});

describe("search finds the sentence, not just the title", () => {
  test("the excerpt is rendered — that is what earns the click", async () => {
    // v16 D3. A title-only index is the sidebar with more scrolling.
    searchResults = [
      {
        conversationId: "c9",
        conversationTitle: "Renewal terms",
        conversationUpdatedAt: Date.now(),
        matchingMessages: [
          {
            messageId: "m1",
            role: "user",
            excerpt: "they moved to 24 months without much push",
            createdAt: 1,
          },
        ],
      },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "24 months" },
    });
    await waitFor(() => {
      expect(
        screen.getByText(/they moved to 24 months without much push/),
      ).toBeDefined();
    });
  });

  test("a hit with no excerpt says it matched the title", async () => {
    searchResults = [
      {
        conversationId: "c9",
        conversationTitle: "Renewal terms",
        conversationUpdatedAt: Date.now(),
        matchingMessages: [],
      },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "renewal" },
    });
    await waitFor(() => {
      expect(screen.getByText("Title match")).toBeDefined();
    });
  });

  test("a result with no id is dropped rather than rendered unopenable", async () => {
    // The endpoint declares `results: Array<unknown>`, so the page narrows at
    // the boundary. A row that cannot be clicked is worse than no row.
    searchResults = [{ conversationTitle: "Ghost", matchingMessages: [] }];
    renderPage();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "ghost" },
    });
    await waitFor(() => {
      expect(screen.getByText("Nothing said that")).toBeDefined();
    });
    expect(screen.queryByText("Ghost")).toBeNull();
  });

  test("a one-character term explains itself instead of showing nothing", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "g" },
    });
    await waitFor(() => {
      expect(screen.getByText(/search needs two characters/)).toBeDefined();
    });
  });

  test("a search hit opens its conversation", async () => {
    searchResults = [
      {
        conversationId: "c9",
        conversationTitle: "Renewal terms",
        conversationUpdatedAt: Date.now(),
        matchingMessages: [],
      },
    ];
    renderPage();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "renewal" },
    });
    await waitFor(() => {
      expect(screen.getByText("Title match")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Renewal terms"));
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/assistant/conversations/c9",
    );
  });
});

describe("what it cannot show, it says", () => {
  test("no thing chip and no 'unattached' count — nothing relates the two", async () => {
    // D3 asks for both. No endpoint relates a conversation to a work item, so
    // the page states the gap and labels its ▤ chips as what they really are.
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/The ▤ chips are conversation groups/),
      ).toBeDefined();
    });
    expect(screen.getByText(/isn’t recorded anywhere yet/)).toBeDefined();
  });
});

describe("bookmarks live with conversations, not Settings (v37 ruling 3)", () => {
  const savedBookmark = (over: Partial<RawBookmark> = {}): RawBookmark => ({
    id: "b1",
    messageId: "m1",
    conversationId: "c1",
    conversationTitle: "Renewal terms",
    messagePreview: "The cap is 4% year over year.",
    messageRole: "assistant",
    messageCreatedAt: Date.now(),
    createdAt: Date.now(),
    ...over,
  });

  test("the Bookmarked chip leads the filter row, counted from the mirror", async () => {
    conversations = [conversation("c1", "Renewal terms")];
    bookmarks = [savedBookmark()];
    renderPage();
    const chip = await screen.findByRole("button", {
      name: /Bookmarked/,
    });
    // First chip in the row — "at the top of All conversations".
    const row = screen.getByRole("group", { name: "Filter conversations" });
    expect(within(row).getAllByRole("button")[0]).toBe(chip as never);
    expect(chip.textContent).toContain("1");
  });

  test("selecting it shows the flat saved-messages list: snippet + thread link + remove", async () => {
    conversations = [conversation("c1", "Renewal terms")];
    bookmarks = [savedBookmark()];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Bookmarked/ }));
    await waitFor(() => {
      expect(screen.getByText(/The cap is 4% year over year\./)).toBeDefined();
    });
    // The row is the thread link.
    fireEvent.click(screen.getByText(/The cap is 4% year over year\./));
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/assistant/conversations/c1",
    );
  });

  test("remove deletes the bookmark and the row leaves", async () => {
    bookmarks = [savedBookmark()];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Bookmarked/ }));
    const remove = await screen.findByRole("button", {
      name: "Remove bookmark",
    });
    fireEvent.click(remove);
    await waitFor(() => {
      expect(screen.queryByText(/The cap is 4% year over year\./)).toBeNull();
    });
  });

  test("the designed empty state, verbatim", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Bookmarked/ }));
    await waitFor(() => {
      expect(
        screen.getByText(
          "Nothing saved yet — long-press any message to keep it here.",
        ),
      ).toBeDefined();
    });
  });

  test("?filter=bookmarked (the retired Settings leaf's redirect) lands on the filter", async () => {
    bookmarks = [savedBookmark()];
    renderPage("/assistant/conversations?filter=bookmarked");
    await waitFor(() => {
      expect(screen.getByText(/The cap is 4% year over year\./)).toBeDefined();
    });
  });
});
