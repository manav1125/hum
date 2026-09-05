/**
 * TanStack Query wrapper for paginated conversation history.
 *
 * Replaces the manual `conversationCacheRef` LRU map and `loadEpochRef`
 * cancellation token with `useInfiniteQuery`. TanStack Query provides:
 *
 * - **Automatic per-conversation caching** via the query key — no manual
 *   LRU rotation needed.
 * - **Automatic cancellation** via AbortController when the query key
 *   changes (conversation switch) — no epoch-gating needed.
 * - **Stale-while-revalidate** — cached conversations render instantly
 *   while the background refetch picks up any messages added since.
 * - **Pagination** via `fetchNextPage` / `hasNextPage` / `isFetchingNextPage`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation
 */

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  fetchLatestHistoryPage,
  fetchOlderHistoryPage,
} from "@/domains/chat/api/history";
import { withTimeout } from "@/utils/abort-signal";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { mergeAdjacentAssistantMessages } from "@/domains/chat/utils/message-merge";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

export const CONVERSATION_HISTORY_QUERY_KEY = "conversation-history" as const;

export function conversationHistoryQueryKey(
  assistantId: string | null,
  conversationId: string | null,
) {
  return [
    CONVERSATION_HISTORY_QUERY_KEY,
    assistantId ?? "",
    conversationId ?? "",
  ] as const;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseHistoryPaginationParams {
  assistantId: string | null;
  conversationId: string | null;
  enabled: boolean;
}

export interface HistoryPaginationResult {
  /** Flattened messages from all loaded pages, oldest first. */
  messages: DisplayMessage[];
  /** The latest (newest) page result — carries subagent notifications. */
  latestPage: PaginatedHistoryResult | undefined;
  /** First-time load with no cached data available. */
  isLoading: boolean;
  /** At least one successful fetch has completed. */
  isSuccess: boolean;
  /** The query errored. */
  isError: boolean;
  /** The error, if any. */
  error: Error | null;
  /** Older pages are available for infinite scroll. */
  hasMore: boolean;
  /** A fetch for older pages is in progress. */
  isFetchingOlderPages: boolean;
  /** Any fetch (initial, background refetch, or older pages) is active. */
  isFetching: boolean;
  /** Load the next older page. No-op if already fetching or exhausted. */
  fetchOlderPage: () => void;
  /** Invalidate and trigger a background refetch of the latest page. */
  invalidate: () => Promise<void>;
  /** Remove cached data for this conversation (used before a destructive refresh). */
  removeCache: () => void;
  /** Oldest timestamp from the initial (latest) page — reconciliation boundary. */
  latestPageOldestTimestamp: number | null;
  /** Oldest timestamp across all loaded pages — pagination cursor. */
  oldestLoadedTimestamp: number | null;
  /** Monotonic counter that increments on each data update. */
  dataUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_MESSAGES: DisplayMessage[] = [];

/**
 * Hard client-side deadline per history page fetch. A request that hangs at
 * the socket level (a WKWebView connection suspended while the app was
 * backgrounded is the canonical case) must FAIL so the query settles: a
 * `queryFn` that never resolves pins the query in `fetching` state forever,
 * and every subsequent catch-up trigger — `refetchOnMount` on re-entry,
 * the `sse.opened` invalidate, pull-to-refresh — dedupes into the hung
 * fetch and silently does nothing. That left a re-opened conversation
 * rendering a stale cached snapshot until the app was killed (Learn UAT,
 * mobile). Generous enough for a slow cell link fetching one 50-row page.
 */
const HISTORY_REQUEST_TIMEOUT_MS = 20_000;

export function useHistoryPagination({
  assistantId,
  conversationId,
  enabled,
}: UseHistoryPaginationParams): HistoryPaginationResult {
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => conversationHistoryQueryKey(assistantId, conversationId),
    [assistantId, conversationId],
  );

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      if (!assistantId || !conversationId) {
        throw new Error("Missing assistantId or conversationId");
      }
      // TQ's cancel signal (key switch / unmount) + a hard deadline so a
      // socket-level hang settles as an error instead of pinning the query
      // in `fetching` forever — see HISTORY_REQUEST_TIMEOUT_MS.
      const fetchSignal = withTimeout(signal, HISTORY_REQUEST_TIMEOUT_MS);
      if (pageParam != null) {
        return fetchOlderHistoryPage(
          assistantId,
          conversationId,
          pageParam,
          undefined,
          fetchSignal,
        );
      }
      return fetchLatestHistoryPage(
        assistantId,
        conversationId,
        undefined,
        fetchSignal,
      );
    },
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage): number | undefined => {
      if (lastPage.hasMore && lastPage.oldestTimestamp != null) {
        return lastPage.oldestTimestamp;
      }
      return undefined;
    },
    enabled: enabled && !!assistantId && !!conversationId,
    // Always refetch in the background — mirrors the existing
    // "restore from cache then fetch latest and reconcile" pattern.
    staleTime: 0,
    // Keep data for unmounted queries for 5 minutes. With an average
    // of ~10 active conversations, this is the rough equivalent of the
    // old MAX_CACHED_CONVERSATIONS = 10 LRU map.
    gcTime: 5 * 60 * 1000,
    refetchOnMount: true,
    // Refetch when the app returns to the foreground. "Focus" here is the
    // app's own lifecycle signal, not the raw DOM event: the global
    // focusManager is rebound to the event bus's `app.resume` / `app.hidden`
    // (see `lib/query-focus-manager.ts`), which covers Capacitor iOS where
    // `visibilitychange` never fires. A backgrounded device drops the SSE
    // stream silently, so the transcript on screen when the user comes back
    // may be minutes stale — the resume refetch is the catch-up path that
    // doesn't depend on the stream noticing it died.
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
    retry: shouldRetryDaemonError,
  });

  // Flatten pages into a single chronological array.
  // pages[0] = latest page (newest messages), pages[1] = older, etc.
  // Within each page, messages are already oldest-first.
  // Result: [...oldest-page.messages, ..., ...latest-page.messages]
  //
  // After flattening, fold any adjacent `role: "assistant"` rows that
  // landed on opposite sides of a page boundary back into a single
  // display message. The backend already merges consecutive assistants
  // within a single page (`mergeConsecutiveAssistantMessages` at query
  // time in conversation-routes.ts) — but each page runs that merge in
  // isolation, anchoring on its own oldest row. A long agent loop that
  // straddles N pages comes back as N split client objects, each with a
  // distinct anchor id, which dedupe-by-id can't reconcile. The fold
  // here closes that gap on the read path so a long turn renders as one
  // bubble regardless of how scroll-to-load chunked it.
  const messages = useMemo(() => {
    if (!query.data?.pages?.length) return EMPTY_MESSAGES;
    const { pages } = query.data;
    const flattened: DisplayMessage[] =
      pages.length === 1
        ? pages[0]!.messages
        : (() => {
            const acc: DisplayMessage[] = [];
            for (let i = pages.length - 1; i >= 0; i--) {
              acc.push(...pages[i]!.messages);
            }
            return acc;
          })();
    return mergeAdjacentAssistantMessages(flattened);
  }, [query.data]);

  const latestPage = query.data?.pages[0];
  const oldestPage = query.data?.pages[query.data.pages.length - 1];

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const removeCache = useCallback(() => {
    queryClient.removeQueries({ queryKey });
  }, [queryClient, queryKey]);

  const fetchOlderPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return {
    messages,
    latestPage,
    isLoading: query.isLoading,
    isSuccess: query.isSuccess,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage ?? false,
    isFetchingOlderPages: query.isFetchingNextPage,
    isFetching: query.isFetching,
    fetchOlderPage,
    invalidate,
    removeCache,
    latestPageOldestTimestamp: latestPage?.oldestTimestamp ?? null,
    oldestLoadedTimestamp: oldestPage?.oldestTimestamp ?? null,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
