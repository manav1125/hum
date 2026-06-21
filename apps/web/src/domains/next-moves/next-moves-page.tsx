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
// eslint-disable-next-line local/no-cross-domain-imports -- pre-existing; Home feed query reused
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
// eslint-disable-next-line local/no-cross-domain-imports -- pre-existing; Home feed sort reused
import { sortFeedItems } from "@/domains/home/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";

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
  const isMobile = useIsMobile();
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

  /**
   * Mark a task complete. Prefers the item's primary action (so the daemon
   * runs the real "do it" path and retires the card the same way the desktop
   * row's primary button does); falls back to a direct `acted_on` status flip
   * when an item exposes no actions. This preserves the "complete a task"
   * affordance the mobile checkbox stands in for.
   */
  function handleComplete(item: FeedItem) {
    const primary = (item.actions ?? [])[0];
    if (primary) {
      feed.triggerAction.mutate({ itemId: item.id, actionId: primary.id });
    } else {
      feed.updateStatus.mutate({ itemId: item.id, status: "acted_on" });
    }
  }

  if (isMobile) {
    return (
      <NextMovesMobile
        items={items}
        loading={feed.isLoading}
        error={feed.isError}
        pending={feed.triggerAction.isPending || feed.updateStatus.isPending}
        onComplete={handleComplete}
        onApprove={handleAction}
        onOpen={handleOpen}
      />
    );
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

/* ------------------------------------------------------------------ */
/* Mobile (Cue Mobile design book §02 — Tasks / `/next-moves`)         */
/* ------------------------------------------------------------------ */

/** Dark design tokens for the mobile Tasks screen (README-MOBILE §1). */
const M = {
  ink: "#1A2230",
  surface: "#212B3B",
  surface2: "#2A3547",
  blue: "#3D6EE8",
  lilac: "#7F77DD",
  green: "#3FB871",
  amber: "#E0A53B",
  t1: "#FFFFFF",
  t2: "#8A97AC",
  t3: "#5E6B80",
  line: "rgba(255,255,255,.08)",
  line2: "rgba(255,255,255,.14)",
  // Pill fills/text — exact values from the design book rows.
  workBg: "rgba(61,110,232,.18)",
  workFg: "#86A9F2",
  triageBg: "rgba(224,165,59,.18)",
  triageFg: "#E0A53B",
  doneBg: "rgba(63,184,113,.18)",
  doneFg: "#3FB871",
  approveBg: "rgba(127,119,221,.2)",
  approveFg: "#A59EF0",
} as const;

/** The fixed status taxonomy — DO NOT RENAME (README-MOBILE §3.2). */
type MoveStatus = "Working" | "Triaging" | "Done" | "Approve";

/** True when an item is gated on an explicit human approval. */
function needsApproval(item: FeedItem): boolean {
  return (item.actions ?? []).some((a) => a.defaultMode === "needs_you");
}

/**
 * Resolve a feed item to one of the four fixed pill statuses. The taxonomy
 * strings are part of the design contract and must not be renamed.
 */
function moveStatus(item: FeedItem): MoveStatus {
  if (item.status === "acted_on") return "Done";
  if (needsApproval(item)) return "Approve";
  if (
    item.urgency === "high" ||
    item.urgency === "critical" ||
    item.category === "background"
  ) {
    return "Working";
  }
  return "Triaging";
}

/** Human "project" label for the WORKING ON · {project} eyebrow. */
function projectLabel(category: FeedItemCategory | undefined): string {
  switch (category) {
    case "email":
      return "Inbox";
    case "scheduling":
      return "Scheduling";
    case "security":
      return "Security";
    case "background":
      return "Background work";
    case "task":
      return "Tasks";
    case "slack":
      return "Slack";
    case "telegram":
      return "Telegram";
    case "whatsapp":
      return "WhatsApp";
    case "chat":
      return "Conversations";
    case "system":
      return "System";
    default:
      return "General";
  }
}

function NextMovesMobile({
  items,
  loading,
  error,
  pending,
  onComplete,
  onApprove,
  onOpen,
}: {
  items: FeedItem[];
  loading: boolean;
  error: boolean;
  pending: boolean;
  onComplete: (item: FeedItem) => void;
  onApprove: (item: FeedItem, action: FeedAction) => void;
  onOpen: (item: FeedItem) => void;
}) {
  // Group rows into project sections (preserving the priority sort order
  // the page already applied to `items`).
  const groups = useMemo(() => {
    const order: FeedItemCategory[] = [];
    const buckets = new Map<FeedItemCategory, FeedItem[]>();
    for (const item of items) {
      const cat = (item.category ?? "system") as FeedItemCategory;
      if (!buckets.has(cat)) {
        buckets.set(cat, []);
        order.push(cat);
      }
      buckets.get(cat)!.push(item);
    }
    return order.map((cat) => ({ cat, items: buckets.get(cat)! }));
  }, [items]);

  // The first un-acted approval drives the bottom callout card.
  const approval = useMemo(
    () =>
      items.find((i) => i.status !== "acted_on" && needsApproval(i)) ?? null,
    [items],
  );
  const approvalAction = approval
    ? (approval.actions ?? []).find((a) => a.defaultMode === "needs_you") ?? null
    : null;

  const workingCount = items.filter(
    (i) => moveStatus(i) === "Working",
  ).length;
  const needsYouCount = items.filter(
    (i) => i.status !== "acted_on" && needsApproval(i),
  ).length;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: `linear-gradient(180deg,${M.ink} 0%,#11161F 78%,#0C1018 100%)`,
        color: M.t1,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        paddingTop:
          "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
      }}
    >
      {/* Header */}
      <div style={{ padding: "8px 20px 14px", flexShrink: 0 }}>
        <div
          style={{
            fontSize: 23,
            fontWeight: 600,
            letterSpacing: "-0.6px",
            color: M.t1,
          }}
        >
          Tasks
        </div>
        <div style={{ fontSize: 12.5, color: M.t2, marginTop: 2 }}>
          {loading
            ? "Gathering your tasks…"
            : `${workingCount} working · ${needsYouCount} needs you`}
        </div>
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 20px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {loading ? (
          <MobileSkeleton />
        ) : items.length === 0 ? (
          <MobileEmpty error={error} />
        ) : (
          groups.map((group) => (
            <div key={group.cat}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: M.t2,
                  marginBottom: 9,
                }}
              >
                Working on · {projectLabel(group.cat)}
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                {group.items.map((item) => (
                  <MobileMoveRow
                    key={item.id}
                    item={item}
                    pending={pending}
                    onComplete={() => onComplete(item)}
                    onOpen={() => onOpen(item)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        <div style={{ height: 8, flexShrink: 0 }} />
      </div>

      {/* Approval callout (lilac) */}
      {approval && approvalAction ? (
        <div
          style={{
            flexShrink: 0,
            margin: "0 16px 8px",
            background: "rgba(127,119,221,.12)",
            border: "1px solid rgba(127,119,221,.4)",
            borderRadius: 16,
            padding: "13px 14px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom:
              "calc(8px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 8.5,
                letterSpacing: "0.06em",
                color: M.approveFg,
              }}
            >
              APPROVAL NEEDED
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                marginTop: 3,
                color: M.t1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {approval.title ?? approval.summary}
            </div>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => onApprove(approval, approvalAction)}
            style={{
              background: M.lilac,
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              padding: "10px 16px",
              borderRadius: 11,
              border: "none",
              flexShrink: 0,
              minHeight: 44,
              cursor: pending ? "default" : "pointer",
              opacity: pending ? 0.6 : 1,
            }}
          >
            Approve
          </button>
        </div>
      ) : (
        <div
          style={{
            flexShrink: 0,
            height: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          }}
        />
      )}
    </div>
  );
}

/** One task row — checkbox · title · status pill. Tap row → detail/thread. */
function MobileMoveRow({
  item,
  pending,
  onComplete,
  onOpen,
}: {
  item: FeedItem;
  pending: boolean;
  onComplete: () => void;
  onOpen: () => void;
}) {
  const status = moveStatus(item);
  const isDone = status === "Done";
  const title = item.title ?? item.summary;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        background: M.surface,
        border: `1px solid ${M.line}`,
        borderRadius: 14,
        padding: "13px 14px",
        minHeight: 44,
        cursor: "pointer",
      }}
    >
      {/* Checkbox — completes the task; stops row-open propagation. */}
      <button
        type="button"
        aria-label={isDone ? "Completed" : "Complete task"}
        disabled={pending || isDone}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDone) onComplete();
        }}
        style={{
          width: 20,
          height: 20,
          borderRadius: 7,
          flexShrink: 0,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isDone ? M.green : "transparent",
          border: isDone ? "none" : `1.5px solid ${M.line2}`,
          color: "#fff",
          fontSize: 11,
          cursor: pending || isDone ? "default" : "pointer",
        }}
      >
        {isDone ? "✓" : ""}
      </button>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          color: isDone ? M.t2 : M.t1,
          textDecoration: isDone ? "line-through" : "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>

      <StatusPill status={status} />
    </div>
  );
}

/** Fixed status pill: Working (blue) · Triaging (amber) · Done (green ✓) · Approve (lilac). */
function StatusPill({ status }: { status: MoveStatus }) {
  const map: Record<MoveStatus, { bg: string; fg: string }> = {
    Working: { bg: M.workBg, fg: M.workFg },
    Triaging: { bg: M.triageBg, fg: M.triageFg },
    Done: { bg: M.doneBg, fg: M.doneFg },
    Approve: { bg: M.approveBg, fg: M.approveFg },
  };
  const { bg, fg } = map[status];
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9,
        background: bg,
        color: fg,
        borderRadius: 6,
        padding: "3px 8px",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {status === "Done" ? "✓ Done" : status}
    </span>
  );
}

/** Empty state — "No moves right now" (README-MOBILE §3.2). */
function MobileEmpty({ error }: { error: boolean }) {
  return (
    <div
      style={{
        marginTop: 40,
        textAlign: "center",
        padding: "0 16px",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: M.t1 }}>
        {error ? "Couldn’t load your tasks" : "No moves right now"}
      </div>
      <div
        style={{
          fontSize: 13,
          color: M.t2,
          marginTop: 6,
          lineHeight: 1.5,
        }}
      >
        {error
          ? "Cue couldn’t reach the feed just now — try again in a moment."
          : "Cue tracks the work in flight here. New moves show up as they need you."}
      </div>
    </div>
  );
}

/** Loading state — shimmer skeleton rows. */
function MobileSkeleton() {
  return (
    <div>
      <style>
        {`@keyframes cueShimMobile{0%{background-position:-160px 0}100%{background-position:340px 0}}
          @media (prefers-reduced-motion: reduce){.cue-shim-row{animation:none!important}}`}
      </style>
      <div
        style={{
          fontFamily: mono,
          fontSize: 9,
          letterSpacing: "0.1em",
          color: M.t2,
          marginBottom: 9,
        }}
      >
        WORKING ON · …
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="cue-shim-row"
            style={{
              height: 48,
              borderRadius: 14,
              border: `1px solid ${M.line}`,
              background: `linear-gradient(90deg,${M.surface} 0%,${M.surface2} 50%,${M.surface} 100%)`,
              backgroundSize: "500px 100%",
              animation: "cueShimMobile 1.3s linear infinite",
            }}
          />
        ))}
      </div>
    </div>
  );
}
