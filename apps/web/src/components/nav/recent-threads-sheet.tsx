/**
 * "Where are my conversations?" — the top-left answer, on every phone surface.
 *
 * ## The report
 *
 * *"there is no easy way to navigate back to the live chat threads /
 * conversations that the user has been having with cue. we need to add it in a
 * simple way the same way other llm's have it on the top left."* — the owner,
 * on a build where a conversation's header read `‹ Cue ⋯` and the ONLY door to
 * his 151 threads was a row inside the top-RIGHT account sheet.
 *
 * ## What the top-left is, per surface, and why
 *
 * | surface                         | top-left                    |
 * |---------------------------------|-----------------------------|
 * | HQ · Work · /conversations      | ☰ → this sheet              |
 * | a conversation (`/…/:id`)       | ‹ back, then ☰ → this sheet |
 *
 * One glyph, one meaning, everywhere: **☰ is your chats**. It is a sheet and
 * not a route because switching threads is not a journey — ChatGPT and Claude
 * both drop a list over what you were reading and put you back in one tap, and
 * that is the convention the report asks for by name.
 *
 * On a conversation the switcher does NOT replace the back chevron. `‹` pops to
 * where you actually came from (Today, a project, a search hit) and is the
 * screen's only chevron exit; the thread list is a different destination, so
 * folding them into one control would silently take one of them away. They are
 * two 44px controls in a row that also holds a title — see
 * `conversation-header-metrics.ts`, which owns that arithmetic and is asserted
 * against the narrowest phone this app supports, because the last time
 * something was added to a phone header without measuring it the Work screen's
 * title shipped reading `☰ork`.
 *
 * ## The number that was not a number
 *
 * The sheet the report was filed against said **"All conversations · 151"**.
 * Measured against prod on the same account, with a real session:
 *
 *     the menu's label                    151
 *     GET /v1/conversations?limit=500     420
 *     SELECT COUNT(*) on the database    1188
 *
 * 151 was not a total of anything. `useConversationListQuery` resolves page 0
 * (50 rows) and background-drains two more, so `conversations.length` is *how
 * much this client has fetched* — 150 plus a draft — and it grows as the index
 * page's "Older chats" is tapped. The daemon returns `hasMore` and no count,
 * and there is no count endpoint, so a true total is not available at any
 * price this sheet can pay.
 *
 * Hence {@link allConversationsSub}: the count prints ONLY when it is provably
 * whole — a cached list shorter than one page proves the server had no second
 * page — and otherwise the row says, in words, that it reaches further than
 * what is above it. Both sheets that carry this row read that one function, so
 * the phone cannot go back to quoting its own cache size at the owner.
 *
 * The rest of the honesty rules, unchanged: no number while loading, none when
 * the read failed, and a failed read still renders the row (fail-open) — an
 * outage may not remove a door, and it may not invent a figure either.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router";

import {
  MenuSheet,
  type MenuEntry,
} from "@/components/nav/menu-sheet";
import {
  navigateToConversation,
  navigateToNewConversation,
} from "@/domains/chat/utils/conversation-navigation";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import type { Conversation } from "@/types/conversation-types";
import { CONVERSATION_LIST_PAGE_SIZE } from "@/utils/conversation-list-fetchers";
import { routes } from "@/utils/routes";

/**
 * How many threads the switcher shows before handing off to the full list.
 *
 * Seven is what fits above the sheet's 72% ceiling next to the two footer rows
 * on a 6.1" phone without the list itself scrolling. More is not better here:
 * the sheet is a switcher, and anything past "the ones I was just in" is what
 * "All conversations" is for.
 */
export const RECENT_THREADS_SHOWN = 7;

/** A thread with no title yet. Not "New chat" — that is the ACTION below it. */
export const UNTITLED_THREAD_LABEL = "Untitled chat";

/**
 * The threads the switcher lists: live ones, most-recently-spoken-to first.
 *
 * Sorted here rather than trusting the query's order — the list is assembled
 * from more than one source (foreground + optimistic drafts) and "recent" is
 * the only ordering that makes a switcher usable.
 */
export function recentThreads(
  conversations: readonly Conversation[],
  limit: number = RECENT_THREADS_SHOWN,
): Conversation[] {
  return conversations
    .filter((c) => !c.archivedAt)
    .slice()
    .sort(
      (a, b) =>
        (b.lastMessageAt ?? b.createdAt ?? 0) -
        (a.lastMessageAt ?? a.createdAt ?? 0),
    )
    .slice(0, limit);
}

/**
 * What goes under "All conversations" — a count only when it is the truth.
 *
 * The one thing a client can prove without a total: page 0 asks for
 * {@link CONVERSATION_LIST_PAGE_SIZE} rows and returns `min(pageSize, total)`,
 * so a cached list SHORTER than a page is the entire list. At or above it, the
 * list is a window of unknown depth — the owner's phone held 151 of 420 — and
 * the row says so in words rather than quoting the window back as a total.
 *
 * Shared by the ☰ switcher and the ⓶ sheet's ledger row. Two sheets printing
 * one number two ways is how the 151 survived as long as it did.
 */
export function allConversationsSub(
  loaded: number,
  state: { isLoading: boolean; isError: boolean },
): string | null {
  // Not known yet, and not knowable — never a `0` standing in for either.
  if (state.isLoading || state.isError || loaded === 0) return null;
  if (loaded < CONVERSATION_LIST_PAGE_SIZE) return String(loaded);
  return "Everything, including older threads";
}

export interface RecentThreadsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Null before an assistant resolves — the sheet still opens and says so. */
  assistantId: string | null;
  /**
   * Rows appended below a hairline. The corner ☰ passes Search and Add tasks
   * (it is the only door to those on a phone); inside a conversation there are
   * none, because the thread's own composer already is that.
   */
  extras?: MenuEntry[];
}

export function RecentThreadsSheet({
  open,
  onClose,
  assistantId,
  extras,
}: RecentThreadsSheetProps) {
  const navigate = useNavigate();
  // Only subscribes while the sheet is open: this chrome is mounted on every
  // primary route, and a switcher nobody opened should not be fetching.
  const { conversations, isLoading, isError } = useConversationListQuery(
    assistantId,
    open,
  );

  const recent = useMemo(
    () => (open ? recentThreads(conversations) : []),
    [open, conversations],
  );

  const items: MenuEntry[] = [];

  recent.forEach((conversation, i) => {
    items.push({
      key: `thread:${conversation.conversationId}`,
      group: i === 0 ? "Recent" : undefined,
      label: conversation.title?.trim() || UNTITLED_THREAD_LABEL,
      run: () => navigateToConversation(navigate, conversation.conversationId),
    });
  });

  items.push({
    key: "all-conversations",
    // When there is nothing above it this row starts the group itself, and
    // carries the reason the group is empty.
    group: recent.length === 0 ? "Recent" : undefined,
    noteAbove:
      recent.length > 0
        ? undefined
        : isError
          ? "Couldn't load your chats just now. The full list is still here."
          : isLoading
            ? "Loading your chats…"
            : assistantId
              ? "No chats yet — the first thing you say to Cue starts one."
              : "No workspace open yet.",
    label: "All conversations",
    sub: allConversationsSub(conversations.length, { isLoading, isError }),
    run: () => void navigate(routes.conversations),
    rule: recent.length > 0,
  });

  items.push({
    key: "new-chat",
    label: "New chat",
    run: () => navigateToNewConversation(navigate),
  });

  // The hairline belongs to the JOIN, not to whatever the caller happened to
  // pass first — so it is applied here rather than asked for.
  (extras ?? []).forEach((extra, i) => {
    items.push(i === 0 ? { ...extra, rule: true } : extra);
  });

  return (
    <MenuSheet open={open} onClose={onClose} label="Your chats" items={items} />
  );
}
