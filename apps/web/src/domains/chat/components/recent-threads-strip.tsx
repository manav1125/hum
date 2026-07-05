/**
 * "PICK UP WHERE YOU LEFT OFF" recent-thread strip for the chat empty state
 * (Cue-Surfaces S6). A small grid of the most-recently-touched conversations,
 * each a one-card row with a source badge, title, and relative-time note.
 * Clicking a card navigates to that conversation.
 *
 * Purely additive: renders only on a fresh/empty conversation, below the
 * suggestion chips. It never touches the live transcript, composer, or
 * streaming — it just reads the existing conversation-list query and reuses
 * the shared `navigateToConversation` helper.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";

import { useConversationListQuery } from "@/hooks/conversation-queries";
import { navigateToConversation } from "@/domains/chat/utils/conversation-navigation";

/** How many recent threads to surface. */
const MAX_RECENT_THREADS = 4;

// Theme-aware tokens (shipped `--mv1-*` system) + shared helpers, inlined to
// respect the cross-domain import boundary (chat must not import from
// domains/activity or pages/projects).
const C = {
  ink: "var(--mv1-t1)",
  t1: "var(--mv1-t1)",
  t3: "var(--mv1-t3)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/** Best-effort epoch (ms or s) → "3m ago" relative label. */
function relativeTime(epoch: number | null | undefined): string | null {
  if (epoch == null || !Number.isFinite(epoch)) return null;
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const diff = Date.now() - ms;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Source-type → badge glyph + tint (mirrors the HQ sourceBadge map). */
function sourceBadge(sourceType: string | null): {
  glyph: string;
  tint: string;
} {
  const t = (sourceType ?? "").toLowerCase();
  if (t.includes("mail") || t.includes("email"))
    return { glyph: "✉", tint: "#EA4335" };
  if (t.includes("slack")) return { glyph: "#", tint: "#4A154B" };
  if (t.includes("call") || t.includes("voice") || t.includes("phone"))
    return { glyph: "☎", tint: "var(--hq-teal, #0E8C8C)" };
  if (t.includes("telegram")) return { glyph: "✈", tint: "#229ED9" };
  if (t.includes("calendar")) return { glyph: "◱", tint: "#1A73E8" };
  if (t.includes("schedule") || t.includes("cron"))
    return { glyph: "◷", tint: "var(--mv1-violet)" };
  return { glyph: "◆", tint: "var(--mv1-blue)" };
}

/** Slot-① source badge tile. */
function SourceBadge({ sourceType }: { sourceType: string | null }) {
  const { glyph, tint } = sourceBadge(sourceType);
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        background: tint,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 8,
        flexShrink: 0,
      }}
    >
      {glyph}
    </span>
  );
}

export function RecentThreadsStrip({
  assistantId,
  activeConversationId,
}: {
  assistantId: string | null;
  /** The current (draft) conversation — excluded from the strip. */
  activeConversationId?: string | null;
}) {
  const navigate = useNavigate();
  const { conversations } = useConversationListQuery(
    assistantId,
    Boolean(assistantId),
  );

  const recents = useMemo(() => {
    return conversations
      .filter(
        (c) =>
          !c.draft &&
          !c.archivedAt &&
          c.conversationId !== activeConversationId &&
          // Only threads that actually have activity ("where you left off").
          (c.lastMessageAt != null || c.latestAssistantMessageAt != null),
      )
      .sort(
        (a, b) =>
          (b.lastMessageAt ?? b.latestAssistantMessageAt ?? 0) -
          (a.lastMessageAt ?? a.latestAssistantMessageAt ?? 0),
      )
      .slice(0, MAX_RECENT_THREADS);
  }, [conversations, activeConversationId]);

  if (recents.length === 0) return null;

  return (
    <div className="mt-6">
      <div
        style={{
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.t3,
          marginBottom: 10,
          textAlign: "center",
        }}
      >
        Pick up where you left off
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fill, minmax(min(100%, 240px), 1fr))",
          gap: 8,
        }}
      >
        {recents.map((c) => {
          const when = relativeTime(
            c.lastMessageAt ?? c.latestAssistantMessageAt,
          );
          const source = c.originChannel ?? c.source ?? "chat";
          return (
            <button
              key={c.conversationId}
              type="button"
              onClick={() => navigateToConversation(navigate, c.conversationId)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 9,
                textAlign: "left",
                background: C.surface,
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                padding: "11px 13px",
                cursor: "pointer",
                color: C.ink,
                minWidth: 0,
              }}
            >
              <span style={{ marginTop: 1 }}>
                <SourceBadge sourceType={source} />
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: C.t1,
                    lineHeight: 1.3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.title?.trim() || "Untitled conversation"}
                </span>
                {when ? (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: C.t3,
                      marginTop: 3,
                    }}
                  >
                    {when}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
