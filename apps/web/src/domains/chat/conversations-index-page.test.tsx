/**
 * The desktop **All conversations** index.
 *
 * The route this page replaces redirected on desktop, which is what made the
 * rail's "All conversations ›" row inert. `routes.test.ts` asserts the route is
 * no longer a redirect and `assistant-side-menu.click-through.test.tsx` asserts
 * the row reaches it; this file asserts the page itself is worth arriving at.
 *
 * v16 D3: *"people find threads by remembering a sentence, not a title"* — so
 * the assertion that matters is that search renders the **excerpt**, and that
 * the two things the API cannot support are said out loud rather than drawn.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

const okResponse = { response: new Response(), error: undefined };

let conversations: {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  conversationType: string;
  source: string;
  groupId: string | null;
}[] = [];
let searchResults: unknown[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  conversationsGet: mock(async () => ({
    data: { conversations },
    ...okResponse,
  })),
  conversationsSearchGet: mock(
    async (options?: { query?: { q?: string } }) => ({
      data: { query: options?.query?.q ?? "", results: searchResults },
      ...okResponse,
    }),
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

const { ConversationsIndexPage } = await import("./conversations-index-page");

function LocationProbe() {
  const { pathname } = useLocation();
  return createElement("div", { "data-testid": "pathname" }, pathname);
}

function renderPage() {
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
        { initialEntries: ["/assistant/conversations"] },
        createElement(ConversationsIndexPage),
        createElement(LocationProbe),
      ),
    ),
  );
}

function conversation(id: string, title: string) {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    lastMessageAt: 2,
    conversationType: "standard",
    source: "vellum",
    groupId: null,
  };
}

beforeEach(() => {
  conversations = [];
  searchResults = [];
  isMobileRef.value = false;
});

afterEach(cleanup);

describe("the index lists what the rail's five-row peek cannot", () => {
  test("every conversation, with a heading that counts them", async () => {
    conversations = [
      conversation("c1", "Renewal terms"),
      conversation("c2", "Dinner conflict"),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Renewal terms")).toBeDefined();
    });
    expect(screen.getByText("Dinner conflict")).toBeDefined();
    expect(screen.getByText(/2 conversations/)).toBeDefined();
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
      expect(screen.getByText(/Nothing said that/)).toBeDefined();
    });
    expect(screen.queryByText("Ghost")).toBeNull();
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
    // D3 asks for both. No endpoint relates a conversation to a thing, so the
    // page states the gap instead of drawing a chip that is always empty.
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/isn't recorded yet, so there are no thing chips/),
      ).toBeDefined();
    });
  });
});
