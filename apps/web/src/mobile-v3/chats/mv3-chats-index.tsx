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
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, X } from "lucide-react";

import { workitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import type { Conversation } from "@/types/conversation-types";
import { haptic } from "@/utils/haptics";

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
  if (ageDays < 7) return then.toLocaleDateString(undefined, { weekday: "short" });
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
const RECEIPT_GLYPH: Record<Exclude<ReceiptKind, "running">, {
  glyph: string;
  color: string;
}> = {
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

export interface Mv3ChatsIndexProps {
  assistantId: string | null;
  conversations: Conversation[];
  processingConversationIds: ReadonlySet<string>;
  attentionConversationIds: ReadonlySet<string>;
  onSelectConversation: (conversationId: string) => void;
  onStartNewConversation: () => void;
  onClose?: () => void;
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
  onLoadMore,
}: Mv3ChatsIndexProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [loadMore, setLoadMore] = useState<{
    busy: boolean;
    exhausted: boolean;
  }>({ busy: false, exhausted: false });

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
                  background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
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
            style={{ color: "var(--mv3-faint)", flexShrink: 0 }}
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
          {visible.length === 0 ? (
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
          {visible.map((conversation, i) => {
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
                      color: "var(--mv3-faint)",
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
          {onLoadMore && !loadMore.exhausted && !query ? (
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
