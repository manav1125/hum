/**
 * Mv3PeoplePage — the phone's People screen (design v22 frame **M3**).
 *
 * Cards, not rows: desktop's three columns stack, so what Cue learned gets the
 * full width instead of being truncated to nothing. Relationship state sits at
 * the top-right of each card and tints the card's border.
 *
 * ## People lost its tab slot
 *
 * v23 revised the four-tab ruling back to three, so nobody arrives here by
 * glancing at a badge. Every arrival is contextual — a name in a task, a
 * search hit, the ⓶ menu — which is the whole reason this screen has to be
 * worth the trip rather than a directory.
 *
 * ## What is real on this screen
 *
 * Everything, or it isn't drawn:
 *  · the roster            `contactsGet`
 *  · exchanges / last seen `contact.interactionCount` / `.lastInteraction`
 *  · what Cue has learned  `contactsByIdMemoryGet`, per rendered card
 *  · relationship state    derived in `people-data.ts` from real fields only —
 *                          "going quiet" ships, "you owe a reply" does not,
 *                          because no interaction carries a direction.
 *  · the header counts     the roster length and how many of the *rendered*
 *                          cards actually have learnings.
 *
 * ## Why cards fetch memory one at a time
 *
 * There is no bulk contact-memory endpoint — `contactsByIdMemoryGet` is
 * per-contact. So the list pages in 15s and only fetches for what is on
 * screen. 78 parallel requests to fill a scroll list would be the wrong
 * trade; a `POST /contacts/memory?ids=` on the daemon would be the right fix.
 *
 * Red is not used for "going quiet" even though M3 draws it red: the global
 * invariant reserves red for Cue reporting its own failures. Amber carries the
 * state, and the label says it in words, so nothing here is colour-only.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import type { ContactPayload } from "@/domains/contacts/types";
import {
  contactsByIdMemoryGetOptions,
  contactsGetOptions,
  peopleMemoryHealthGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { GlassCard } from "../glass-card";
import { LargeTitleHeader } from "../large-title-header";
import { microLabel } from "../mv3-kit";
import {
  avatarGround,
  browsablePeople,
  compactAgo,
  contactSubtitle,
  initials,
  learnedSummary,
  relationshipState,
  type LearnedSummary,
} from "./people-data";

/** How many cards render (and therefore fetch memory) per page. */
const PAGE = 15;

type Filter = "all" | "quiet" | "learned";

export function Mv3PeoplePage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const contactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.contacts,
  });

  // `retry: false` — one read, and a failure here means "unknown", never
  // "healthy". `undefined` is a third answer the summary respects.
  const healthQuery = useQuery({
    ...peopleMemoryHealthGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    retry: false,
  });

  const people = useMemo(
    () => browsablePeople(contactsQuery.data),
    [contactsQuery.data],
  );

  const quietIds = useMemo(
    () =>
      new Set(
        people
          .filter((c) => relationshipState(c, now).id === "quiet")
          .map((c) => c.id),
      ),
    [people, now],
  );

  const visible = useMemo(() => {
    if (filter === "quiet") return people.filter((c) => quietIds.has(c.id));
    return people;
  }, [people, filter, quietIds]);

  const page = useMemo(() => visible.slice(0, shown), [visible, shown]);

  // Memory for exactly the cards on screen. Nothing prefetches 78 contacts.
  const memoryQueries = useQueries({
    queries: page.map((c) => ({
      ...contactsByIdMemoryGetOptions({
        path: { assistant_id: assistantId, id: c.id },
      }),
      enabled: Boolean(assistantId),
      staleTime: 60_000,
    })),
  });

  // Not memoised: `useQueries` hands back a fresh array every render, so a
  // dependency list here would either be a lie or an unmemoisable expression.
  // This is at most PAGE (15) cheap object builds — measurably nothing next to
  // the 15 network reads above it.
  const summaries: LearnedSummary[] = page.map((c, i) => {
    const q = memoryQueries[i];
    return learnedSummary({
      isLoading: q?.isLoading ?? true,
      isError: q?.isError ?? false,
      memory: q?.data?.memory,
      // A failed health read is "unknown", never "healthy" — `undefined` is a
      // third answer that `learnedSummary` respects.
      degraded: healthQuery.isError ? undefined : healthQuery.data?.degraded,
      degradedReason: healthQuery.data?.degradedReason,
      interactionCount: c.interactionCount ?? 0,
      displayName: c.displayName,
    });
  });

  const learnedCount = summaries.filter((s) => s.status === "learned").length;
  const filtered =
    filter === "learned"
      ? page.filter((_, i) => summaries[i]?.status === "learned")
      : page;

  const open = (c: ContactPayload) => {
    haptic.light();
    navigate(routes.person(c.id));
  };

  return (
    <div
      data-mv3
      data-slot="mv3-people"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop
        style={{
          background:
            "radial-gradient(44% 30% at 50% 4%, var(--mv3-aurora), transparent 68%)",
        }}
      />

      <LargeTitleHeader title="People" />

      <div style={{ padding: "0 18px 8px", position: "relative", zIndex: 2 }}>
        <RosterLine
          total={people.length}
          learned={learnedCount}
          shown={page.length}
          loading={contactsQuery.isLoading}
          error={contactsQuery.isError}
        />
        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 10,
            overflowX: "auto",
            scrollbarWidth: "none",
          }}
        >
          <Chip
            label="All"
            active={filter === "all"}
            onPress={() => setFilter("all")}
          />
          {quietIds.size > 0 && (
            <Chip
              label={`Going quiet · ${quietIds.size}`}
              active={filter === "quiet"}
              onPress={() => setFilter("quiet")}
            />
          )}
          {learnedCount > 0 && (
            <Chip
              label={`Cue has learned · ${learnedCount}`}
              active={filter === "learned"}
              onPress={() => setFilter("learned")}
            />
          )}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "2px 14px 28px",
          position: "relative",
          zIndex: 2,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {contactsQuery.isError ? (
          <RosterError onRetry={() => void contactsQuery.refetch()} />
        ) : contactsQuery.isLoading ? (
          <Muted>Loading the people Cue knows…</Muted>
        ) : people.length === 0 ? (
          <Muted>
            Cue hasn&rsquo;t met anyone yet. People appear here once it reads an
            exchange with someone who isn&rsquo;t you.
          </Muted>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((c) => {
              const idx = page.indexOf(c);
              return (
                <PersonCard
                  key={c.id}
                  contact={c}
                  summary={summaries[idx]!}
                  now={now}
                  onPress={() => open(c)}
                />
              );
            })}
            {filter !== "learned" && visible.length > page.length && (
              <button
                type="button"
                onClick={() => {
                  haptic.light();
                  setShown((n) => n + PAGE);
                }}
                style={{
                  marginTop: 4,
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 14,
                  padding: "11px 14px",
                  fontFamily: "inherit",
                  fontSize: 13,
                  color: "var(--mv3-text)",
                  cursor: "pointer",
                }}
              >
                Show {Math.min(PAGE, visible.length - page.length)} more ·{" "}
                {visible.length - page.length} left
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The count line. Says how many of the *rendered* cards carry learnings, which
 * is the number that makes the sparsity visible instead of implying that a
 * roster of 78 means 78 relationships Cue understands.
 */
function RosterLine({
  total,
  learned,
  shown,
  loading,
  error,
}: {
  total: number;
  learned: number;
  shown: number;
  loading: boolean;
  error: boolean;
}) {
  let text: string;
  if (error) text = "The roster didn't load.";
  else if (loading) text = "Reading your people…";
  else if (total === 0) text = "Nobody yet.";
  else if (shown === 0) text = `${total} ${total === 1 ? "person" : "people"}`;
  else
    text = `${total} ${total === 1 ? "person" : "people"} · Cue has learned about ${learned} of the first ${shown}`;
  return (
    <div style={{ fontSize: 11.5, color: "var(--mv3-muted)", marginTop: 3 }}>
      {text}
    </div>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{
        flexShrink: 0,
        fontFamily: "inherit",
        fontSize: 11.5,
        fontWeight: active ? 600 : 400,
        color: active ? "var(--mv3-bg)" : "var(--mv3-pill-text)",
        background: active ? "var(--mv3-text)" : "var(--mv3-pill)",
        border: `1px solid ${active ? "transparent" : "var(--mv3-pill-border)"}`,
        borderRadius: 99,
        padding: "6px 12px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function PersonCard({
  contact,
  summary,
  now,
  onPress,
}: {
  contact: ContactPayload;
  summary: LearnedSummary;
  now: number;
  onPress: () => void;
}) {
  const state = relationshipState(contact, now);
  const sub = contactSubtitle(contact);
  const ago = compactAgo(contact.lastInteraction, now);
  const exchanges = contact.interactionCount ?? 0;

  return (
    <GlassCard
      tint={state.tone === "warn" ? "amber" : "default"}
      radius={16}
      padding={0}
      blur={false}
    >
      <button
        type="button"
        onClick={onPress}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          borderRadius: 16,
          padding: "12px 13px",
          fontFamily: "inherit",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar name={contact.displayName} size={34} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {contact.displayName}
            </div>
            {sub && (
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-muted)",
                  marginTop: 1,
                }}
              >
                {sub}
              </div>
            )}
          </div>
          <span
            style={{
              flexShrink: 0,
              fontSize: 10.5,
              fontWeight: state.tone === "warn" ? 600 : 400,
              color:
                state.tone === "warn"
                  ? "var(--mv3-amber-text)"
                  : "var(--mv3-muted)",
            }}
          >
            {state.label}
          </span>
        </div>

        <LearnedLine summary={summary} />

        {(exchanges > 0 || ago) && (
          <div
            style={{ fontSize: 10, color: "var(--mv3-muted)", marginTop: 6 }}
          >
            {[
              exchanges > 0
                ? `${exchanges} ${exchanges === 1 ? "exchange" : "exchanges"}`
                : null,
              ago ? `${ago} ago` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </button>
    </GlassCard>
  );
}

/**
 * The line design calls "what Cue has learned, in plain sentences". Four
 * outcomes, four sentences — an unfinished request, a broken pipeline and an
 * honestly empty one must not read the same.
 */
function LearnedLine({ summary }: { summary: LearnedSummary }) {
  const base = {
    fontSize: 11.5,
    lineHeight: 1.5,
    marginTop: 8,
  } as const;

  if (summary.status === "loading") {
    return (
      <div style={{ ...base, color: "var(--mv3-muted)" }}>
        Reading what Cue knows…
      </div>
    );
  }
  if (summary.status === "error") {
    return (
      <div style={{ ...base, color: "var(--mv3-fail-text)" }}>
        <span aria-hidden>⚠ </span>
        {summary.sentence}
      </div>
    );
  }
  if (summary.status === "degraded") {
    return (
      <div style={{ ...base, color: "var(--mv3-amber-text)" }}>
        <span aria-hidden>! </span>
        {summary.sentence}
      </div>
    );
  }
  if (summary.status === "empty") {
    return (
      <div style={{ ...base, color: "var(--mv3-muted)", fontStyle: "italic" }}>
        {summary.sentence}
      </div>
    );
  }
  return (
    <div
      style={{
        ...base,
        color: "var(--mv3-text)",
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {summary.prose}
    </div>
  );
}

export function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        // An `-on-fill` ground; see AVATAR_GROUNDS.
        background: avatarGround(name),
        color: "#ffffff",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {initials(name)}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: "var(--mv3-muted)",
        lineHeight: 1.55,
        padding: "18px 4px",
      }}
    >
      {children}
    </div>
  );
}

/** A failed roster read is an error state, never an empty list. */
function RosterError({ onRetry }: { onRetry: () => void }) {
  return (
    <GlassCard radius={16} style={{ marginTop: 12 }}>
      <div
        style={{
          ...microLabel,
          fontSize: 9,
          color: "var(--mv3-fail-text)",
        }}
      >
        <span aria-hidden>⚠ </span>COULDN&rsquo;T LOAD PEOPLE
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--mv3-text)",
          lineHeight: 1.5,
          marginTop: 6,
        }}
      >
        Cue couldn&rsquo;t reach its own contact store. This is a failed
        request, not an empty address book — nobody has been removed.
      </div>
      <button
        type="button"
        onClick={() => {
          haptic.light();
          onRetry();
        }}
        style={{
          marginTop: 10,
          background: "var(--mv3-btn2-bg)",
          border: "1px solid var(--mv3-btn2-border)",
          borderRadius: 12,
          padding: "8px 14px",
          fontFamily: "inherit",
          fontSize: 12.5,
          color: "var(--mv3-text)",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </GlassCard>
  );
}
