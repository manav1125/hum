/**
 * Chats-index search — reach every thread, or say what was reached.
 *
 * ## The defect
 *
 * The phone's Chats index filtered `title.includes(q)` over whatever the client
 * had drained. Measured against prod on the owner's account:
 *
 *     the index's default page                       50
 *     GET /v1/conversations?limit=500               420
 *     SELECT COUNT(*) on the database              1188
 *
 * So searching for a thread from two weeks ago rendered "No chats match." — a
 * sentence about the corpus, produced by a function that had only ever seen the
 * first page of it. Same defect class as the sibling sheet's "All conversations
 * · 151", where a page size was printed as a total: a result set implying more
 * than it is.
 *
 * ## What the daemon actually offers
 *
 * `GET /v1/search/global?categories=conversations` — already there, already
 * generated, already wrapped by `domains/chat/api/global-search.ts`. It is not a
 * filter over a page: `searchConversations` runs FTS across `messages` and a
 * LIKE across `conversations.title` over the WHOLE database, excludes archived
 * rows, and orders by `updated_at`. It reaches all 1188. No new route was
 * needed, and none was added.
 *
 * That endpoint also searches message BODIES, which the title filter never did
 * — so this is not merely a wider net, it is a different and better one.
 *
 * ## When it can't reach everything, it says so
 *
 * The shared fetch returns a discriminated `GlobalSearchOutcome`, so a 500 and a
 * dropped session cannot arrive as "nothing found". When it fails, this module
 * falls back to the local title filter — a door stays open (fail-open) — but the
 * surface is handed {@link loadedOnlyNote} and must render it INSTEAD of an
 * empty state. "No chats match" is only ever said about a search that happened.
 *
 * The vocabulary is the sibling's, deliberately. `allConversationsSub()` prints
 * a count only when provably whole and otherwise says "Everything, including
 * older threads"; here a count prints only when the index answered and did not
 * truncate, and the degraded line names the bound in words.
 */
import {
  searchGlobal,
  type GlobalSearchResponse,
} from "@/domains/chat/api/global-search";
import type { Conversation } from "@/types/conversation-types";

/**
 * The daemon clamps `limit` to 100 (`global-search-routes.ts`), so asking for
 * more would silently get 100 back and let us believe it was the whole answer.
 * Ask for exactly the cap, and treat a full page as "there may be more".
 */
export const CHAT_SEARCH_LIMIT = 100;

/** Long enough that typing doesn't fan out a request per keystroke. */
export const CHAT_SEARCH_DEBOUNCE_MS = 200;

/** One tail, so both degraded reasons name the same bound the same way. */
const LOADED_ONLY_TAIL =
  "These are matches from the chats already loaded — older threads weren't searched.";

type ConversationHit = NonNullable<GlobalSearchResponse["conversations"]>[number];

/**
 * What the search box is currently showing, and how much of the corpus is
 * behind it. `rows` is never a lie by omission: in `loaded_only` it is
 * accompanied by a `note` the surface is required to render.
 */
export type ChatSearchState =
  | { status: "idle" }
  /** In flight. `rows` are the local matches, shown so the field feels live. */
  | { status: "searching"; query: string; rows: Conversation[] }
  /** The index answered. Every thread was searched. */
  | { status: "whole"; query: string; rows: Conversation[]; truncated: boolean }
  /** The index did not answer. Only the drained window was searched. */
  | { status: "loaded_only"; query: string; rows: Conversation[]; note: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The old behaviour, kept for exactly one job: the fallback when the index is
 * unreachable, and the instant feedback while it is being asked. It is never
 * the whole answer, and every caller pairs it with a note that says so.
 */
export function localTitleMatches(
  conversations: readonly Conversation[],
  query: string,
): Conversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return conversations.filter(
    (c) => !c.archivedAt && (c.title ?? "").toLowerCase().includes(q),
  );
}

function recency(c: Conversation): number {
  return c.lastMessageAt ?? c.createdAt ?? 0;
}

/**
 * Server hits ∪ local title matches, newest first.
 *
 * The union matters both ways. Most hits are threads this client has never
 * fetched — that is the whole point. But a thread renamed a second ago, or an
 * optimistic draft, exists locally and not yet in the index; dropping it would
 * make search briefly forget a conversation the user is looking straight at.
 *
 * A hit that IS loaded keeps its local `Conversation` object, so its row renders
 * the same receipts, pin state and title the un-searched list would give it.
 */
export function mergeSearchHits(
  hits: readonly ConversationHit[],
  loaded: readonly Conversation[],
  query: string,
): Conversation[] {
  const byId = new Map(loaded.map((c) => [c.conversationId, c]));
  const merged = new Map<string, Conversation>();

  for (const hit of hits) {
    const local = byId.get(hit.id);
    if (local) {
      // The index excludes archived rows; a local copy could still be marked
      // archived optimistically, and the user's own archive wins.
      if (!local.archivedAt) merged.set(hit.id, local);
      continue;
    }
    const title = hit.title?.trim();
    merged.set(hit.id, {
      conversationId: hit.id,
      ...(title ? { title } : {}),
      ...(hit.updatedAt ? { lastMessageAt: hit.updatedAt } : {}),
    });
  }

  for (const c of localTitleMatches(loaded, query)) {
    if (!merged.has(c.conversationId)) merged.set(c.conversationId, c);
  }

  return [...merged.values()].sort((a, b) => recency(b) - recency(a));
}

/**
 * The line under a degraded search. Mirrors `searchFailureMessage()`'s opening
 * clause on purpose — one error vocabulary across both search surfaces — but
 * does not reuse its "Nothing was searched", because here something was: the
 * loaded window. Saying otherwise would be the same defect pointed the other
 * way.
 */
export function loadedOnlyNote(
  reason:
    | { kind: "error"; httpStatus?: number | undefined }
    | { kind: "unavailable" },
): string {
  if (reason.kind === "unavailable") {
    return `I'm not connected to your Cue yet, so I couldn't search the index. ${LOADED_ONLY_TAIL}`;
  }
  const code = reason.httpStatus ? ` (${reason.httpStatus})` : "";
  return `I couldn't reach my search index${code}. ${LOADED_ONLY_TAIL}`;
}

/**
 * The line under a search that DID reach everything.
 *
 * A count prints only when it is provably whole — the index answered and gave
 * back fewer rows than the cap it would have truncated at. A full page proves
 * only that there were at least that many, so it says that instead.
 */
export function wholeScopeNote(rowCount: number, truncated: boolean): string {
  if (truncated) {
    return `Showing the ${CHAT_SEARCH_LIMIT} most recent matches — there are more.`;
  }
  if (rowCount === 0) return "Searched everything, including older threads.";
  return rowCount === 1
    ? "1 match, including older threads."
    : `${rowCount} matches, including older threads.`;
}

/** The scope line for whatever state the box is in. `null` only when idle. */
export function scopeNote(state: ChatSearchState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "searching":
      return "Searching all your chats…";
    case "whole":
      return wholeScopeNote(state.rows.length, state.truncated);
    case "loaded_only":
      return state.note;
  }
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/**
 * Run one chats search and fold the shared outcome into a {@link ChatSearchState}.
 *
 * Returns `null` for a superseded keystroke — the caller keeps what it had
 * rather than repainting. Folding a cancellation into an empty `whole` would be
 * the original bug in miniature.
 */
export async function runChatSearch(
  assistantId: string | null,
  query: string,
  loaded: readonly Conversation[],
  signal?: AbortSignal,
): Promise<ChatSearchState | null> {
  const trimmed = query.trim();
  if (!trimmed) return { status: "idle" };

  const outcome = await searchGlobal(assistantId, trimmed, {
    categories: ["conversations"],
    limit: CHAT_SEARCH_LIMIT,
    ...(signal ? { signal } : {}),
  });

  switch (outcome.status) {
    case "cancelled":
      return null;
    case "ok": {
      const hits = outcome.results.conversations ?? [];
      return {
        status: "whole",
        query: trimmed,
        rows: mergeSearchHits(hits, loaded, trimmed),
        truncated: hits.length >= CHAT_SEARCH_LIMIT,
      };
    }
    case "unavailable":
      return {
        status: "loaded_only",
        query: trimmed,
        rows: localTitleMatches(loaded, trimmed),
        note: loadedOnlyNote({ kind: "unavailable" }),
      };
    case "error":
      return {
        status: "loaded_only",
        query: trimmed,
        rows: localTitleMatches(loaded, trimmed),
        note: loadedOnlyNote({
          kind: "error",
          httpStatus: outcome.httpStatus,
        }),
      };
  }
}
