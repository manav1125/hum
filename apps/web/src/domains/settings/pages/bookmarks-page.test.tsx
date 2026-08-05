/**
 * Tests for the Settings → Bookmarks page.
 *
 * Strategy mirrors the store test: mock the generated daemon SDK at the
 * bookmark operations (spread-actual), drive the real bookmark/flag/assistant
 * stores, and render the page inside a `MemoryRouter` so `Navigate` /
 * `useNavigate` work. A sibling conversation route captures the Open action's
 * navigation target.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { BookmarkSummary } from "@/stores/bookmark-store";

function summary(overrides: Partial<BookmarkSummary> = {}): BookmarkSummary {
  return {
    id: "b1",
    messageId: "m1",
    conversationId: "c1",
    conversationTitle: "Quarterly plan",
    messagePreview: "Here is the summary you asked for",
    messageRole: "assistant",
    messageCreatedAt: Date.UTC(2026, 6, 1, 9, 30),
    createdAt: Date.UTC(2026, 6, 2, 10, 0),
    ...overrides,
  };
}

const bookmarksGetMock = mock(
  async (
    _opts: unknown,
  ): Promise<{ data: { bookmarks: BookmarkSummary[] } }> => ({
    data: { bookmarks: [summary()] },
  }),
);
const bookmarksDeleteMock = mock(
  async (_opts: unknown): Promise<{ data: { success: true } }> => ({
    data: { success: true },
  }),
);

const actualSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  bookmarksGet: bookmarksGetMock,
  bookmarksBymessageByMessageIdDelete: bookmarksDeleteMock,
}));

const { useBookmarkStore, _resetInflightLoadForTesting } =
  await import("@/stores/bookmark-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { BookmarksPage } =
  await import("@/domains/settings/pages/bookmarks-page");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/assistant/settings/bookmarks"]}>
      <Routes>
        <Route
          path="/assistant/settings/bookmarks"
          element={<BookmarksPage />}
        />
        <Route path="/assistant/settings" element={<div>SETTINGS_INDEX</div>} />
        <Route
          path="/assistant/conversations/:conversationId"
          element={<div>CONVERSATION_TARGET</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BookmarksPage", () => {
  beforeEach(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useClientFeatureFlagStore.setState({ bookmarks: true });
    useBookmarkStore.setState({
      bookmarks: [],
      bookmarkedMessageIds: new Set<string>(),
      isLoading: false,
      loadFailed: false,
      loadedAssistantId: null,
    });
    _resetInflightLoadForTesting();
    bookmarksGetMock.mockClear();
    bookmarksDeleteMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists bookmarks with title, snippet and remove/open actions", async () => {
    const { container } = renderPage();

    await waitFor(() => {
      expect(container.textContent).toContain("Quarterly plan");
    });
    expect(container.textContent).toContain(
      "Here is the summary you asked for",
    );
    expect(container.textContent).toContain("Bookmarked");
    expect(
      container.querySelector('button[aria-label="Remove bookmark"]'),
    ).not.toBeNull();
    expect(bookmarksGetMock.mock.calls.length).toBe(1);
  });

  test("shows the empty state when there are no bookmarks", async () => {
    bookmarksGetMock.mockImplementationOnce(async () => ({
      data: { bookmarks: [] },
    }));
    const { container } = renderPage();

    await waitFor(() => {
      expect(container.textContent).toContain("No bookmarks");
    });
  });

  test("remove deletes the bookmark and drops the row", async () => {
    const { container } = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("Quarterly plan");
    });

    fireEvent.click(
      container.querySelector('button[aria-label="Remove bookmark"]')!,
    );

    await waitFor(() => {
      expect(bookmarksDeleteMock.mock.calls.length).toBe(1);
      expect(container.textContent).not.toContain("Quarterly plan");
    });
  });

  test("open navigates to the bookmark's conversation", async () => {
    const { container, getByText } = renderPage();
    await waitFor(() => {
      expect(container.textContent).toContain("Quarterly plan");
    });

    fireEvent.click(getByText("Open"));

    await waitFor(() => {
      expect(container.textContent).toContain("CONVERSATION_TARGET");
    });
  });

  test("redirects to the settings index when the flag is off", async () => {
    useClientFeatureFlagStore.setState({ bookmarks: false });
    const { container } = renderPage();

    await waitFor(() => {
      expect(container.textContent).toContain("SETTINGS_INDEX");
    });
    expect(bookmarksGetMock.mock.calls.length).toBe(0);
  });
});
