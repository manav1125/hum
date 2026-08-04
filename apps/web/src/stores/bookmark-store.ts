/**
 * Local mirror of the daemon's bookmark list (`/v1/bookmarks`).
 *
 * Single source of truth for hover-time "is this message bookmarked?"
 * lookups (`bookmarkedMessageIds`) and for any surface that lists bookmarks
 * (the Settings → Bookmarks page). Mutations go through `toggleBookmark` /
 * `removeBookmark`, which optimistically update local state and reconcile
 * with a full `loadBookmarks({ force: true })` on error — mirroring the
 * macOS `BookmarkStore`.
 *
 * A zustand store rather than a TanStack query because the primary consumer
 * is the per-message hover row, which renders under `renderToStaticMarkup`
 * in tests and outside any `QueryClientProvider`; store reads are
 * provider-free and effect-driven loads simply don't run there.
 */

import { create } from "zustand";

import {
  bookmarksBymessageByMessageIdDelete,
  bookmarksGet,
  bookmarksPost,
} from "@/generated/daemon/sdk.gen";
import type { BookmarksGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { createSelectors } from "@/utils/create-selectors";

export type BookmarkSummary = BookmarksGetResponse["bookmarks"][number];

interface BookmarkStoreState {
  /** All bookmarks, newest first (server order). */
  bookmarks: BookmarkSummary[];
  /** Message ids with a bookmark — the hover toggle's O(1) lookup. */
  bookmarkedMessageIds: Set<string>;
  /** True until the first load for the current assistant completes. */
  isLoading: boolean;
  /** True when the last load failed (and no newer load succeeded). */
  loadFailed: boolean;
  /** Assistant whose bookmarks are currently mirrored, or null pre-load. */
  loadedAssistantId: string | null;

  /**
   * Fetch the bookmark list for `assistantId`. No-ops when the list is
   * already loaded (or loading) for the same assistant unless `force` is
   * set. Safe to call from every hover-row mount.
   */
  loadBookmarks: (
    assistantId: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  /**
   * Toggle the bookmark on a message. Optimistic; reconciles with a forced
   * reload on failure. Resolves `true` on success.
   */
  toggleBookmark: (
    assistantId: string,
    messageId: string,
    conversationId: string,
  ) => Promise<boolean>;
  /** Remove a bookmark by message id. Resolves `true` on success. */
  removeBookmark: (assistantId: string, messageId: string) => Promise<boolean>;
}

function toIdSet(bookmarks: BookmarkSummary[]): Set<string> {
  return new Set(bookmarks.map((b) => b.messageId));
}

/** In-flight load, deduped per assistant. Module-level (not reactive state). */
let inflightLoad: { assistantId: string; promise: Promise<void> } | null = null;

/** Test-only: clear the in-flight load guard between test cases. */
export function _resetInflightLoadForTesting(): void {
  inflightLoad = null;
}

const useBookmarkStoreBase = create<BookmarkStoreState>()((set, get) => ({
  bookmarks: [],
  bookmarkedMessageIds: new Set<string>(),
  isLoading: false,
  loadFailed: false,
  loadedAssistantId: null,

  loadBookmarks: async (assistantId, opts) => {
    const force = opts?.force === true;
    if (!force && get().loadedAssistantId === assistantId) return;
    if (inflightLoad?.assistantId === assistantId && !force) {
      return inflightLoad.promise;
    }

    const promise = (async () => {
      set({ isLoading: true });
      try {
        const { data } = await bookmarksGet({
          path: { assistant_id: assistantId },
          throwOnError: true,
        });
        set({
          bookmarks: data.bookmarks,
          bookmarkedMessageIds: toIdSet(data.bookmarks),
          isLoading: false,
          loadFailed: false,
          loadedAssistantId: assistantId,
        });
      } catch (err) {
        captureError(err, { context: "bookmarks_load" });
        set({ isLoading: false, loadFailed: true });
      } finally {
        inflightLoad = null;
      }
    })();
    inflightLoad = { assistantId, promise };
    return promise;
  },

  toggleBookmark: async (assistantId, messageId, conversationId) => {
    if (get().bookmarkedMessageIds.has(messageId)) {
      return get().removeBookmark(assistantId, messageId);
    }
    // Optimistic placeholder row so the icon flips instantly; the server
    // response (with the real preview/title join) replaces it.
    const optimistic: BookmarkSummary = {
      id: `optimistic-${messageId}`,
      messageId,
      conversationId,
      conversationTitle: null,
      messagePreview: "",
      messageRole: "assistant",
      messageCreatedAt: Date.now(),
      createdAt: Date.now(),
    };
    set((prev) => {
      const bookmarks = [optimistic, ...prev.bookmarks];
      return { bookmarks, bookmarkedMessageIds: toIdSet(bookmarks) };
    });
    try {
      const { data } = await bookmarksPost({
        path: { assistant_id: assistantId },
        body: { messageId, conversationId },
        throwOnError: true,
      });
      set((prev) => {
        const bookmarks = prev.bookmarks.map((b) =>
          b.id === optimistic.id ? data : b,
        );
        return { bookmarks, bookmarkedMessageIds: toIdSet(bookmarks) };
      });
      return true;
    } catch (err) {
      captureError(err, { context: "bookmarks_create" });
      void get().loadBookmarks(assistantId, { force: true });
      return false;
    }
  },

  removeBookmark: async (assistantId, messageId) => {
    const previous = get().bookmarks;
    set(() => {
      const bookmarks = previous.filter((b) => b.messageId !== messageId);
      return { bookmarks, bookmarkedMessageIds: toIdSet(bookmarks) };
    });
    try {
      await bookmarksBymessageByMessageIdDelete({
        path: { assistant_id: assistantId, messageId },
        throwOnError: true,
      });
      return true;
    } catch (err) {
      captureError(err, { context: "bookmarks_delete" });
      void get().loadBookmarks(assistantId, { force: true });
      return false;
    }
  },
}));

export const useBookmarkStore = createSelectors(useBookmarkStoreBase);
