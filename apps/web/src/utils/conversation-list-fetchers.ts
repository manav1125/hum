/**
 * Fetch functions and `queryOptions` factories for conversation lists
 * (foreground, background, scheduled, archived).
 *
 * Each fetcher returns a sorted `Conversation[]` from the daemon's paginated
 * `conversationsGet()` endpoint. The `queryOptions` factories co-locate
 * `queryKey` + `queryFn` + `staleTime` so consumers can spread them into
 * `useQuery()`, pass them to `queryClient.prefetchQuery()`, or destructure
 * `.queryKey` for imperative cache operations — all with full type safety.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-functions
 * - https://tanstack.com/query/latest/docs/eslint/prefer-query-options
 */

import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { captureError } from "@/lib/sentry/capture-error";
import { conversationsGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { toConversation } from "@/utils/conversation-transforms";

// ---------------------------------------------------------------------------
// Shared sort comparator
// ---------------------------------------------------------------------------

/** Sort conversations descending by a timestamp field (newest first). */
function byTimestampDesc(
  key: "lastMessageAt" | "archivedAt",
): (a: Conversation, b: Conversation) => number {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
}

// ---------------------------------------------------------------------------
// Internal pagination helper
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_PAGE_SIZE = 50;
const CONVERSATION_LIST_MAX_PAGES = 200;

type FetchConversationListOptions = {
  conversationType?: "background" | "scheduled";
  /**
   * Filter by archive state. Defaults to `"active"` on the daemon side, so
   * omitting this returns non-archived rows only — matching how the sidebar
   * wants to read the list. The Archive page passes `"archived"`.
   */
  archiveStatus?: "active" | "archived" | "all";
};

/** One page of a conversation list plus whether more pages exist. */
export type ConversationListPage = {
  conversations: Conversation[];
  hasMore: boolean;
};

async function fetchConversationListPage(
  assistantId: string,
  offset: number,
  options: FetchConversationListOptions = {},
): Promise<ConversationListPage> {
  const { conversationType, archiveStatus } = options;
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: {
      limit: CONVERSATION_LIST_PAGE_SIZE,
      offset,
      ...(conversationType ? { conversationType } : {}),
      ...(archiveStatus ? { archiveStatus } : {}),
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list conversations.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to list conversations.",
    );
    throw new ApiError(response.status, msg);
  }

  return {
    conversations: (data?.conversations ?? []).map(toConversation),
    hasMore: data?.hasMore ?? false,
  };
}

async function fetchConversationList(
  assistantId: string,
  options: FetchConversationListOptions = {},
): Promise<Conversation[]> {
  const all: Conversation[] = [];

  for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
    const { conversations, hasMore } = await fetchConversationListPage(
      assistantId,
      offset,
      options,
    );
    all.push(...conversations);

    if (!hasMore) break;

    if (conversations.length === 0) break;
  }

  return all;
}

// ---------------------------------------------------------------------------
// First-page-then-background-drain (foreground hot path)
//
// The foreground list is mounted on effectively every surface (sidebar,
// HQ, mobile Today, command palette), so its queryFn is on the cold-boot
// and focus critical path. Draining every page before resolving meant the
// list rendered nothing until ~8 sequential round-trips finished (~2.2 s
// at 360 conversations). Instead the queryFn resolves with page 0 in one
// round-trip and the remaining pages stream into the cache in the
// background via `setQueryData`.
// ---------------------------------------------------------------------------

/**
 * Reconcile one fetched first page into a cached newest-first list.
 *
 * - `hasMore === false`: the page is the complete list — replace the cache.
 * - Otherwise the fresh rows win, and cached rows absent from the page
 *   survive only when they sort strictly below the page's window (older
 *   than the oldest non-pinned fresh row). A cached row whose timestamp
 *   falls inside the window but is missing from the page no longer lives
 *   there (deleted or archived), so it is dropped. Pinned rows are
 *   excluded from the cutoff because the daemon appends every pinned
 *   conversation to page 1 regardless of age — an ancient pinned row
 *   would otherwise collapse the cutoff and drop live rows.
 * - Client-local draft rows always survive; the server doesn't know them.
 *
 * The fresh window leads the result; surviving rows keep their existing
 * relative order.
 *
 * Lives here (rather than `conversation-cache-mutations.ts`, which
 * re-exports it) so the first-page queryFn below can reuse it without an
 * import cycle.
 *
 * @internal Exported for testing.
 */
export function mergeListFirstPage(
  prev: Conversation[],
  page: ConversationListPage,
): Conversation[] {
  if (!page.hasMore) return page.conversations;
  const nonPinned = page.conversations.filter((c) => c.isPinned !== true);
  if (nonPinned.length === 0) return prev;
  const cutoff = Math.min(...nonPinned.map((c) => c.lastMessageAt ?? 0));
  const freshIds = new Set(page.conversations.map((c) => c.conversationId));
  const kept = prev.filter(
    (c) =>
      !freshIds.has(c.conversationId) &&
      (c.draft === true || (c.lastMessageAt ?? 0) < cutoff),
  );
  return [...page.conversations, ...kept];
}

/** In-flight background drains, keyed by assistantId — never stack two. */
const activeListDrains = new Set<string>();

/**
 * How many EXTRA pages a single background drain fetches beyond page 0.
 * The old unbounded drain walked every page on every cold load (8 sequential
 * GETs at ~360 conversations, hundreds at thousands) and could exhaust the
 * daemon's per-client rate budget by itself — UAT 2026-07-21 caught it
 * landing a self-inflicted 429 during app open. Two extra pages (150 rows
 * with page 0) cover every realistically visible window; older history loads
 * on demand via {@link loadMoreConversations} as the list scrolls.
 */
const DRAIN_MAX_EXTRA_PAGES = 2;
/** Breather between drained pages so the drain never bursts the limiter. */
const DRAIN_PAGE_GAP_MS = 250;

/**
 * Fetch up to {@link DRAIN_MAX_EXTRA_PAGES} more pages in the background and
 * merge the tail into the cached foreground list. Runs after the queryFn has
 * already resolved with page 0 so the sidebar paints in one round-trip while
 * the near-backlog streams in.
 *
 * Merge semantics depend on whether the drain reached the end of the list:
 * - Drained to the end → `window` is the complete server list: rows present
 *   in both take whichever version has the newer `lastMessageAt`; cache-only
 *   rows survive when they are client-local drafts or newer than the drain
 *   start (created mid-drain via SSE); everything else was deleted/archived
 *   server-side and is dropped.
 * - Capped (more pages exist) → `window` is only the newest slice: cached
 *   rows OLDER than the window's oldest row also survive, because the drain
 *   never observed them — dropping them would shrink an already-loaded list.
 */
function drainRemainingPagesInBackground(
  queryClient: QueryClient,
  assistantId: string,
  firstPage: ConversationListPage,
): void {
  if (!firstPage.hasMore || activeListDrains.has(assistantId)) return;
  activeListDrains.add(assistantId);
  const drainStartedAt = Date.now();

  void (async () => {
    try {
      const tail: Conversation[] = [];
      let sawEnd = false;
      for (let page = 1; page <= DRAIN_MAX_EXTRA_PAGES; page++) {
        await new Promise((r) => setTimeout(r, DRAIN_PAGE_GAP_MS));
        const { conversations, hasMore } = await fetchConversationListPage(
          assistantId,
          page * CONVERSATION_LIST_PAGE_SIZE,
        );
        tail.push(...conversations);
        if (!hasMore || conversations.length === 0) {
          sawEnd = true;
          break;
        }
      }

      const window = new Map<string, Conversation>();
      for (const c of [...firstPage.conversations, ...tail]) {
        if (!window.has(c.conversationId)) {
          window.set(c.conversationId, c);
        }
      }
      const windowRows = [...window.values()];
      const nonPinned = windowRows.filter((c) => c.isPinned !== true);
      const windowCutoff =
        nonPinned.length > 0
          ? Math.min(...nonPinned.map((c) => c.lastMessageAt ?? 0))
          : 0;

      queryClient.setQueryData<Conversation[]>(
        conversationsQueryKey(assistantId),
        (prev) => {
          const merged = new Map(window);
          for (const c of prev ?? []) {
            const auth = merged.get(c.conversationId);
            if (auth) {
              if ((c.lastMessageAt ?? 0) > (auth.lastMessageAt ?? 0)) {
                merged.set(c.conversationId, c);
              }
            } else if (
              c.draft === true ||
              (c.lastMessageAt ?? 0) >= drainStartedAt ||
              // Capped drain: rows below the drained window were never
              // observed — keep them rather than shrinking the list.
              (!sawEnd && (c.lastMessageAt ?? 0) < windowCutoff)
            ) {
              merged.set(c.conversationId, c);
            }
          }
          return [...merged.values()].sort(byTimestampDesc("lastMessageAt"));
        },
      );
    } catch (err) {
      // Best-effort: the visible window (page 0) already rendered; the tail
      // retries on the next fetch. Never surface a background-drain failure.
      captureError(err, {
        context: "conversation-list.background-drain",
        level: "warning",
        extra: { assistantId },
      });
    } finally {
      activeListDrains.delete(assistantId);
    }
  })();
}

/**
 * On-demand continuation for the capped drain: fetch one more page past what
 * the cache currently holds and append it. Callers (the conversation list's
 * scroll sentinel / "load more" affordance) invoke this as the user nears
 * the bottom. Returns whether more pages likely remain.
 */
export async function loadMoreConversations(
  queryClient: QueryClient,
  assistantId: string,
): Promise<{ hasMore: boolean }> {
  const cached =
    queryClient.getQueryData<Conversation[]>(
      conversationsQueryKey(assistantId),
    ) ?? [];
  const offset =
    Math.floor(cached.length / CONVERSATION_LIST_PAGE_SIZE) *
    CONVERSATION_LIST_PAGE_SIZE;
  const { conversations, hasMore } = await fetchConversationListPage(
    assistantId,
    offset,
  );
  queryClient.setQueryData<Conversation[]>(
    conversationsQueryKey(assistantId),
    (prev) => {
      const merged = new Map<string, Conversation>();
      for (const c of prev ?? []) merged.set(c.conversationId, c);
      for (const c of conversations) {
        const existing = merged.get(c.conversationId);
        if (!existing || (c.lastMessageAt ?? 0) > (existing.lastMessageAt ?? 0)) {
          merged.set(c.conversationId, c);
        }
      }
      return [...merged.values()].sort(byTimestampDesc("lastMessageAt"));
    },
  );
  return { hasMore };
}

// ---------------------------------------------------------------------------
// Merged list (foreground + background, deduplicated)
// ---------------------------------------------------------------------------

/**
 * Fetch active or archived conversations for an assistant — foreground and
 * background buckets fetched in parallel, deduplicated by `conversationId`,
 * and sorted. Used by the Archive page, which lists every conversation type
 * together.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the calling surface remains usable.
 *
 * @param archiveStatus — `"active"` or `"archived"` (archive page)
 * @param sortKey — which timestamp to sort descending by (default: `lastMessageAt`)
 */
async function fetchMergedConversationList(
  assistantId: string,
  archiveStatus: "active" | "archived" = "active",
  sortKey: "lastMessageAt" | "archivedAt" = "lastMessageAt",
): Promise<Conversation[]> {
  const opts: FetchConversationListOptions =
    archiveStatus === "active" ? {} : { archiveStatus };
  const bgOpts: FetchConversationListOptions = {
    ...opts,
    conversationType: "background",
  };

  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId, opts),
    fetchConversationList(assistantId, bgOpts),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    captureError(backgroundResult.reason, {
      context: `fetchMergedConversationList.background(${archiveStatus})`,
      level: "warning",
      extra: { assistantId },
    });
  }

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationId)) continue;
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort(byTimestampDesc(sortKey));
  return conversations;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch all active (non-archived) foreground conversations for a given
 * assistant, sorted newest-first.
 *
 * Background and scheduled jobs are intentionally excluded — they load
 * through `listBackgroundConversations` / `listScheduledConversations` only
 * once the user expands the Background/Scheduled sidebar sections, so a large
 * background backlog never blocks the initial chat render (the conversation
 * the user actually opened).
 *
 * Hot-path shape: resolves after **one** round-trip with the newest page
 * merged over whatever the cache already holds (so a refetch never shrinks
 * a fully-drained list back to 50 rows), then streams the remaining pages
 * into the cache in the background when a `queryClient` is provided. When
 * no `queryClient` is available (non-TQ callers), it falls back to the
 * full serial drain so the returned list is always complete.
 */
export async function listConversations(
  assistantId: string,
  queryClient?: QueryClient,
): Promise<Conversation[]> {
  if (!queryClient) {
    const foreground = await fetchConversationList(assistantId);
    return [...foreground].sort(byTimestampDesc("lastMessageAt"));
  }

  const firstPage = await listConversationsFirstPage(assistantId);
  drainRemainingPagesInBackground(queryClient, assistantId, firstPage);

  if (!firstPage.hasMore) return firstPage.conversations;
  const prev = queryClient.getQueryData<Conversation[]>(
    conversationsQueryKey(assistantId),
  );
  return prev ? mergeListFirstPage(prev, firstPage) : firstPage.conversations;
}

/**
 * Fetch all active (non-archived) background conversations for a given
 * assistant, sorted newest-first.
 *
 * The daemon's `conversationType=background` filter is the back-compat
 * umbrella that also returns scheduled rows, so those are filtered out here
 * to keep the background cache disjoint from the scheduled cache (one
 * conversation, one cache). Scheduled jobs load through
 * `listScheduledConversations` instead.
 *
 * Mounted lazily by the sidebar — only enabled once the user reveals the
 * Background section — so this never runs on the initial load path. Cached
 * separately from the foreground list under `backgroundConversationsQueryKey`.
 */
export async function listBackgroundConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const background = await fetchConversationList(assistantId, {
    conversationType: "background",
  });
  return background
    .filter((c) => !isScheduledConversation(c))
    .sort(byTimestampDesc("lastMessageAt"));
}

/**
 * Fetch all active (non-archived) scheduled conversations for a given
 * assistant, sorted newest-first.
 *
 * Uses the daemon's dedicated `conversationType=scheduled` filter so the
 * Scheduled sidebar section can load independently of the background
 * backlog. Mounted lazily — only enabled once the user reveals the
 * Scheduled section — so this never runs on the initial load path. Cached
 * separately under `scheduledConversationsQueryKey`.
 */
export async function listScheduledConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const scheduled = await fetchConversationList(assistantId, {
    conversationType: "scheduled",
  });
  return [...scheduled].sort(byTimestampDesc("lastMessageAt"));
}

/**
 * Fetch all archived conversations for the archive page.
 * Sorted by `archivedAt` descending (most recently archived first).
 */
export async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  return fetchMergedConversationList(assistantId, "archived", "archivedAt");
}

// ---------------------------------------------------------------------------
// First-page fetchers
//
// Single-request variants of the list fetchers above, used by the
// sync_changed consumer to refresh the top of a cached list without
// re-draining every page. At thousands of conversations the full drain is
// hundreds of sequential GETs, which exhausts the daemon's per-client
// rate-limit budget when sync events arrive continuously during an active
// turn. Each returns the bucket's newest rows (one page, already filtered
// and sorted with the same semantics as its full-list counterpart) plus
// `hasMore` so callers can tell a complete list from a window.
// ---------------------------------------------------------------------------

/** First page of {@link listConversations} (foreground bucket). */
export async function listConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0);
  return {
    ...page,
    conversations: [...page.conversations].sort(
      byTimestampDesc("lastMessageAt"),
    ),
  };
}

/** First page of {@link listBackgroundConversations} (background bucket). */
export async function listBackgroundConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "background",
  });
  return {
    ...page,
    conversations: page.conversations
      .filter((c) => !isScheduledConversation(c))
      .sort(byTimestampDesc("lastMessageAt")),
  };
}

/** First page of {@link listScheduledConversations} (scheduled bucket). */
export async function listScheduledConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "scheduled",
  });
  return {
    ...page,
    conversations: [...page.conversations].sort(
      byTimestampDesc("lastMessageAt"),
    ),
  };
}

// ---------------------------------------------------------------------------
// queryOptions factories
//
// Co-locate queryKey + queryFn + staleTime so hooks can spread them into
// useQuery() and imperative callers can use .queryKey for cache operations.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
// - https://tkdodo.eu/blog/the-query-options-api
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Foreground list staleness: the `conversations:list` sync tag (SSE) keeps
 * this cache fresh via `refreshConversationListWindows`, and reconnect gaps
 * are swept by `use-conversation-sync`. Focus/navigation refetches are
 * therefore redundant belt-and-braces that used to re-trigger the full
 * pagination walk on every window focus — hence the long staleTime and
 * `refetchOnWindowFocus: false`.
 */
const FOREGROUND_LIST_STALE_TIME_MS = 5 * 60_000;

/**
 * Query options for the foreground conversation list. Spread into
 * `useQuery()` and override `enabled` at the hook level.
 *
 * The queryFn resolves with page 0 in one round-trip and background-drains
 * the remaining pages into the cache — see `listConversations`.
 */
export function conversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: conversationsQueryKey(assistantId),
    queryFn: ({ client }) => listConversations(assistantId, client),
    staleTime: FOREGROUND_LIST_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Query options for the background conversation list.
 */
export function backgroundConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: backgroundConversationsQueryKey(assistantId),
    queryFn: () => listBackgroundConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the scheduled conversation list.
 */
export function scheduledConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: scheduledConversationsQueryKey(assistantId),
    queryFn: () => listScheduledConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the archived conversation list.
 */
export function archivedConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => listArchivedConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}
