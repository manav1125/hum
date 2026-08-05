/**
 * Tests for the bookmark store's load/toggle/remove flows.
 *
 * The generated daemon SDK is mocked at the three bookmark operations
 * (spread-actual so every other export survives for later files in a
 * combined run); everything else is the real store module.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BookmarkSummary } from "@/stores/bookmark-store";

function summary(overrides: Partial<BookmarkSummary> = {}): BookmarkSummary {
  return {
    id: "b1",
    messageId: "m1",
    conversationId: "c1",
    conversationTitle: "Chat one",
    messagePreview: "hello there",
    messageRole: "assistant",
    messageCreatedAt: 1000,
    createdAt: 2000,
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
const bookmarksPostMock = mock(
  async (_opts: unknown): Promise<{ data: BookmarkSummary }> => ({
    data: summary({ id: "b2", messageId: "m2" }),
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
  bookmarksPost: bookmarksPostMock,
  bookmarksBymessageByMessageIdDelete: bookmarksDeleteMock,
}));

const actualCapture = await import("@/lib/sentry/capture-error");
const captureErrorMock = mock((_err: unknown, _ctx: { context: string }) => {});
mock.module("@/lib/sentry/capture-error", () => ({
  ...actualCapture,
  captureError: captureErrorMock,
}));

const { useBookmarkStore, _resetInflightLoadForTesting } =
  await import("@/stores/bookmark-store");

function resetStore() {
  useBookmarkStore.setState({
    bookmarks: [],
    bookmarkedMessageIds: new Set<string>(),
    isLoading: false,
    loadFailed: false,
    loadedAssistantId: null,
  });
  _resetInflightLoadForTesting();
  bookmarksGetMock.mockClear();
  bookmarksPostMock.mockClear();
  bookmarksDeleteMock.mockClear();
}

describe("bookmark store", () => {
  beforeEach(resetStore);

  test("loadBookmarks mirrors the server list and marks the assistant loaded", async () => {
    await useBookmarkStore.getState().loadBookmarks("asst-1");

    const state = useBookmarkStore.getState();
    expect(state.bookmarks.map((b) => b.id)).toEqual(["b1"]);
    expect(state.bookmarkedMessageIds.has("m1")).toBe(true);
    expect(state.loadedAssistantId).toBe("asst-1");
    expect(state.isLoading).toBe(false);
  });

  test("loadBookmarks no-ops when already loaded for the same assistant", async () => {
    await useBookmarkStore.getState().loadBookmarks("asst-1");
    await useBookmarkStore.getState().loadBookmarks("asst-1");
    expect(bookmarksGetMock.mock.calls.length).toBe(1);

    await useBookmarkStore.getState().loadBookmarks("asst-1", { force: true });
    expect(bookmarksGetMock.mock.calls.length).toBe(2);
  });

  test("toggleBookmark creates when not bookmarked and keeps the server row", async () => {
    const ok = await useBookmarkStore
      .getState()
      .toggleBookmark("asst-1", "m2", "c1");

    expect(ok).toBe(true);
    expect(bookmarksPostMock.mock.calls.length).toBe(1);
    const state = useBookmarkStore.getState();
    expect(state.bookmarkedMessageIds.has("m2")).toBe(true);
    // The optimistic placeholder was replaced by the server row.
    expect(state.bookmarks.map((b) => b.id)).toEqual(["b2"]);
  });

  test("toggleBookmark deletes when already bookmarked", async () => {
    useBookmarkStore.setState({
      bookmarks: [summary()],
      bookmarkedMessageIds: new Set(["m1"]),
    });

    const ok = await useBookmarkStore
      .getState()
      .toggleBookmark("asst-1", "m1", "c1");

    expect(ok).toBe(true);
    expect(bookmarksDeleteMock.mock.calls.length).toBe(1);
    expect(bookmarksPostMock.mock.calls.length).toBe(0);
    expect(useBookmarkStore.getState().bookmarkedMessageIds.has("m1")).toBe(
      false,
    );
  });

  test("create failure reports false and reconciles with a forced reload", async () => {
    bookmarksPostMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    bookmarksGetMock.mockImplementationOnce(async () => ({
      data: { bookmarks: [] },
    }));

    const ok = await useBookmarkStore
      .getState()
      .toggleBookmark("asst-1", "m9", "c1");

    expect(ok).toBe(false);
    // The reconciling reload was kicked off.
    expect(bookmarksGetMock.mock.calls.length).toBe(1);
  });
});
