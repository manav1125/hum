/**
 * Next moves — the unified queue (design v0.3 §02).
 *
 * Wired to the real home feed (`useHomeFeedQuery`): the daemon's proactivity
 * loop already aggregates email / chat / tasks / followups / approvals into one
 * ranked `FeedItem[]`, which is exactly this surface. Renders the live feed in
 * the v0.3 row design (urgency bar · category icon · title/summary · action
 * chip); feed actions and status changes go through the same mutations Home
 * uses. Calm working-surface styling per the design system.
 */

import {
  Calendar,
  CircleDot,
  Loader2,
  Mail,
  Settings2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router";

import type {
  FeedAction,
  FeedItem,
  FeedItemCategory,
} from "@vellumai/assistant-api";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { sortFeedItems } from "@/domains/home/utils";

const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blueW: "#DBE4FB",
  violet: "#7F77DD",
  violetS: "#534AB7",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#F1B21E",
  danger: "#DA491A",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/** Category → icon glyph + tile background (mirrors the v0.3 row icons). */
function categoryVisual(category: FeedItemCategory | undefined): {
  icon: ReactNode;
  bg: string;
} {
  switch (category) {
    case "email":
      return { icon: <Mail size={15} color={C.blueS} />, bg: C.blueW };
    case "scheduling":
      return { icon: <Calendar size={15} color="#8C7225" />, bg: "#FCF3DD" };
    case "security":
      return { icon: <ShieldAlert size={15} color={C.danger} />, bg: "#FDE7E2" };
    case "background":
      return { icon: <Sparkles size={15} color={C.violetS} />, bg: "#EEEDFB" };
    case "system":
      return { icon: <Settings2 size={15} color={C.t2} />, bg: C.sunken };
    default:
      return { icon: <CircleDot size={15} color={C.t2} />, bg: C.sunken };
  }
}

/** Urgency → the 3px left bar color. */
function urgencyColor(item: FeedItem): string {
  if (item.urgency === "critical" || item.urgency === "high") return C.danger;
  if (item.urgency === "medium") return C.amber;
  return C.line2;
}

export function NextMovesPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const feed = useHomeFeedQuery(assistantId);

  const items = useMemo(() => {
    const all = feed.data?.items ?? [];
    return sortFeedItems(all.filter((i) => i.status !== "dismissed"));
  }, [feed.data?.items]);

  const needsYou = items.filter((i) => i.status === "new").length;
  const waiting = items.filter((i) => i.status === "seen").length;
  const done = items.filter((i) => i.status === "acted_on").length;

  function handleAction(item: FeedItem, action: FeedAction) {
    feed.triggerAction.mutate({ itemId: item.id, actionId: action.id });
  }

  function handleOpen(item: FeedItem) {
    if (item.conversationId) {
      navigate(`/assistant/conversations/${item.conversationId}`);
    }
  }

  function handleDismiss(item: FeedItem) {
    feed.updateStatus.mutate({ itemId: item.id, status: "dismissed" });
  }

  function handleSnooze(item: FeedItem) {
    feed.updateStatus.mutate({ itemId: item.id, status: "seen" });
  }

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.blueS,
            marginBottom: 10,
          }}
        >
          Next moves
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 500, color: C.t1 }}>
            {items.length > 0
              ? `${items.length} ${items.length === 1 ? "thing" : "things"} · Cue ranked them for you`
              : "Next moves"}
          </div>
          {items.length > 0 ? (
            <div style={{ display: "flex", gap: 7 }}>
              <CountChip label="Needs you" n={needsYou} ink />
              {waiting > 0 ? <CountChip label="Waiting" n={waiting} /> : null}
              {done > 0 ? <CountChip label="Done" n={done} /> : null}
            </div>
          ) : null}
        </div>

        {feed.isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "24px 0",
              fontSize: 13,
              color: C.t2,
            }}
          >
            <Loader2 className="size-4 animate-spin" /> Gathering your next moves…
          </div>
        ) : items.length === 0 ? (
          <EmptyState error={feed.isError} />
        ) : (
          <div
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              overflow: "hidden",
              background: C.surface,
            }}
          >
            {items.map((item, idx) => (
              <MoveRow
                key={item.id}
                item={item}
                last={idx === items.length - 1}
                onAction={(action) => handleAction(item, action)}
                onOpen={() => handleOpen(item)}
                onDismiss={() => handleDismiss(item)}
                onSnooze={() => handleSnooze(item)}
                pending={
                  feed.triggerAction.isPending || feed.updateStatus.isPending
                }
              />
            ))}
          </div>
        )}

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.violet}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
            marginTop: 16,
          }}
        >
          Every other app makes you check five inboxes. Cue reads them all and
          gives you one ranked list of what actually needs you — the product
          promise, “never miss your next move.”
        </div>
      </div>
    </div>
  );
}

function CountChip({
  label,
  n,
  ink = false,
}: {
  label: string;
  n: number;
  ink?: boolean;
}) {
  return (
    <span
      style={{
        fontSize: 12,
        border: `1px solid ${ink ? C.ink : C.line2}`,
        background: ink ? C.ink : C.surface,
        color: ink ? "#fff" : C.t2,
        borderRadius: 8,
        padding: "5px 10px",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        whiteSpace: "nowrap",
      }}
    >
      {label} · {n}
    </span>
  );
}

function MoveRow({
  item,
  last,
  onAction,
  onOpen,
  onDismiss,
  onSnooze,
  pending,
}: {
  item: FeedItem;
  last: boolean;
  onAction: (action: FeedAction) => void;
  onOpen: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
  pending: boolean;
}) {
  const vis = categoryVisual(item.category);
  const title = item.title ?? item.summary;
  const sub = item.title ? item.summary : undefined;
  const actions = item.actions ?? [];
  const emphasize = item.urgency === "high" || item.urgency === "critical";
  const isDone = item.status === "acted_on";
  // Only offer "Open" when there is a real conversation to navigate to —
  // otherwise it would be a no-op chip.
  const canOpen = Boolean(item.conversationId);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "13px 16px",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
      }}
    >
      <span
        style={{
          width: 3,
          alignSelf: "stretch",
          borderRadius: 3,
          background: urgencyColor(item),
          flexShrink: 0,
        }}
      />
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: vis.bg,
          flexShrink: 0,
        }}
      >
        {vis.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {sub ? (
          <div
            style={{
              fontSize: 12,
              color: C.t2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
      {isDone ? (
        <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>done</span>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexShrink: 0,
          }}
        >
          {/* One runnable button per action — first emphasized, rest secondary. */}
          {actions.map((action, i) => (
            <RowButton
              key={action.id}
              label={action.label}
              variant={i === 0 && emphasize ? "primary" : "secondary"}
              disabled={pending}
              onClick={() => onAction(action)}
            />
          ))}
          {canOpen ? (
            <RowButton
              label="Open"
              variant={actions.length === 0 && emphasize ? "primary" : "secondary"}
              disabled={pending}
              onClick={onOpen}
            />
          ) : null}
          <RowButton
            label="Snooze"
            variant="ghost"
            disabled={pending}
            onClick={onSnooze}
          />
          <RowButton
            label="Dismiss"
            variant="ghost"
            disabled={pending}
            onClick={onDismiss}
          />
        </div>
      )}
    </div>
  );
}

/** Row action chip — primary (emphasized), secondary, or ghost (dismiss/snooze). */
function RowButton({
  label,
  variant,
  disabled,
  onClick,
}: {
  label: string;
  variant: "primary" | "secondary" | "ghost";
  disabled: boolean;
  onClick: () => void;
}) {
  const style =
    variant === "primary"
      ? { border: `1px solid ${C.blue}`, background: C.blue, color: "#fff" }
      : variant === "secondary"
        ? { border: `1px solid ${C.line2}`, background: C.surface, color: C.t1 }
        : { border: "1px solid transparent", background: "transparent", color: C.t2 };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 8,
        padding: "5px 10px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({ error }: { error: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.surface,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 500, color: C.t1 }}>
        {error ? "Couldn’t load your next moves" : "You’re all caught up"}
      </div>
      <div style={{ fontSize: 13, color: C.t2, marginTop: 6 }}>
        {error
          ? "Cue couldn’t reach the feed just now — try again in a moment."
          : "Cue ranks email, messages, tasks, approvals and calls here as they need you."}
      </div>
    </div>
  );
}
