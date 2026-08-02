/**
 * **All conversations** — the desktop index at `/assistant/conversations`.
 *
 * ## Why this file exists
 *
 * The rail's "All conversations ›" row was dead in the shipped build, and the
 * reason was structural rather than a typo. `/assistant/conversations` was
 * added for the phone's ⋯ menu and its component hard-redirects on desktop:
 *
 *     if (!isMobile) return <Navigate to={routes.assistant} replace />;
 *
 * — with a comment saying "the sidebar rail IS the chats index there". That was
 * true when it was written. Then v16 gave the rail an explicit row pointing at
 * this URL, and the row inherited a redirect nobody re-read. From `/assistant`
 * (the desktop landing surface) the round trip is `/assistant` → this route →
 * `/assistant`, so the URL never changes and the row looks inert. It was inert.
 *
 * The mobile branch is untouched: `mobile-v3` owns the phone's index and this
 * route still renders it there.
 *
 * ## What earns the click (v16 D3)
 *
 * *"People find threads by remembering a sentence, not a title."* So search
 * here is full-text over message bodies — `GET …/conversations/search`, which
 * returns `matchingMessages[].excerpt` — and the results render the **quote**,
 * not just the title. That is the one thing the rail's five-row peek cannot do
 * and the reason this page is worth a destination.
 *
 * ## What the brief asked for and the data cannot support
 *
 * D3 also specifies a `▤` thing chip per row and an "Unattached · 12" count.
 * **There is no conversation → thing relation in the API** — neither the
 * conversation list record (`ConversationsGetResponses`) nor the client
 * `Conversation` type carries a project id, and no endpoint reports one. So
 * this page says that in a footer line rather than rendering a chip that would
 * be either invented or permanently empty. A no-op is not a success, and an
 * honest empty state is instrumentation (v21 §7).
 */
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { PageShell } from "@/components/page-shell";
import { navigateToConversation } from "@/domains/chat/utils/conversation-navigation";
import { conversationsSearchGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useConversationListQuery } from "@/hooks/conversation-queries";
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

/** "10:30" · "Fri" · "31 Jul" — the same quiet dialect the rail's peek uses. */
function whenLabel(at: number | undefined, now: number): string {
  if (at == null || !Number.isFinite(at) || at <= 0) return "";
  const ms = at < 1e12 ? at * 1000 : at;
  const d = new Date(ms);
  if (new Date(now).toDateString() === d.toDateString()) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (now - ms < 7 * 86_400_000) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const ROW_CLASSES = [
  "flex w-full cursor-pointer flex-col gap-1 rounded-[8px] border-none bg-transparent px-3 py-2.5 text-left",
  "outline-none transition-colors",
  "hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
].join(" ");

function AllConversationsPage() {
  const navigate = useNavigate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const { conversations, isLoading, isError } = useConversationListQuery(
    assistantId,
    assistantStateKind === "active",
  );

  const [query, setQuery] = useState("");
  // Deferred rather than debounced: the search is a network read keyed on the
  // trimmed term, so React's own scheduling is enough and there is no timer to
  // leak. Fewer moving parts than a hand-rolled debounce.
  const deferredQuery = useDeferredValue(query.trim());
  const searching = deferredQuery.length >= 2;

  const search = useQuery({
    ...conversationsSearchGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { q: deferredQuery, limit: 50, maxMessagesPerConversation: 2 },
    }),
    enabled: searching && Boolean(assistantId),
  });

  // Captured once per mount. `Date.now()` read during render is impure and
  // would also re-bucket rows mid-interaction; relative labels on this surface
  // are day-grained, so a mount-time stamp is the right resolution.
  const [now] = useState(() => Date.now());

  const listed = useMemo(
    () =>
      [...conversations]
        .filter((c) => c.archivedAt == null)
        .sort(
          (a, b) =>
            (b.lastMessageAt ?? b.createdAt ?? 0) -
            (a.lastMessageAt ?? a.createdAt ?? 0),
        ),
    [conversations],
  );

  const hits = useMemo(
    () => readSearchHits(search.data?.results ?? []),
    [search.data],
  );

  const open = (conversationId: string) => {
    navigateToConversation(navigate, conversationId);
  };

  return (
    <PageShell>
      <header className="mb-4 shrink-0">
        <h1 className="text-title-large text-[var(--content-default)]">
          All conversations
        </h1>
        <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
          {isError
            ? "⚠ Couldn't read your conversations."
            : isLoading
              ? "Reading…"
              : `${listed.length} ${listed.length === 1 ? "conversation" : "conversations"} — search the words inside them, not just the titles.`}
        </p>
      </header>

      <label className="mb-3 flex shrink-0 items-center gap-2 rounded-[8px] border border-[var(--border-base)] px-3 py-2">
        <Search
          size={14}
          aria-hidden
          className="shrink-0 text-[var(--content-secondary)]"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search what was said…"
          aria-label="Search conversations"
          className="min-w-0 flex-1 border-none bg-transparent text-body-medium-default text-[var(--content-default)] outline-none placeholder:text-[var(--content-secondary)]"
        />
      </label>

      <div className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto">
        {searching ? (
          search.isError ? (
            <p className="px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
              ⚠ Couldn&apos;t run that search.
            </p>
          ) : search.isPending ? (
            <p className="px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
              Searching…
            </p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
              Nothing said that. ({deferredQuery})
            </p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.conversationId}
                type="button"
                className={ROW_CLASSES}
                onClick={() => open(hit.conversationId)}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                    {hit.conversationTitle ?? "Untitled"}
                  </span>
                  <span className="shrink-0 text-body-small-default text-[var(--content-secondary)]">
                    {whenLabel(hit.conversationUpdatedAt, now)}
                  </span>
                </span>
                {/* The quote. This is the whole reason the page exists. */}
                {hit.excerpts.map((excerpt, i) => (
                  <span
                    key={`${hit.conversationId}-${i}`}
                    className="line-clamp-2 border-l-2 border-[var(--border-base)] pl-2 text-body-small-default text-[var(--content-secondary)]"
                  >
                    “{excerpt}”
                  </span>
                ))}
                {hit.excerpts.length === 0 ? (
                  <span className="text-body-small-default text-[var(--content-secondary)]">
                    Title match
                  </span>
                ) : null}
              </button>
            ))
          )
        ) : isError ? (
          <p className="px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
            ⚠ Couldn&apos;t read your conversations.
          </p>
        ) : listed.length === 0 && !isLoading ? (
          <p className="px-3 py-2 text-body-small-default text-[var(--content-secondary)]">
            No conversations yet.
          </p>
        ) : (
          listed.map((c: Conversation) => (
            <button
              key={c.conversationId}
              type="button"
              className={ROW_CLASSES}
              onClick={() => open(c.conversationId)}
            >
              <span className="flex items-baseline gap-2">
                <MessageSquare
                  size={14}
                  aria-hidden
                  className="shrink-0 self-center text-[var(--content-secondary)]"
                />
                <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                  {c.title ?? "Untitled"}
                </span>
                <span className="shrink-0 text-body-small-default text-[var(--content-secondary)]">
                  {whenLabel(c.lastMessageAt ?? c.createdAt, now)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      {/*
        The honest line. v16 D3 asks for a `▤` thing chip per row and an
        "Unattached · N" count; nothing in the API relates a conversation to a
        thing, so neither is rendered. Saying so beats a chip that is always
        empty — that is the difference between a gap and a lie.
      */}
      <p className="mt-3 shrink-0 border-t border-[var(--border-base)] pt-2 text-body-small-default text-[var(--content-secondary)]">
        ⊘ Which thing a conversation belongs to isn&apos;t recorded yet, so
        there are no thing chips and no &ldquo;unattached&rdquo; count here.
      </p>
    </PageShell>
  );
}
