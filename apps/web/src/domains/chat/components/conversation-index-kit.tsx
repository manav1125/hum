/**
 * The **All conversations** index kit — the bucketing rules and the quiet
 * typographic chrome the desktop index at `/assistant/conversations` is built
 * from. Data fetching stays in `conversations-index-page.tsx`; everything here
 * is pure or presentational so the rules can be tested without a network.
 *
 * ## The spec this serves
 *
 * v16 D3 (`docs/design/handoff-2026-08-02/01-work-surfaces/packs/v16-destinations`):
 *
 * > **D3 · All conversations — earns it with *quotes***
 * > Two things make this better than a title list:
 * > 1. **A one-line quote from the thread** — people find old conversations by
 * >    remembering a sentence, not a title they never wrote.
 * > 2. **The ▤ thing chip** — the conversation and the work it belongs to stay
 * >    visibly connected.
 * > Filters are by thing, plus **"Unattached · 12"** — which doubles as the
 * >    honest count of chats that never became work.
 *
 * plus, from the same handoff's §11.3 nav table: *"Pinned | Top of conversation
 * list | Pinned **conversations** belong with conversations."*
 *
 * ## What the API can and cannot pay for
 *
 * `GET …/conversations` returns, per row: `title`, `createdAt`, `lastMessageAt`,
 * `isPinned`, `groupId`, `conversationType`, `archivedAt`, `surfacedAt`,
 * `channelBinding` / `conversationOriginChannel`, `isProcessing`, and
 * `assistantAttention.hasUnseenLatestAssistantMessage`. It returns **no message
 * count and no message text** — so nothing here renders "8 messages" or a
 * preview quote, both of which the v16 mock shows. The quote is real but only
 * reachable through `…/conversations/search`, which is the one endpoint that
 * returns `matchingMessages[].excerpt`; that is why search is the loud control
 * on this page rather than a filter tucked in a corner.
 *
 * The `▤` chip is drawn from **conversation groups** (`GET …/groups`, real user
 * folders with real names) and labelled as such. It is deliberately *not*
 * called a thing: no endpoint relates a conversation to a work item, so
 * "Unattached · N" cannot be computed and is not drawn. See the page footer.
 *
 * ## House rules encoded here
 *
 * - Every count is derived from rows actually in hand — {@link census} takes
 *   the list, not a server total, so it can never disagree with what is drawn.
 * - No colour-only state: {@link ROW_STATE_META} pairs each state with a glyph
 *   *and* a word, and the row prints both. Hue is the third carrier, never the
 *   first.
 * - A row with no timestamp is bucketed as `earlier` rather than being given a
 *   plausible one.
 */

import type { CSSProperties, ReactNode } from "react";

import { C, mono, serif } from "@/lib/hq-theme";
import type { Conversation } from "@/types/conversation-types";

export { C, mono, serif };

/**
 * The muted text colour for everything small on this page — section headings,
 * meta lines, timestamps, chip counts, the footer.
 *
 * **Deliberately `--mv1-t2`, not `--mv1-t3`.** `t3` is a *chrome* grey: on the
 * light card it resolves to `#71808e`, which measures **4.05:1** and fails the
 * 4.5 floor. Measured in the browser, not assumed — every `t3` string on this
 * surface came back between 3.98 and 4.05. `hq-kit.tsx` documents the same trap
 * and answers it with an HQ-local `--hq-muted`; this page is outside HQ, so it
 * reaches for the theme token that already clears the bar (`#5a6672`, 5.77:1
 * light). Hierarchy here is carried by size and by mono-vs-sans, not by fading
 * type below legibility.
 */
export const MUTED = C.t2;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Daemon timestamps are epoch-ms (`conversation-transforms.ts`: *"Timestamps
 * pass through as epoch-ms numbers"*), but the search endpoint hands back a raw
 * SQL `updated_at` through an `Array<unknown>` response body, so the seconds
 * case is tolerated rather than assumed. Returns `null` for anything that isn't
 * a usable instant — callers must not substitute "now".
 */
export function toMillis(at: number | undefined | null): number | null {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;
  return at < 1e12 ? at * 1000 : at;
}

/** Local midnight for the day containing `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "just now" · "14:05" · "yesterday" · "Tue" · "31 Jul" · "3 Jul 2025".
 *
 * Returns `""` when there is no timestamp — an empty cell is honest, an
 * invented one is not.
 */
export function whenLabel(at: number | undefined | null, now: number): string {
  const ms = toMillis(at);
  if (ms == null) return "";
  const today = startOfDay(now);
  if (ms >= today) {
    if (now - ms < 90_000) return "just now";
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (ms >= today - DAY_MS) return "yesterday";
  if (ms >= today - 6 * DAY_MS) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  }
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "3 Jul" — used for the "started …" leg of a long-running thread. */
export function dayLabel(at: number | undefined | null): string {
  const ms = toMillis(at);
  if (ms == null) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

export type BucketKey = "pinned" | "today" | "yesterday" | "week" | "earlier";

const BUCKET_LABEL: Record<BucketKey, string> = {
  pinned: "PINNED",
  today: "TODAY",
  yesterday: "YESTERDAY",
  week: "EARLIER THIS WEEK",
  earlier: "EARLIER",
};

/** Recency bucket for one instant. Undated rows fall to `earlier`. */
export function recencyBucket(
  at: number | undefined | null,
  now: number,
): Exclude<BucketKey, "pinned"> {
  const ms = toMillis(at);
  if (ms == null) return "earlier";
  const today = startOfDay(now);
  if (ms >= today) return "today";
  if (ms >= today - DAY_MS) return "yesterday";
  if (ms >= today - 6 * DAY_MS) return "week";
  return "earlier";
}

/** The instant a row is sorted and bucketed by. */
export function conversationAt(c: Conversation): number | null {
  return toMillis(c.lastMessageAt) ?? toMillis(c.createdAt);
}

export interface ConversationSection {
  key: BucketKey;
  label: string;
  conversations: Conversation[];
}

/**
 * Pinned first (§11.3), then strict recency. Within every section the newest
 * row leads; undated rows sink rather than floating to the top on a `?? 0`.
 */
export function sectionize(
  conversations: readonly Conversation[],
  now: number,
): ConversationSection[] {
  const buckets = new Map<BucketKey, Conversation[]>();
  for (const c of conversations) {
    const key: BucketKey = c.isPinned
      ? "pinned"
      : recencyBucket(conversationAt(c), now);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const order: BucketKey[] = [
    "pinned",
    "today",
    "yesterday",
    "week",
    "earlier",
  ];
  const sections: ConversationSection[] = [];
  for (const key of order) {
    const list = buckets.get(key);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => (conversationAt(b) ?? 0) - (conversationAt(a) ?? 0));
    sections.push({ key, label: BUCKET_LABEL[key], conversations: list });
  }
  return sections;
}

/**
 * The header's census, computed from the rows on screen so the number and the
 * list can never disagree. `thisWeek` counts rows touched in the last seven
 * days; rows with no timestamp are counted in `total` only.
 */
export function census(
  conversations: readonly Conversation[],
  now: number,
): { total: number; thisWeek: number } {
  let thisWeek = 0;
  for (const c of conversations) {
    const ms = conversationAt(c);
    if (ms != null && now - ms < 7 * DAY_MS) thisWeek += 1;
  }
  return { total: conversations.length, thisWeek };
}

// ---------------------------------------------------------------------------
// Row state — glyph, word, hue, in that order of precedence
// ---------------------------------------------------------------------------

export type RowState = "running" | "unread";

export const ROW_STATE_META: Record<
  RowState,
  { glyph: string; word: string; color: string }
> = {
  // Distinct glyph AND a printed word for each, so the state survives being
  // read in greyscale. Colour is the last carrier, never the only one.
  running: { glyph: "◐", word: "running", color: C.amberText },
  unread: { glyph: "●", word: "unread", color: C.blueText },
};

/** `running` outranks `unread`: a live turn is the more urgent fact. */
export function rowState(c: Conversation): RowState | null {
  if (c.isProcessing) return "running";
  if (c.hasUnseenLatestAssistantMessage) return "unread";
  return null;
}

/**
 * Where the conversation came in from, when that is not the app itself.
 * `vellum` and `platform` mean "typed here", which is the default and so says
 * nothing worth a line.
 */
export function channelLabel(c: Conversation): string | null {
  const raw = c.channelBinding?.sourceChannel ?? c.originChannel;
  if (!raw || raw === "vellum" || raw === "platform") return null;
  const name =
    c.channelBinding?.slackChannel?.name ??
    c.channelBinding?.externalChatName ??
    c.channelBinding?.displayName ??
    null;
  const channel = raw.charAt(0).toUpperCase() + raw.slice(1);
  return name ? `${channel} · ${name}` : channel;
}

/**
 * The row's second line, assembled only from facts in hand. Returns `[]` when
 * there is nothing true to say — a quiet row beats a padded one, and "8
 * messages" is not available from this endpoint at any price.
 */
export function metaParts(c: Conversation, state: RowState | null): string[] {
  const parts: string[] = [];
  if (state) parts.push(ROW_STATE_META[state].word);
  const channel = channelLabel(c);
  if (channel) parts.push(channel);
  if (c.conversationType === "scheduled") parts.push("on a schedule");
  else if (c.conversationType === "background")
    parts.push("ran in the background");
  const started = toMillis(c.createdAt);
  const last = conversationAt(c);
  // Only when the thread genuinely spans days — otherwise "started" repeats
  // the timestamp already in the right-hand column.
  if (started != null && last != null && last - started >= DAY_MS) {
    parts.push(`started ${dayLabel(started)}`);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** Mono all-caps microlabel — the HQ "NEEDS YOU" voice. */
export function SectionHeading({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px 8px",
      }}
    >
      <h2
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: MUTED,
          margin: 0,
          fontWeight: 400,
        }}
      >
        {children}
      </h2>
      <span aria-hidden style={{ flex: 1, height: 1, background: C.line }} />
      {trailing}
    </div>
  );
}

/** A small outlined tag — the group chip, the scheduled chip. */
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "teal";
}) {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9.5,
        lineHeight: 1.6,
        padding: "1px 7px",
        borderRadius: 5,
        whiteSpace: "nowrap",
        color: tone === "teal" ? C.tealText : MUTED,
        background: C.sunken,
        border: `1px solid ${C.line}`,
      }}
    >
      {children}
    </span>
  );
}

/** The card the list sits in. */
export function ListCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.line}`,
        borderRadius: 13,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A filter chip. Always a real button with a real count — a chip is only
 * rendered when something is behind it, so clicking one can never produce a
 * blank list with no explanation.
 */
export function FilterChip({
  active,
  glyph,
  label,
  count,
  onClick,
}: {
  active: boolean;
  glyph?: string;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        fontWeight: active ? 600 : 400,
        padding: "6px 12px",
        borderRadius: 99,
        cursor: "pointer",
        whiteSpace: "nowrap",
        color: active ? C.surface : C.t2,
        background: active ? C.ink : C.surface,
        border: `1px solid ${active ? C.ink : C.line}`,
      }}
    >
      {glyph ? <span aria-hidden>{glyph}</span> : null}
      <span>{label}</span>
      <span style={{ fontFamily: mono, fontSize: 9.5, opacity: 0.75 }}>
        {count}
      </span>
    </button>
  );
}

/**
 * The state block used for every "there is nothing to draw" case.
 *
 * `tone="error"` is visually and verbally distinct from `tone="empty"`: a fetch
 * that failed is not an empty list, and the two must never be confused — an
 * error that reads as "you have no conversations" is how a user is told their
 * history is gone.
 */
export function StateBlock({
  tone,
  glyph,
  headline,
  sentence,
  action,
}: {
  tone: "empty" | "error";
  glyph: string;
  headline: string;
  sentence: string;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 6,
        padding: "26px 18px 28px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: tone === "error" ? C.dangerText : C.t1,
        }}
      >
        <span aria-hidden style={{ fontSize: 13 }}>
          {glyph}
        </span>
        <span style={{ fontFamily: serif, fontSize: 19, lineHeight: 1.2 }}>
          {headline}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 12.5,
          lineHeight: 1.55,
          color: C.t2,
          maxWidth: "62ch",
        }}
      >
        {sentence}
      </p>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/**
 * A quiet text button — used by the empty and error states, and by the
 * list's "Load older conversations" continuation, which is why it takes
 * `disabled`: a request already in flight must not be fired twice by an
 * impatient second tap.
 */
export function QuietButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "7px 13px",
        borderRadius: 8,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        color: C.surface,
        background: C.ink,
        border: `1px solid ${C.ink}`,
      }}
    >
      {children}
    </button>
  );
}
