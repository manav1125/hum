/**
 * Mv3ChatsIndex — the mobile v3 Chats index (spec frame 21): "conversations
 * with receipts". Rendered by the MOBILE conversation drawer only (see
 * `chat-layout.tsx`); the desktop sidebar rail is untouched.
 *
 * Spec-verbatim slots:
 *   · "Chats" large title (28/700 −.7px — via LargeTitleHeader, 29px)
 *   · search field under the title
 *   · rows: glass cards, title 14/600 + right-aligned time (10.5 muted),
 *     receipt line under: live runs pulse (equalizer bars + progress note in
 *     microlabel blue), ✓ done / ◱ review / ‖ needs-you / ✕ failed lines
 *
 * DATA HONESTY — receipts ride real signals only:
 *   · running: the conversation is in `processingConversationIds` (live SSE
 *     signal) or its latest work item is `running` (+ real lastProgressNote)
 *   · needs-you: `attentionConversationIds` (a real pending interaction)
 *   · review / done / failed: the latest work item whose
 *     `lastRunConversationId` is this conversation
 *   Conversations with none of these render as plain rows (no fake receipts).
 *
 * SEARCH SCOPE — server-side, across every thread. The box used to filter
 * `title.includes(q)` over the drained window (page 0 is 50 rows; the owner has
 * 420 reachable and 1188 in the database), so a thread from two weeks ago came
 * back as "No chats match." — a claim about the corpus made by a function that
 * had seen the first page of it. It now runs the daemon's
 * `GET /v1/search/global?categories=conversations`, which is FTS over message
 * bodies plus a title LIKE over the WHOLE database. When that call fails the
 * surface falls back to the old local filter and RENDERS WHY, instead of an
 * empty state that means something else. See `chats-search.ts`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Plus, Search, X } from "lucide-react";

import { workitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  useBookmarkStore,
  type BookmarkSummary,
} from "@/stores/bookmark-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { GlassCard } from "../glass-card";
import { LargeTitleHeader } from "../large-title-header";

import {
  CHAT_SEARCH_DEBOUNCE_MS,
  localTitleMatches,
  runChatSearch,
  scopeNote,
  type ChatSearchState,
} from "./chats-search";

/** "9:41" today · "Thu" this week · "Jul 3" older (frame 21's time column). */
function timeLabel(epochMs: number | undefined): string {
  if (!epochMs) return "";
  const then = new Date(epochMs);
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) {
    return then.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const ageDays = (now.getTime() - then.getTime()) / 86_400_000;
  if (ageDays < 7)
    return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The 2-bar live equalizer from frame 21's running row (1.8px bars, 8px). */
function LiveBars() {
  return (
    <span
      aria-hidden
      style={{
        display: "flex",
        gap: 1.2,
        height: 8,
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      {[0, 0.3].map((d) => (
        <span
          key={d}
          style={{
            width: 1.8,
            height: "100%",
            background: "var(--mv3-accent)",
            borderRadius: 1,
            animation: `mv3Bar .9s ease-in-out ${d}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

type ReceiptKind = "running" | "needs_you" | "review" | "done" | "failed";

interface Receipt {
  kind: ReceiptKind;
  text: string;
}

/** Receipt glyph + hue per the mv3 state taxonomy (text stays muted). */
const RECEIPT_GLYPH: Record<
  Exclude<ReceiptKind, "running">,
  {
    glyph: string;
    color: string;
  }
> = {
  needs_you: { glyph: "‖", color: "var(--mv3-amber)" },
  review: { glyph: "◱", color: "var(--mv3-violet)" },
  done: { glyph: "✓", color: "var(--mv3-green)" },
  failed: { glyph: "✕", color: "#e5675b" },
};

function receiptFor(
  conversation: Conversation,
  latestItem: HqWorkItem | undefined,
  processing: boolean,
  attention: boolean,
): Receipt | null {
  if (processing || latestItem?.status === "running") {
    const note = latestItem?.lastProgressNote;
    return { kind: "running", text: note ? `${note}` : "Working…" };
  }
  if (attention) return { kind: "needs_you", text: "Needs you" };
  if (!latestItem) return null;
  switch (latestItem.status) {
    case "awaiting_review":
      return { kind: "review", text: `${latestItem.title} — ready for review` };
    case "done":
      return { kind: "done", text: latestItem.title };
    case "failed":
      return { kind: "failed", text: `Couldn't finish — ${latestItem.title}` };
    default:
      return null;
  }
}

function ReceiptLine({ receipt }: { receipt: Receipt }) {
  if (receipt.kind === "running") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginTop: 5,
          minWidth: 0,
        }}
      >
        <LiveBars />
        <span
          style={{
            fontSize: 12,
            color: "var(--mv3-micro)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {receipt.text}
        </span>
      </div>
    );
  }
  const meta = RECEIPT_GLYPH[receipt.kind];
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--mv3-muted)",
        marginTop: 5,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ color: meta.color }}>
        {meta.glyph}
      </span>{" "}
      {receipt.text}
    </div>
  );
}

/** The small filter pill above the rows (All / Bookmarked). */
function IndexFilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      aria-pressed={active}
      onClick={() => {
        haptic.light();
        onClick();
      }}
      style={{
        minHeight: 32,
        padding: "5px 13px",
        borderRadius: 99,
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        fontFamily: "inherit",
        cursor: "pointer",
        color: active ? "var(--mv3-text)" : "var(--mv3-muted)",
        background: active ? "var(--mv3-card)" : "transparent",
        border: `1px solid ${
          active ? "var(--mv3-card-border)" : "transparent"
        }`,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {label}
    </button>
  );
}

/**
 * The Bookmarked view's rows — snippet + thread link + remove, as glass
 * cards. Tapping the card opens the thread; ✕ removes the bookmark. The
 * empty state is design's copy, verbatim (v37 ruling 3): the long-press it
 * names is the tap-and-hold that reveals the message action row where the
 * bookmark toggle lives.
 */
function BookmarkedRows({
  assistantId,
  bookmarks,
  onSelectConversation,
}: {
  assistantId: string | null;
  bookmarks: readonly BookmarkSummary[];
  onSelectConversation: (conversationId: string) => void;
}) {
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  if (bookmarks.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--mv3-muted)",
          padding: "32px 12px",
        }}
      >
        Nothing saved yet — long-press any message to keep it here.
      </div>
    );
  }

  return (
    <>
      {bookmarks.map((bookmark, i) => (
        <GlassCard
          key={bookmark.id}
          radius={18}
          padding="13px 15px"
          // PERF: cap live backdrop-filter layers, matching the chat rows.
          blur={i < 6}
          role="button"
          aria-label={`Open chat: ${
            bookmark.conversationTitle?.trim() || "Untitled conversation"
          }`}
          tabIndex={0}
          onClick={() => {
            haptic.light();
            onSelectConversation(bookmark.conversationId);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectConversation(bookmark.conversationId);
            }
          }}
          style={{ cursor: "pointer", minHeight: 44 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bookmark.conversationTitle?.trim() || "Untitled conversation"}
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: "var(--mv3-muted)",
                flexShrink: 0,
              }}
            >
              {timeLabel(bookmark.createdAt)}
            </span>
            <button
              type="button"
              className="cue-pressable"
              aria-label="Remove bookmark"
              disabled={pendingRemoveId === bookmark.messageId}
              onClick={(e) => {
                e.stopPropagation();
                if (!assistantId) return;
                haptic.light();
                setPendingRemoveId(bookmark.messageId);
                void useBookmarkStore
                  .getState()
                  .removeBookmark(assistantId, bookmark.messageId)
                  .finally(() => setPendingRemoveId(null));
              }}
              style={{
                flexShrink: 0,
                background: "transparent",
                border: "none",
                padding: "4px 2px 4px 6px",
                color: "var(--mv3-muted)",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          {bookmark.messagePreview ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--mv3-muted)",
                marginTop: 5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bookmark.messagePreview}
            </div>
          ) : null}
        </GlassCard>
      ))}
    </>
  );
}

export interface Mv3ChatsIndexProps {
  assistantId: string | null;
  conversations: Conversation[];
  processingConversationIds: ReadonlySet<string>;
  attentionConversationIds: ReadonlySet<string>;
  onSelectConversation: (conversationId: string) => void;
  onStartNewConversation: () => void;
  onClose?: () => void;
  /**
   * Called just before navigating to another SURFACE (the Apps row). The
   * drawer passes its close so it doesn't hang over the destination; the
   * full-page usage passes nothing, because there is no overlay to dismiss.
   *
   * Deliberately NOT `onClose`. That prop means two different things by
   * caller — `closeDrawer()` in the drawer, but `goBackWithFallback(navigate,
   * routes.hq)` on the page — so calling it before a navigate fired a history
   * pop that resolved AFTER the push and landed the owner back on home. Only
   * the drawer has anything to dismiss, so only the drawer passes this.
   */
  onLeaveForSurface?: () => void;
  /**
   * Fetches the next page of older conversations (the boot drain is capped at
   * 3 pages). Resolves with whether more likely remain; the row hides itself
   * when it resolves false. Omitted → no load-more affordance (drawer usage
   * inside a chat keeps the lighter list).
   */
  onLoadMore?: () => Promise<{ hasMore: boolean }>;
}

export function Mv3ChatsIndex({
  assistantId,
  conversations,
  processingConversationIds,
  attentionConversationIds,
  onSelectConversation,
  onStartNewConversation,
  onClose,
  onLeaveForSurface,
  onLoadMore,
}: Mv3ChatsIndexProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  // Apps is the ONLY `SIDEBAR_DESTINATIONS` row with no other door on a phone.
  // Connectors, Skills and Agents were promoted to the rail from Your Cue but
  // kept their leaves, so the avatar → "All of Your Cue" still reaches them;
  // Apps was added straight to the rail (owner decision, 2026-08-10), and
  // `chat-layout` renders the rail only when `!isMobile`. The surface was
  // therefore unreachable on mobile entirely — the iOS overlay could render an
  // embedded app that nothing could navigate to.
  //
  // `MOBILE_DRAWER_DESTINATION_KEYS` is the declared version of that fact;
  // nav-model's suite asserts this drawer covers every rail row without another
  // phone door, so adding a rail row without a door fails there rather than on
  // someone's phone.
  //
  // Gated on the same `ventureverse-apps` flag as the desktop row and the page
  // itself, which redirects to HQ when the flag is off. An ungated row here
  // would be a door onto a bounce.
  //
  // `hasHydrated` is part of the gate, not belt-and-braces: the store types
  // flags as Record<string, boolean>, so an unknown key reads as falsy and the
  // row would otherwise appear the moment the first real /feature-flags
  // response lands — a flash-and-yank on every drawer open. The desktop row
  // takes the same pair for the same reason.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const ventureverseAppsOn =
    useAssistantFeatureFlagStore.use.ventureverseApps();
  const appsEnabled = flagsHydrated && ventureverseAppsOn;
  const openApps = () => {
    haptic.light();
    // `onLeaveForSurface`, never `onClose` — see the prop's docs. The page's
    // onClose is a history BACK, which resolved after this push and bounced
    // the owner to home instead of opening Apps.
    onLeaveForSurface?.();
    void navigate(routes.ventureverseApps.root);
  };
  const [loadMore, setLoadMore] = useState<{
    busy: boolean;
    exhausted: boolean;
  }>({ busy: false, exhausted: false });

  // Bookmarks live with conversations now (v37 ruling 3): a "Bookmarked"
  // filter at the top of the mobile ☰ index. Flag-gated like the message
  // action itself (the bookmark toggle in the tap-to-reveal action row).
  const bookmarksEnabled = useClientFeatureFlagStore.use.bookmarks();
  const bookmarks = useBookmarkStore.use.bookmarks();
  const [showBookmarked, setShowBookmarked] = useState(false);
  useEffect(() => {
    if (bookmarksEnabled && assistantId) {
      void useBookmarkStore
        .getState()
        .loadBookmarks(assistantId, { force: true });
    }
  }, [bookmarksEnabled, assistantId]);

  // Work receipts: the full work-item bucket, mapped conversation → latest
  // item by `lastRunConversationId`. Same generated endpoint HQ uses; TanStack
  // dedupes with any other consumer.
  const workItemsQuery = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: {},
    }),
    enabled: Boolean(assistantId),
    staleTime: 15_000,
  });
  const latestByConversation = useMemo(() => {
    const map = new Map<string, HqWorkItem>();
    for (const item of (workItemsQuery.data?.items ?? []) as HqWorkItem[]) {
      if (!item.lastRunConversationId) continue;
      const existing = map.get(item.lastRunConversationId);
      if (!existing || item.updatedAt > existing.updatedAt) {
        map.set(item.lastRunConversationId, item);
      }
    }
    return map;
  }, [workItemsQuery.data]);

  const live = useMemo(
    () => conversations.filter((c) => !c.archivedAt),
    [conversations],
  );

  // Debounced server-side search. `live` is deliberately NOT a dependency: it
  // changes identity on every list refetch, and re-firing the request on each
  // would turn a background drain into a request storm. The fallback rows it
  // feeds are read at call time, which is fresh enough for a fallback.
  const liveRef = useRef(live);
  // Declared before the search effect so effect order guarantees the ref is
  // fresh by the time a query change reads it.
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const [search, setSearch] = useState<ChatSearchState>({ status: "idle" });

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearch({ status: "idle" });
      return;
    }
    // Local matches paint immediately so the field feels live; the note under
    // it says a search is still running, so this is never mistaken for the
    // whole answer.
    setSearch({
      status: "searching",
      query: trimmed,
      rows: localTitleMatches(liveRef.current, trimmed),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void runChatSearch(
        assistantId,
        trimmed,
        liveRef.current,
        controller.signal,
      ).then((next) => {
        // `null` is a superseded keystroke — a newer effect already owns the
        // state. Painting an empty list here would be the original bug again.
        if (next && !controller.signal.aborted) setSearch(next);
      });
    }, CHAT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, assistantId]);

  const searching = query.trim().length > 0;
  const visible = searching
    ? search.status === "idle"
      ? []
      : search.rows
    : live;
  const note = searching ? scopeNote(search) : null;
  // Typing a query always searches conversations; the Bookmarked view
  // resumes when the field clears.
  const bookmarkedMode = bookmarksEnabled && showBookmarked && !searching;

  return (
    <div
      data-mv3
      data-slot="mv3-chats-index"
      style={{
        position: "relative",
        height: "100%",
        // `clip` (both axes — a lone overflow-x:clip computes back to hidden
        // next to overflow-y:hidden) forbids programmatic scrollLeft drift;
        // `hidden` still allowed focus/autoscroll to wedge the shell
        // sideways (P1 546px-orb fix). The aurora is paint-contained, so
        // engines without `clip` support degrade safely.
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />

      <LargeTitleHeader
        title="Chats"
        scrollRef={scrollRef}
        trailing={
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              className="cue-pressable"
              aria-label="New chat"
              onClick={() => {
                haptic.light();
                onStartNewConversation();
              }}
              style={{
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "var(--mv3-accent-fill-gradient)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "var(--mv3-plus-shadow)",
                }}
              >
                <Plus size={17} aria-hidden />
              </span>
            </button>
            {onClose ? (
              <button
                type="button"
                className="cue-pressable"
                aria-label="Close chats"
                onClick={() => {
                  haptic.light();
                  onClose();
                }}
                style={{
                  width: 44,
                  height: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--mv3-muted)",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <X size={20} aria-hidden />
              </button>
            ) : null}
          </span>
        }
      />

      {/* Search — frame 21's pull-down field (title-scoped; see header note). */}
      <div
        style={{
          padding: "10px 22px 10px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--mv3-card)",
            border: "1px solid var(--mv3-card-border)",
            borderRadius: 14,
            padding: "10px 14px",
          }}
        >
          <Search
            size={14}
            aria-hidden
            style={{ color: "var(--mv3-muted)", flexShrink: 0 }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              // ≥16px input (build rules) — the spec's 13.5px placeholder
              // would trigger iOS focus-zoom.
              fontSize: 16,
              color: "var(--mv3-text)",
              fontFamily: "inherit",
            }}
          />
        </div>
        {/* What was searched. Never omitted while a query is live: a bounded
            search that doesn't name its bound is the defect this fixed. */}
        {note ? (
          <div
            data-slot="mv3-chats-search-scope"
            role={search.status === "loaded_only" ? "status" : undefined}
            style={{
              fontSize: 11.5,
              lineHeight: 1.35,
              marginTop: 7,
              padding: "0 2px",
              color:
                search.status === "loaded_only"
                  ? "var(--mv3-amber)"
                  : "var(--mv3-muted)",
            }}
          >
            {note}
          </div>
        ) : null}
      </div>

      {/* Apps — the destination row (see `appsEnabled` above). Hidden while
          searching, like the Bookmarked filter: the field searches CHATS, and a
          destination sitting above the results would read as a match. */}
      {appsEnabled && !searching ? (
        <div
          style={{
            padding: "0 16px 10px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <GlassCard
            radius={18}
            padding="13px 15px"
            role="button"
            aria-label="Open Apps"
            tabIndex={0}
            onClick={openApps}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openApps();
              }
            }}
            style={{ cursor: "pointer", minHeight: 44 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minWidth: 0,
              }}
            >
              <LayoutGrid
                size={16}
                aria-hidden
                style={{ flexShrink: 0, color: "var(--mv3-muted)" }}
              />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Apps</span>
            </div>
          </GlassCard>
        </div>
      ) : null}

      {/* "Bookmarked" filter at the top of the ☰ index (v37 ruling 3). */}
      {bookmarksEnabled && !searching ? (
        <div
          role="group"
          aria-label="Filter chats"
          style={{
            display: "flex",
            gap: 8,
            padding: "0 22px 10px",
            flexShrink: 0,
            position: "relative",
            zIndex: 2,
          }}
        >
          <IndexFilterPill
            label="All"
            active={!showBookmarked}
            onClick={() => setShowBookmarked(false)}
          />
          <IndexFilterPill
            label={
              bookmarks.length > 0
                ? `Bookmarked · ${bookmarks.length}`
                : "Bookmarked"
            }
            active={showBookmarked}
            onClick={() => setShowBookmarked(true)}
          />
        </div>
      ) : null}

      {/* Rows — the only scrolling region. */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "0 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {bookmarkedMode ? (
            <BookmarkedRows
              assistantId={assistantId}
              bookmarks={bookmarks}
              onSelectConversation={onSelectConversation}
            />
          ) : null}
          {!bookmarkedMode && visible.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                fontSize: 13,
                color: "var(--mv3-muted)",
                padding: "32px 0",
              }}
            >
              {!searching
                ? "No chats yet."
                : search.status === "whole"
                  ? // Only sayable because the index answered — the scope line
                    // above states that it did.
                    `No chats match “${search.query}”.`
                  : search.status === "loaded_only"
                    ? // NOT "no chats match": older threads were never looked
                      // at. The amber line above carries the reason.
                      "Nothing in the chats already loaded matches."
                    : "Searching…"}
            </div>
          ) : null}
          {bookmarkedMode
            ? null
            : visible.map((conversation, i) => {
                const receipt = receiptFor(
                  conversation,
                  latestByConversation.get(conversation.conversationId),
                  processingConversationIds.has(conversation.conversationId),
                  attentionConversationIds.has(conversation.conversationId),
                );
                return (
                  <GlassCard
                    key={conversation.conversationId}
                    radius={18}
                    padding="13px 15px"
                    // PERF: cap live backdrop-filter layers in the long list.
                    blur={i < 6}
                    role="button"
                    aria-label={`Open chat: ${conversation.title?.trim() || "New chat"}`}
                    tabIndex={0}
                    onClick={() => {
                      haptic.light();
                      onSelectConversation(conversation.conversationId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectConversation(conversation.conversationId);
                      }
                    }}
                    style={{ cursor: "pointer", minHeight: 44 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {conversation.title?.trim() || "New chat"}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--mv3-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {timeLabel(
                          conversation.lastMessageAt ?? conversation.createdAt,
                        )}
                      </span>
                    </div>
                    {receipt ? <ReceiptLine receipt={receipt} /> : null}
                  </GlassCard>
                );
              })}
          {!bookmarkedMode && onLoadMore && !loadMore.exhausted && !query ? (
            <button
              type="button"
              className="cue-pressable"
              disabled={loadMore.busy}
              onClick={() => {
                haptic.light();
                setLoadMore((s) => ({ ...s, busy: true }));
                onLoadMore()
                  .then(({ hasMore }) =>
                    setLoadMore({ busy: false, exhausted: !hasMore }),
                  )
                  .catch(() => setLoadMore((s) => ({ ...s, busy: false })));
              }}
              style={{
                minHeight: 44,
                background: "none",
                border: "none",
                color: "var(--mv3-micro)",
                fontSize: 12.5,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {loadMore.busy ? "Loading…" : "Older chats ›"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
