/**
 * **All conversations** — the desktop index at `/assistant/conversations`.
 *
 * ## Why this file exists
 *
 * The rail's "All conversations ›" row was dead in the shipped build, and the
 * reason was structural rather than a typo. `/assistant/conversations` was
 * added for the phone's ⋯ menu and its component hard-redirected on desktop:
 *
 *     if (!isMobile) return <Navigate to={routes.assistant} replace />;
 *
 * — with a comment saying "the sidebar rail IS the chats index there". That was
 * true when it was written. Then v16 gave the rail an explicit row pointing at
 * this URL, and the row inherited a redirect nobody re-read.
 *
 * The mobile branch is untouched: `mobile-v3` owns the phone's index and this
 * route still renders it there.
 *
 * ## The spec (v16 D3, `packs/v16-destinations`)
 *
 * > **D3 · All conversations — earns it with *quotes***
 * > Two things make this better than a title list:
 * > 1. **A one-line quote from the thread** — people find old conversations by
 * >    remembering a sentence, not a title they never wrote.
 * > 2. **The ▤ thing chip** — the conversation and the work it belongs to stay
 * >    visibly connected.
 * > Filters are by thing, plus "Unattached · 12".
 *
 * and, from §11.3 of the same handoff, *"Pinned | Top of conversation list |
 * Pinned **conversations** belong with conversations."*
 *
 * ## What is drawn, and what pays for it
 *
 * | On screen | Field |
 * |---|---|
 * | census "N conversations · M this week" | counted from the rows in hand |
 * | PINNED section | `isPinned` |
 * | TODAY / YESTERDAY / EARLIER THIS WEEK / EARLIER | `lastMessageAt ?? createdAt` |
 * | `●` unread · `◐` running | `assistantAttention.hasUnseenLatestAssistantMessage`, `isProcessing` |
 * | `▤` chip | `groupId` resolved against `GET …/groups` |
 * | channel leg ("Slack · #eng") | `channelBinding` / `conversationOriginChannel` |
 * | "started 3 Jul" | `createdAt`, only when the thread spans days |
 * | the **quote** | `…/conversations/search` → `matchingMessages[].excerpt` |
 *
 * ## What the brief asked for that the API cannot pay for
 *
 * - **"N messages" per row.** `GET …/conversations` returns no message count
 *   and there is no bulk count endpoint. Not drawn — a plausible number is
 *   worse than none.
 * - **A quote on every row.** Message text is reachable only per-conversation
 *   (`GET …/messages?conversationId=`), so a preview column would be one
 *   request per row. The quote is therefore search's job, which is why search
 *   is the loud control here rather than a filter in the corner.
 * - **The `▤` *thing* chip and "Unattached · N".** No endpoint relates a
 *   conversation to a work item. The chip is drawn from conversation *groups*,
 *   which are real and named, and the footer says plainly that the thing
 *   relation does not exist rather than letting the group chip pass for one.
 */

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { PageShell } from "@/components/page-shell";
import {
  C,
  FilterChip,
  ListCard,
  MUTED,
  QuietButton,
  ROW_STATE_META,
  SectionHeading,
  StateBlock,
  Tag,
  census,
  conversationAt,
  metaParts,
  mono,
  rowState,
  sectionize,
  serif,
  whenLabel,
} from "@/domains/chat/components/conversation-index-kit";
import {
  navigateToConversation,
  navigateToNewConversation,
} from "@/domains/chat/utils/conversation-navigation";
import { conversationsSearchGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { ChatsIndexPage } from "@/mobile-v3/chats/chats-index-page";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { Conversation } from "@/types/conversation-types";

/**
 * The route component. The phone keeps its v3 index; desktop gets the surface
 * below instead of the redirect that made the rail row dead.
 */
export function ConversationsIndexPage() {
  const isMobile = useMobileLayout();
  if (isMobile) return <ChatsIndexPage />;
  return <AllConversationsPage />;
}

// ---------------------------------------------------------------------------
// Search — the only place a real quote can come from
// ---------------------------------------------------------------------------

/** Search results, narrowed from the endpoint's untyped `Array<unknown>`. */
interface SearchHit {
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  excerpts: string[];
}

/**
 * The daemon declares `results: Array<unknown>` in its OpenAPI response body,
 * so the generated client hands back `unknown[]`. Narrow at the boundary and
 * drop anything that does not carry an id — a row that cannot be opened is
 * worse than a row that is not there.
 */
function readSearchHits(results: readonly unknown[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const id = row.conversationId;
    if (typeof id !== "string" || id.length === 0) continue;
    const messages = Array.isArray(row.matchingMessages)
      ? row.matchingMessages
      : [];
    const excerpts: string[] = [];
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      const excerpt = (message as Record<string, unknown>).excerpt;
      if (typeof excerpt === "string" && excerpt.trim().length > 0) {
        excerpts.push(excerpt.trim());
      }
    }
    hits.push({
      conversationId: id,
      conversationTitle:
        typeof row.conversationTitle === "string"
          ? row.conversationTitle
          : null,
      conversationUpdatedAt:
        typeof row.conversationUpdatedAt === "number"
          ? row.conversationUpdatedAt
          : 0,
      excerpts,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * A filter is offered only when rows are behind it — a chip that leads to an
 * empty screen is a trap. The **exception is the chip you are standing on**:
 * `keepId` holds the selected filter in the bar even after its count falls to
 * zero, which happens live when the last unread row is read in another window.
 * Dropping it there would silently reset the view; keeping it lets the page say
 * `emptyLine` — *why* the list is empty — which is the whole point of the
 * state. (It is also what makes that branch reachable rather than dead code.)
 */
interface Filter {
  id: string;
  glyph?: string;
  label: string;
  count: number;
  emptyLine: string;
  match: (c: Conversation) => boolean;
}

export function buildFilters(
  conversations: readonly Conversation[],
  groups: readonly { id: string; name: string; isSystemGroup: boolean }[],
  keepId: string,
): Filter[] {
  const filters: Filter[] = [
    {
      id: "all",
      label: "All",
      count: conversations.length,
      emptyLine: "",
      match: () => true,
    },
  ];
  const add = (f: Filter) => {
    if (f.count > 0 || f.id === keepId) filters.push(f);
  };
  add({
    id: "unread",
    glyph: ROW_STATE_META.unread.glyph,
    label: "Unread",
    count: conversations.filter((c) => c.hasUnseenLatestAssistantMessage)
      .length,
    emptyLine:
      "Every reply Cue has written has now been seen — nothing is waiting to be read.",
    match: (c) => Boolean(c.hasUnseenLatestAssistantMessage),
  });
  add({
    id: "pinned",
    glyph: "✦",
    label: "Pinned",
    count: conversations.filter((c) => c.isPinned).length,
    emptyLine: "Nothing is pinned. Pin a conversation to keep it up here.",
    match: (c) => Boolean(c.isPinned),
  });
  for (const group of groups) {
    if (group.isSystemGroup) continue;
    add({
      id: `group:${group.id}`,
      glyph: "▤",
      label: group.name,
      count: conversations.filter((c) => c.groupId === group.id).length,
      emptyLine: `Nothing is filed under ${group.name} any more.`,
      match: (c) => c.groupId === group.id,
    });
  }
  // Only worth offering once there is somewhere for a conversation to be filed.
  const named = groups.filter((g) => !g.isSystemGroup);
  if (named.length > 0) {
    const grouped = new Set(named.map((g) => g.id));
    add({
      id: "unfiled",
      label: "Unfiled",
      count: conversations.filter(
        (c) => c.groupId == null || !grouped.has(c.groupId),
      ).length,
      emptyLine: "Every conversation is filed into a group.",
      match: (c) => c.groupId == null || !grouped.has(c.groupId),
    });
  }
  return filters;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function AllConversationsPage() {
  const navigate = useNavigate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const active = assistantStateKind === "active";
  const { conversations, isLoading, isError, refetch } =
    useConversationListQuery(assistantId, active);
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    active,
  );

  const [query, setQuery] = useState("");
  // Deferred rather than debounced: the search is a network read keyed on the
  // trimmed term, so React's own scheduling is enough and there is no timer to
  // leak. Fewer moving parts than a hand-rolled debounce.
  const deferredQuery = useDeferredValue(query.trim());
  const typing = query.trim().length > 0;
  const searching = deferredQuery.length >= 2;

  const search = useQuery({
    ...conversationsSearchGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { q: deferredQuery, limit: 50, maxMessagesPerConversation: 2 },
    }),
    enabled: searching && Boolean(assistantId),
  });

  // Captured once per mount. `Date.now()` read during render is impure and
  // would also re-bucket rows mid-interaction; the labels on this surface are
  // day-grained, so a mount-time stamp is the right resolution.
  const [now] = useState(() => Date.now());

  const listed = useMemo(
    () => conversations.filter((c) => c.archivedAt == null),
    [conversations],
  );

  const [filterId, setFilterId] = useState("all");
  const filters = useMemo(
    () => buildFilters(listed, conversationGroups, filterId),
    [listed, conversationGroups, filterId],
  );
  const filter = filters.find((f) => f.id === filterId) ?? filters[0];

  const visible = useMemo(
    () => listed.filter((c) => filter.match(c)),
    [listed, filter],
  );
  const sections = useMemo(() => sectionize(visible, now), [visible, now]);
  const { total, thisWeek } = useMemo(() => census(listed, now), [listed, now]);

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of conversationGroups) {
      if (!g.isSystemGroup) map.set(g.id, g.name);
    }
    return map;
  }, [conversationGroups]);

  const hits = useMemo(
    () => readSearchHits(search.data?.results ?? []),
    [search.data],
  );

  const open = (conversationId: string) => {
    navigateToConversation(navigate, conversationId);
  };

  return (
    <PageShell>
      {/* ---------------------------------------------------------------- */}
      {/* Header — serif title, honest census, search                       */}
      {/* ---------------------------------------------------------------- */}
      <header
        className="mb-3 flex shrink-0 flex-wrap items-end gap-x-4 gap-y-3"
        style={{ color: C.t1 }}
      >
        <div className="min-w-0 flex-1">
          <h1
            style={{
              fontFamily: serif,
              fontSize: 28,
              lineHeight: 1.15,
              margin: 0,
              fontWeight: 400,
            }}
          >
            Conversations
          </h1>
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 12.5,
              color: isError ? C.dangerText : C.t2,
            }}
          >
            {isError
              ? "⚠ Couldn’t read your conversations."
              : isLoading
                ? "Reading your conversations…"
                : total === 0
                  ? "Nothing here yet."
                  : `${total} ${total === 1 ? "conversation" : "conversations"} · ${thisWeek} this week`}
          </p>
        </div>
        <label
          className="flex items-center gap-2"
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: 9,
            padding: "7px 12px",
            width: 260,
            maxWidth: "100%",
          }}
        >
          <Search
            size={12}
            aria-hidden
            style={{ flexShrink: 0, color: MUTED }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what was said…"
            aria-label="Search conversations"
            className="min-w-0 flex-1 border-none bg-transparent outline-none"
            style={{ fontSize: 12, color: C.t1 }}
          />
        </label>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Filters — hidden while searching, which reads everything          */}
      {/* ---------------------------------------------------------------- */}
      {!typing && filters.length > 1 ? (
        <div
          className="mb-3 flex shrink-0 flex-wrap gap-1.5"
          role="group"
          aria-label="Filter conversations"
        >
          {filters.map((f) => (
            <FilterChip
              key={f.id}
              active={f.id === filter.id}
              glyph={f.glyph}
              label={f.label}
              count={f.count}
              onClick={() => setFilterId(f.id)}
            />
          ))}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The list                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ListCard>
          {typing ? (
            <SearchResults
              deferredQuery={deferredQuery}
              searching={searching}
              isError={search.isError}
              isPending={search.isPending}
              hits={hits}
              now={now}
              onOpen={open}
              onRetry={() => void search.refetch()}
            />
          ) : isError ? (
            <StateBlock
              tone="error"
              glyph="⚠"
              headline="Couldn’t read your conversations"
              sentence="The request to your assistant failed, so this list is empty because nothing arrived — not because there is nothing there. Your conversations have not been touched."
              action={<QuietButton onClick={refetch}>Try again</QuietButton>}
            />
          ) : isLoading ? (
            <p
              style={{ padding: "22px 18px", fontSize: 12.5, color: C.t2 }}
              aria-live="polite"
            >
              Reading your conversations…
            </p>
          ) : total === 0 ? (
            <StateBlock
              tone="empty"
              glyph="✎"
              headline="No conversations yet"
              sentence="Nothing has been said to Cue on this assistant. Start one and it will show up here, searchable by the words inside it."
              action={
                <QuietButton
                  onClick={() => navigateToNewConversation(navigate)}
                >
                  Start a conversation
                </QuietButton>
              }
            />
          ) : visible.length === 0 ? (
            <StateBlock
              tone="empty"
              glyph="⊘"
              headline={`Nothing under ${filter.label}`}
              sentence={`${filter.emptyLine} All ${total} ${total === 1 ? "conversation" : "conversations"} are still here.`}
              action={
                <QuietButton onClick={() => setFilterId("all")}>
                  Show all
                </QuietButton>
              }
            />
          ) : (
            sections.map((section) => (
              <section key={section.key}>
                <SectionHeading
                  trailing={
                    <span
                      style={{ fontFamily: mono, fontSize: 9.5, color: MUTED }}
                    >
                      {section.conversations.length}
                    </span>
                  }
                >
                  {section.label}
                </SectionHeading>
                {section.conversations.map((c) => (
                  <ConversationRow
                    key={c.conversationId}
                    conversation={c}
                    groupName={
                      c.groupId ? groupNameById.get(c.groupId) : undefined
                    }
                    now={now}
                    onOpen={open}
                  />
                ))}
              </section>
            ))
          )}
        </ListCard>

        {/*
          The honest line. v16 D3 asks for a `▤` *thing* chip per row and an
          "Unattached · N" count; nothing in the API relates a conversation to a
          thing, so neither is rendered and the chip above is labelled as what
          it actually is. Saying so beats a chip that is always empty — that is
          the difference between a gap and a lie.
        */}
        <p
          style={{
            margin: "12px 2px 4px",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: MUTED,
          }}
        >
          ⊘ The ▤ chips are conversation groups. Which <em>thing</em> a
          conversation belongs to isn’t recorded anywhere yet, so there is no
          thing chip and no “unattached” count on this page.
        </p>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROW_STYLE = {
  display: "flex",
  alignItems: "flex-start",
  gap: 11,
  width: "100%",
  padding: "11px 16px",
  textAlign: "left" as const,
  background: "transparent",
  border: "none",
  borderTop: `1px solid ${C.line}`,
  cursor: "pointer",
};

const ROW_CLASSES =
  "transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]";

function ConversationRow({
  conversation,
  groupName,
  now,
  onOpen,
}: {
  conversation: Conversation;
  groupName?: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  const state = rowState(conversation);
  const parts = metaParts(conversation, state);
  const when = whenLabel(conversationAt(conversation), now);
  return (
    <button
      type="button"
      onClick={() => onOpen(conversation.conversationId)}
      style={ROW_STYLE}
      className={ROW_CLASSES}
    >
      {/*
        Glyph column. `●` and `◐` differ in shape as well as hue, so the state
        survives being read in greyscale, and the same state is spelled out as
        a word in the meta line below.
      */}
      <span
        aria-hidden
        style={{
          width: 9,
          flexShrink: 0,
          paddingTop: 2,
          fontSize: 9,
          lineHeight: "14px",
          color: state ? ROW_STATE_META[state].color : "transparent",
        }}
      >
        {state ? ROW_STATE_META[state].glyph : "·"}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: state === "unread" ? 700 : 500,
              color: C.t1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {conversation.title ?? "Untitled"}
          </span>
          {groupName ? <Tag tone="teal">▤ {groupName}</Tag> : null}
        </span>
        {parts.length > 0 ? (
          <span
            style={{
              display: "block",
              marginTop: 2,
              fontSize: 10.5,
              color: MUTED,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {parts.join(" · ")}
          </span>
        ) : null}
      </span>
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          color: MUTED,
          flexShrink: 0,
          paddingTop: 2,
          minWidth: 62,
          textAlign: "right",
        }}
      >
        {when}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Search results — the quote is the whole reason this page is a destination
// ---------------------------------------------------------------------------

function SearchResults({
  deferredQuery,
  searching,
  isError,
  isPending,
  hits,
  now,
  onOpen,
  onRetry,
}: {
  deferredQuery: string;
  searching: boolean;
  isError: boolean;
  isPending: boolean;
  hits: SearchHit[];
  now: number;
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  if (!searching) {
    return (
      <p style={{ padding: "22px 18px", fontSize: 12.5, color: C.t2 }}>
        Keep typing — search needs two characters. It reads the words inside
        every message, not just the titles.
      </p>
    );
  }
  if (isError) {
    return (
      <StateBlock
        tone="error"
        glyph="⚠"
        headline="That search didn’t come back"
        sentence={`The request for “${deferredQuery}” failed. This is not a result of zero — nothing was searched.`}
        action={<QuietButton onClick={onRetry}>Try again</QuietButton>}
      />
    );
  }
  if (isPending) {
    return (
      <p
        style={{ padding: "22px 18px", fontSize: 12.5, color: C.t2 }}
        aria-live="polite"
      >
        Searching…
      </p>
    );
  }
  if (hits.length === 0) {
    return (
      <StateBlock
        tone="empty"
        glyph="⊘"
        headline="Nothing said that"
        sentence={`No message body and no title contains “${deferredQuery}”. Archived conversations are not searched.`}
      />
    );
  }
  return (
    <>
      <SectionHeading
        trailing={
          <span style={{ fontFamily: mono, fontSize: 9.5, color: MUTED }}>
            {hits.length}
          </span>
        }
      >
        Said “{deferredQuery}”
      </SectionHeading>
      {hits.map((hit) => (
        <button
          key={hit.conversationId}
          type="button"
          onClick={() => onOpen(hit.conversationId)}
          style={ROW_STYLE}
          className={ROW_CLASSES}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 500,
                color: C.t1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {hit.conversationTitle ?? "Untitled"}
            </span>
            {/* The quote. This is the whole reason the page exists. */}
            {hit.excerpts.map((excerpt, i) => (
              <span
                key={`${hit.conversationId}-${i}`}
                style={{
                  display: "block",
                  marginTop: 4,
                  paddingLeft: 9,
                  borderLeft: `2px solid ${C.line2}`,
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: C.t2,
                }}
              >
                “{excerpt}”
              </span>
            ))}
            {hit.excerpts.length === 0 ? (
              <span
                style={{
                  display: "block",
                  marginTop: 2,
                  fontSize: 10.5,
                  color: MUTED,
                }}
              >
                Title match
              </span>
            ) : null}
          </span>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: MUTED,
              flexShrink: 0,
              paddingTop: 2,
              minWidth: 62,
              textAlign: "right",
            }}
          >
            {whenLabel(hit.conversationUpdatedAt, now)}
          </span>
        </button>
      ))}
    </>
  );
}
