import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ArrowRight,
  Bell,
  CalendarClock,
  ChevronDown,
  ListTodo,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  Mic,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@vellumai/design-library/components/toast";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useDashboardQuery } from "@/domains/dashboard/use-dashboard-query";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useHomeFeedQuery } from "@/domains/home/hooks/use-home-feed-query";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { selectNextMove } from "@/domains/home/utils";
import {
  homeImpactGetOptions,
  schedulesGetOptions,
  usageTotalsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";
import type { FeedItem } from "@vellumai/assistant-api";

/**
 * Home — the flagship command center.
 *
 * A three-zone editorial layout on the calm light canvas (the app supplies the
 * dark sidebar): a CENTER column that opens with the living "moment" — aperture
 * avatar, a mono eyebrow, and a serif greeting that names the user's single
 * most important move — then an ink "drafted for you" hero card, a single-line
 * "Ask Cue" bar, a scannable "Also needs you" queue with Needs-you / Waiting /
 * Done status tabs, and a "while you slept" recap strip; and a RIGHT RAIL
 * ("Your Day") with a vertical timeline of upcoming schedules + recently-handled
 * work, plus open commitments.
 *
 * Every zone is wired to real data — the home feed, impact, schedules, and usage
 * totals — and both states are first-class: the FULL board (items present) and
 * the calm "all caught up" empty state. No metrics are fabricated; zones that
 * have no real data degrade to honest empty copy.
 */

// Exact design tokens (mirrors the inline palette in the approved mock).
const C = {
  ink: "#1A2230",
  blue: "#3D6EE8",
  blueS: "#2B53C4",
  blue9: "#9DB4E6",
  violet: "#7F77DD",
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  sunken: "#EEF1F6",
  line: "#E5E9F0",
  line2: "#D7DDE7",
  t1: "#1A2230",
  t2: "#5A6672",
  t3: "#8D99A5",
  green: "#277E41",
  amber: "#C98A1B",
  danger: "#DA491A",
  white: "#FFFFFF",
} as const;

const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

// Dark mobile tokens — the design-book "Today" palette (README §1, Dark v1).
// Mirrors the inline hexes in `Cue Mobile.dc.html` so the mobile branch reads
// as one coherent dark surface independent of the light desktop canvas.
const M = {
  ink: "#1A2230",
  inkDeep: "#11161F",
  inkBottom: "#0C1018",
  surface: "#212B3B",
  surface2: "#2A3547",
  blue: "#3D6EE8",
  blueDeep: "#2B53C4",
  blueEyebrow: "#86A9F2",
  lilac: "#7F77DD",
  lilacText: "#A59EF0",
  t1: "#FFFFFF",
  t2: "#8A97AC",
  t3: "#5E6B80",
  green: "#3FB871",
  amber: "#E0A53B",
  danger: "#E5634B",
  line: "rgba(255,255,255,.08)",
  line2: "rgba(255,255,255,.14)",
  markChip: "#0F1620",
} as const;

const MOBILE_KEYFRAMES = `
@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}
@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}
@keyframes cuePing{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.5);opacity:0}}
@keyframes cueShim{0%{background-position:-260px 0}100%{background-position:260px 0}}
@media (prefers-reduced-motion: reduce){.cue-today-anim *{animation:none !important}}
`;

const KEYFRAMES = `
@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}
@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}
@keyframes cuePing{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion: reduce){.cue-anim *{animation:none !important}}
`;

function ApertureAvatar({ size = 34 }: { size?: number }) {
  const ring = Math.round(size * 0.59);
  return (
    <span
      className="cue-anim"
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: 10,
        background: C.ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 10,
          border: "1.5px solid rgba(61,110,232,.5)",
          animation: "cuePing 2.8s ease-out infinite",
        }}
      />
      <span
        style={{
          width: ring,
          height: ring,
          borderRadius: "50%",
          boxShadow: "0 0 0 4px #EEF2F7 inset",
          WebkitMask: "radial-gradient(circle,transparent 56%,#000 57%)",
          mask: "radial-gradient(circle,transparent 56%,#000 57%)",
          transform: "rotate(40deg)",
          animation: "cueLook 6s ease-in-out infinite",
          position: "relative",
          display: "block",
        }}
      >
        <span
          style={{
            position: "absolute",
            borderRadius: "50%",
            background: C.blue,
            width: "26%",
            height: "26%",
            top: "8%",
            left: "8%",
            animation: "cueBlink 4s infinite",
            display: "block",
          }}
        />
      </span>
    </span>
  );
}

function urgencyColor(item: FeedItem): string {
  if (item.urgency === "critical" || item.urgency === "high") return C.danger;
  if (item.urgency === "medium") return C.amber;
  return C.line2;
}

// Per-category glyph + wash for the queue's 34px icon tiles. The wash tints are
// the mock's exact chip backgrounds; the strong colour drives the glyph.
const QUEUE_CHIP_STYLE: Record<
  string,
  { icon: LucideIcon; wash: string; ink: string; provenance: string }
> = {
  email: { icon: Mail, wash: "#FDE7E2", ink: C.danger, provenance: "Email" },
  scheduling: {
    icon: CalendarClock,
    wash: "#FBF0DA",
    ink: C.amber,
    provenance: "Calendar",
  },
  security: {
    icon: ShieldCheck,
    wash: "#EEEDFB",
    ink: C.blueS,
    provenance: "Security",
  },
  background: {
    icon: Sparkles,
    wash: "#EEEDFB",
    ink: "#534AB7",
    provenance: "Background",
  },
  slack: {
    icon: MessageSquare,
    wash: "#EAF2EC",
    ink: C.green,
    provenance: "Slack",
  },
  telegram: {
    icon: Send,
    wash: "#E5EEFB",
    ink: C.blueS,
    provenance: "Telegram",
  },
  whatsapp: {
    icon: MessageCircle,
    wash: "#EAF2EC",
    ink: C.green,
    provenance: "WhatsApp",
  },
  chat: {
    icon: MessageCircle,
    wash: "#E5EEFB",
    ink: C.blueS,
    provenance: "Message",
  },
  task: {
    icon: ListTodo,
    wash: "#EEEDFB",
    ink: "#534AB7",
    provenance: "Task",
  },
  system: { icon: Bell, wash: C.sunken, ink: C.t2, provenance: "System" },
};

function queueChipStyle(item: FeedItem) {
  return QUEUE_CHIP_STYLE[item.category ?? "system"] ?? QUEUE_CHIP_STYLE.system;
}

type QueueTab = "new" | "seen" | "acted_on";
const QUEUE_TABS: { id: QueueTab; label: string }[] = [
  { id: "new", label: "Needs you" },
  { id: "seen", label: "Waiting" },
  { id: "acted_on", label: "Done" },
];

function formatScheduleTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Activity route deep-linked to a specific run. Background/needs-you feed
 * actions mint a `workItemId`; passing it as `?focus=` lets the Activity surface
 * scroll to and highlight that row the moment it lands.
 */
function activityRouteFor(workItemId?: string): string {
  return workItemId
    ? `${routes.activity}?focus=${encodeURIComponent(workItemId)}`
    : routes.activity;
}

type FeedActionShape = {
  label: string;
  defaultMode?: "background" | "thread" | "needs_you";
  allowBackground?: boolean;
};

type RunMode = "smart" | "background" | "thread";

/**
 * Split-button for a feed item's primary action. The wide segment runs the
 * smart default (server routes off the autonomy policy); the caret opens an
 * override menu ("Run in background" / "Open as chat"). The `title` tooltip
 * + a subtle caption surface what the smart default will do.
 */
const RUN_MODES_HINT_KEY = "cue.firstRun.runModesHintSeen";

function ActionSplitButton({
  action,
  pending,
  variant,
  onRun,
  firstRun = false,
}: {
  action: FeedActionShape;
  pending: boolean;
  variant: "primary" | "subtle";
  onRun: (mode?: RunMode) => void;
  /** When true (and not seen before), show a one-time hint about run modes. */
  firstRun?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    if (!firstRun) return;
    try {
      if (!localStorage.getItem(RUN_MODES_HINT_KEY)) setShowHint(true);
    } catch {
      /* localStorage unavailable — skip the hint */
    }
  }, [firstRun]);
  const dismissHint = useCallback(() => {
    setShowHint(false);
    try {
      localStorage.setItem(RUN_MODES_HINT_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const isPrimary = variant === "primary";
  const hint =
    action.defaultMode === "background"
      ? "Runs in the background"
      : action.defaultMode === "needs_you"
        ? "Asks before doing anything"
        : "Opens a conversation";

  const seg: React.CSSProperties = {
    fontSize: isPrimary ? 12.5 : 12,
    fontWeight: 500,
    background: isPrimary ? C.blue : C.white,
    color: isPrimary ? C.white : C.t1,
    border: isPrimary ? "none" : `1px solid ${C.line2}`,
    cursor: pending ? "default" : "pointer",
    opacity: pending ? 0.7 : 1,
  };
  const divider = isPrimary
    ? "1px solid rgba(255,255,255,0.28)"
    : `1px solid ${C.line2}`;

  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}
    >
      <button
        type="button"
        onClick={() => {
          if (showHint) dismissHint();
          onRun("smart");
        }}
        disabled={pending}
        title={hint}
        style={{
          ...seg,
          padding: isPrimary ? "10px 15px" : "8px 12px",
          borderRadius: isPrimary ? "9px 0 0 9px" : "8px 0 0 8px",
          borderRight: "none",
        }}
      >
        {action.label}
      </button>
      <button
        type="button"
        onClick={() => {
          if (showHint) dismissHint();
          setOpen((o) => !o);
        }}
        disabled={pending}
        aria-label="More run options"
        style={{
          ...seg,
          padding: isPrimary ? "10px 7px" : "8px 6px",
          borderRadius: isPrimary ? "0 9px 9px 0" : "0 8px 8px 0",
          borderLeft: divider,
          display: "flex",
          alignItems: "center",
        }}
      >
        <ChevronDown size={13} />
      </button>
      {showHint && !open && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 41,
            width: 220,
            background: C.ink,
            color: C.white,
            borderRadius: 10,
            padding: "11px 13px",
            boxShadow: "0 10px 28px rgba(20,30,50,0.22)",
            fontSize: 12,
            lineHeight: 1.45,
            textAlign: "left",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: -5,
              right: 12,
              width: 10,
              height: 10,
              background: C.ink,
              transform: "rotate(45deg)",
              borderRadius: 2,
            }}
          />
          Cue picks the smart way to run this. Tap the arrow to run it in the
          background or open it as a chat instead.
          <button
            type="button"
            onClick={dismissHint}
            style={{
              display: "block",
              marginTop: 8,
              marginLeft: "auto",
              fontSize: 11.5,
              fontWeight: 500,
              color: C.white,
              background: "rgba(255,255,255,.16)",
              border: "none",
              borderRadius: 7,
              padding: "5px 11px",
              cursor: "pointer",
            }}
          >
            Got it
          </button>
        </div>
      )}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 5px)",
            right: 0,
            zIndex: 40,
            background: C.white,
            border: `1px solid ${C.line2}`,
            borderRadius: 10,
            boxShadow: "0 10px 28px rgba(20,30,50,0.16)",
            overflow: "hidden",
            minWidth: 184,
          }}
        >
          <SplitMenuItem
            label="Run in background"
            sub={
              action.allowBackground === false
                ? "Consequential — Cue will ask first"
                : "Cue does it, posts the result"
            }
            onClick={() => {
              setOpen(false);
              onRun("background");
            }}
          />
          <SplitMenuItem
            label="Open as chat"
            sub="Work on it together"
            onClick={() => {
              setOpen(false);
              onRun("thread");
            }}
          />
        </div>
      )}
    </div>
  );
}

function SplitMenuItem({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: `1px solid ${C.bg}`,
        padding: "9px 13px",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.bg)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div style={{ fontSize: 12.5, fontWeight: 500, color: C.t1 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.t3, marginTop: 1 }}>{sub}</div>
    </button>
  );
}

export function HomeElevatedRoute() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const assistantId = useActiveAssistantId();
  const feedQuery = useHomeFeedQuery(assistantId);
  const stateQuery = useHomeStateQuery(assistantId);

  const impactQuery = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { rangeDays: 7 },
    }),
    enabled: !!assistantId,
  });

  // Month-to-date spend for the stat strip — honest usage cost, not fabricated.
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }, []);
  const usageQuery = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { from: monthStart, to: usageRangeNow() },
    }),
    enabled: !!assistantId,
  });

  const schedulesQuery = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
  });

  const items = feedQuery.data?.items ?? [];
  // The "Also needs you" queue is multi-stream: action-board cards (email +
  // calendar), work-item cards (the agent's queued work, incl. Slack items),
  // and channel-triage cards all belong here. We exclude only the synthetic
  // daily summary header (`action-board:<date>:summary`) — it's a banner, not
  // an actionable card. Everything else flows through the same one-click
  // framework with channel-aware category icons + provenance chips.
  const boardItems = items.filter((i) => !i.id.endsWith(":summary"));
  const nextMove = selectNextMove(boardItems);

  // The queue is the full board minus the hero move, kept at real status so the
  // Needs-you / Waiting / Done tabs filter honestly.
  const queueItems = useMemo(
    () =>
      boardItems
        .filter((i) => i.id !== nextMove?.id && i.status !== "dismissed")
        .sort((a, b) => b.priority - a.priority),
    [boardItems, nextMove?.id],
  );
  const [queueTab, setQueueTab] = useState<QueueTab>("new");
  const tabbed = queueItems.filter((i) => i.status === queueTab);
  const tabCount = (t: QueueTab) =>
    queueItems.filter((i) => i.status === t).length;

  // Open commitments for the rail: the live (not-yet-done) board items.
  const openCommitments = queueItems
    .filter((i) => i.status !== "acted_on")
    .slice(0, 3);

  const userName = stateQuery.data?.userName?.trim();
  const hour = new Date().getHours();
  const greetingWord =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const greeting = userName ? `${greetingWord}, ${userName}` : greetingWord;

  const handled = impactQuery.data?.taskCount ?? 0;
  const hoursSaved = impactQuery.data?.hoursSaved ?? 0;
  const recent = impactQuery.data?.recent ?? [];
  const spend = usageQuery.data?.totalEstimatedCostUsd ?? 0;

  // Upcoming schedules for the day rail — real, enabled, future-dated runs.
  const upcoming = useMemo(() => {
    const list = schedulesQuery.data?.schedules ?? [];
    // eslint-disable-next-line react-hooks/purity -- Date.now() inside a memo (recomputed on schedule change), not a render-loop read
    const now = Date.now();
    return list
      .filter((s) => s.enabled && s.nextRunAt > now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .slice(0, 5);
  }, [schedulesQuery.data?.schedules]);
  const scheduledCount = upcoming.length;

  // Mark only the featured hero move "seen" once surfaced (mirrors home-page's
  // new→seen flip). The queue keeps real status so its tabs stay honest.
  const seenItemIds = useRef<Set<string>>(new Set());
  const updateStatusMutate = feedQuery.updateStatus.mutate;
  useEffect(() => {
    if (
      nextMove &&
      nextMove.status === "new" &&
      !seenItemIds.current.has(nextMove.id)
    ) {
      seenItemIds.current.add(nextMove.id);
      updateStatusMutate({ itemId: nextMove.id, status: "seen" });
    }
  }, [nextMove, updateStatusMutate]);

  const now = new Date();
  const day = now
    .toLocaleDateString(undefined, { weekday: "long" })
    .toUpperCase();
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const seedChat = (prompt: string) => {
    useViewerStore.getState().setMainView("chat");
    const id = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(id);
    navigate(`${routes.conversation(id)}?prompt=${encodeURIComponent(prompt)}`);
    requestComposerFocus();
  };
  const action = (item: FeedItem) => item.actions?.[0] ?? null;

  // Invoke a feed item's primary action. `mode` selects how it runs:
  // undefined/"smart" lets the daemon route off the autonomy policy; the
  // split-button caret passes "background" or "thread" explicitly. On the
  // response we navigate (thread) or confirm (background/needs_you). Fall back
  // to seeding chat only when an action has a prompt but no id (defensive).
  const runAction = (
    item: FeedItem,
    mode?: "smart" | "background" | "thread",
  ) => {
    const a = action(item);
    if (!a) return;
    if (a.id) {
      feedQuery.triggerAction.mutate(
        { itemId: item.id, actionId: a.id, mode },
        {
          onSuccess: (data) => {
            const resolved = (
              data as {
                mode?: string;
                conversationId?: string;
                workItemId?: string;
              }
            )?.mode;
            const conversationId = (data as { conversationId?: string })
              ?.conversationId;
            const workItemId = (data as { workItemId?: string })?.workItemId;
            if (resolved === "thread" && conversationId) {
              navigate(routes.conversation(conversationId));
            } else if (resolved === "background") {
              toast.success("Running in the background — track it in Activity.", {
                action: {
                  label: "View in Activity",
                  onClick: () => navigate(activityRouteFor(workItemId)),
                },
              });
            } else if (resolved === "needs_you") {
              toast.success("Queued — it'll wait for your approval in Activity.", {
                action: {
                  label: "Review in Activity",
                  onClick: () => navigate(activityRouteFor(workItemId)),
                },
              });
            }
          },
        },
      );
    } else {
      seedChat(a.prompt);
    }
  };

  const dismissItem = (item: FeedItem) => {
    feedQuery.updateStatus.mutate({ itemId: item.id, status: "dismissed" });
  };

  // MOBILE — render the clean design-book "Today" screen instead of the
  // desktop command center. Reuses every handler/datum above (home feed,
  // next-move selection, the split-button action-mode execution, and
  // approve→runAction / deny→dismiss). The app shell already supplies the
  // status bar + bottom tab bar, so this branch renders only the content
  // column (greeting + card stack) and the pinned composer.
  if (isMobile) {
    // The mobile "next-move stack" is the hero move first, then the rest of
    // the live queue (still ordered by priority) — one continuous stack of
    // cards as the design book shows, not a separate hero + queue.
    const moveStack = [
      ...(nextMove ? [nextMove] : []),
      ...queueItems.filter((i) => i.status !== "acted_on"),
    ];
    return (
      <TodayMobile
        assistantId={assistantId}
        greeting={greeting}
        day={day}
        time={time}
        userName={userName}
        loading={feedQuery.isLoading}
        moves={moveStack}
        actionPending={feedQuery.triggerAction.isPending}
        action={action}
        onRun={runAction}
        onApprove={(item) => runAction(item, "smart")}
        onDeny={dismissItem}
        onOpenConversation={(id) => navigate(routes.conversation(id))}
        onVoice={() => navigate(routes.voice)}
        onActivity={() => navigate(routes.activity)}
      />
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: C.bg,
        color: C.t1,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 308px",
        overflow: "hidden",
      }}
      className="cue-home"
    >
      <style
        dangerouslySetInnerHTML={{
          __html:
            KEYFRAMES +
            `@media (max-width: 880px){.cue-home{grid-template-columns:1fr !important;}.cue-home>aside{border-left:none !important;border-top:1px solid ${C.line} !important;}}`,
        }}
      />

      {/* CENTER COLUMN */}
      <div style={{ overflowY: "auto" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 8px" }}>
          {/* THE MOMENT */}
          <div
            style={{ padding: "30px 20px 22px", borderBottom: `1px solid ${C.line}` }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <ApertureAvatar size={38} />
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.t3,
                  letterSpacing: ".04em",
                }}
              >
                {day} · {time}
                {handled > 0 ? ` · ${handled} HANDLED THIS WEEK` : ""}
              </span>
              <button
                type="button"
                onClick={() => navigate(routes.meeting)}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: C.white,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 9,
                  padding: "7px 13px",
                  fontSize: 12,
                  fontWeight: 500,
                  color: C.t1,
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(26,34,48,.04)",
                }}
              >
                <Mic width={14} height={14} color={C.blueS} />
                Take into a meeting
              </button>
            </div>

            <div
              style={{
                fontFamily: serif,
                fontSize: 31,
                letterSpacing: "-.3px",
                lineHeight: 1.14,
                marginTop: 16,
                maxWidth: 600,
                color: C.ink,
              }}
            >
              {nextMove ? (
                <>
                  {greeting}. Your one move right now is{" "}
                  <span style={{ fontStyle: "italic", color: C.blueS }}>
                    {nextMove.title ?? nextMove.summary}.
                  </span>
                </>
              ) : (
                <>
                  {greeting}. You&apos;re all caught up — nothing needs you right
                  now.
                </>
              )}
            </div>

            {/* THE ONE MOVE — ink hero card, only when a top move exists. */}
            {nextMove && (
              <div
                style={{
                  background: C.ink,
                  color: C.white,
                  borderRadius: 14,
                  padding: "17px 19px",
                  marginTop: 18,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  boxShadow: "0 20px 38px -22px rgba(26,34,48,.62)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: 10,
                      color: C.blue9,
                      letterSpacing: ".06em",
                    }}
                  >
                    {nextMove.category === "email"
                      ? "DRAFTED FOR YOU"
                      : `${(nextMove.urgency ?? "next move").toUpperCase()} · DRAFTED FOR YOU`}
                  </div>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 500,
                      marginTop: 5,
                      lineHeight: 1.3,
                    }}
                  >
                    {nextMove.title ?? nextMove.summary}
                  </div>
                  {nextMove.title && (
                    <div
                      style={{
                        fontSize: 12.5,
                        color: C.blue9,
                        marginTop: 4,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {nextMove.summary}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  {action(nextMove) && (
                    <ActionSplitButton
                      action={action(nextMove)!}
                      variant="primary"
                      pending={feedQuery.triggerAction.isPending}
                      onRun={(mode) => runAction(nextMove, mode)}
                      firstRun
                    />
                  )}
                  {nextMove.conversationId && (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(routes.conversation(nextMove.conversationId!))
                      }
                      style={{
                        fontSize: 12.5,
                        background: "rgba(255,255,255,.1)",
                        color: C.white,
                        border: "none",
                        borderRadius: 9,
                        padding: "10px 15px",
                        cursor: "pointer",
                      }}
                    >
                      Open
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ASK CUE — the elegant single-line command bar. */}
            <HomeQueryBar assistantId={assistantId} />

            {/* STAT STRIP — the dashboard's value folded in as one tasteful row
                of mono chips that link to detail. Real impact / usage / schedule
                data; chips with no data are omitted. */}
            <div
              style={{
                marginTop: 16,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {hoursSaved > 0 && (
                <StatChip
                  label={`≈${hoursSaved} hrs saved`}
                  onClick={() => navigate(routes.impact)}
                  accent={C.green}
                />
              )}
              {spend > 0 && (
                <StatChip
                  label={`$${spend.toFixed(2)} spent this month`}
                  onClick={() => navigate(routes.settings.budget)}
                />
              )}
              {scheduledCount > 0 && (
                <StatChip
                  label={`${scheduledCount} scheduled`}
                  onClick={() => navigate(routes.settings.schedules)}
                />
              )}
            </div>
          </div>

          {/* ALSO NEEDS YOU — queue with status tabs. */}
          {queueItems.length > 0 && (
            <>
              <div
                style={{
                  padding: "20px 20px 10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: mono,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: C.t3,
                    }}
                  >
                    Also needs you · {queueItems.length}
                  </div>
                  <div
                    style={{
                      display: "inline-flex",
                      background: C.sunken,
                      borderRadius: 9,
                      padding: 3,
                      gap: 2,
                    }}
                  >
                    {QUEUE_TABS.map((t) => {
                      const isActive = t.id === queueTab;
                      const n = tabCount(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setQueueTab(t.id)}
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            border: "none",
                            background: isActive ? C.white : "transparent",
                            color: isActive ? C.t1 : C.t2,
                            borderRadius: 7,
                            padding: "5px 11px",
                            cursor: "pointer",
                            boxShadow: isActive
                              ? "0 1px 2px rgba(26,34,48,.08)"
                              : "none",
                          }}
                        >
                          {t.label}
                          {n > 0 ? ` ${n}` : ""}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(routes.nextMoves)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 500,
                    color: C.blueS,
                    cursor: "pointer",
                  }}
                >
                  See all moves ›
                </button>
              </div>

              <div
                style={{
                  padding: "0 20px 8px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {tabbed.length === 0 ? (
                  <div
                    style={{
                      fontSize: 13,
                      color: C.t3,
                      padding: "16px 0 4px",
                    }}
                  >
                    Nothing here.
                  </div>
                ) : (
                  tabbed.map((item, i) => {
                    const chip = queueChipStyle(item);
                    const ChipIcon = chip.icon;
                    const a = action(item);
                    const isDone = item.status === "acted_on";
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 13,
                          padding: "14px 0",
                          borderBottom:
                            i < tabbed.length - 1
                              ? `1px solid ${C.line}`
                              : "none",
                          opacity: isDone ? 0.62 : 1,
                        }}
                      >
                        <span
                          style={{
                            width: 3,
                            height: 36,
                            borderRadius: 3,
                            background: urgencyColor(item),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          aria-hidden="true"
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 9,
                            background: chip.wash,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <ChipIcon width={16} height={16} color={chip.ink} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13.5,
                              fontWeight: 500,
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {item.title ?? item.summary}
                            </span>
                            <span
                              style={{
                                fontFamily: mono,
                                fontSize: 9.5,
                                letterSpacing: ".04em",
                                textTransform: "uppercase",
                                color: chip.ink,
                                background: chip.wash,
                                borderRadius: 5,
                                padding: "2px 6px",
                                flexShrink: 0,
                              }}
                            >
                              {chip.provenance}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: C.t2,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              marginTop: 2,
                            }}
                          >
                            {item.title ? item.summary : ""}
                          </div>
                        </div>
                        {a && !isDone && (
                          <ActionSplitButton
                            action={a}
                            variant="subtle"
                            pending={feedQuery.triggerAction.isPending}
                            onRun={(mode) => runAction(item, mode)}
                          />
                        )}
                        {isDone ? (
                          <span
                            style={{
                              fontSize: 11,
                              fontFamily: mono,
                              color: C.green,
                              flexShrink: 0,
                            }}
                          >
                            Done
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => dismissItem(item)}
                            aria-label={`Dismiss ${item.title ?? item.summary}`}
                            title="Dismiss"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 26,
                              height: 26,
                              border: "none",
                              background: "transparent",
                              borderRadius: 7,
                              padding: 0,
                              cursor: "pointer",
                              color: C.t3,
                              flexShrink: 0,
                            }}
                          >
                            <X width={14} height={14} />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}

          {/* WHILE YOU SLEPT — recap strip → Impact. */}
          <button
            type="button"
            onClick={() => navigate(routes.impact)}
            style={{
              margin: "16px 20px 26px",
              width: "calc(100% - 40px)",
              background: C.sunken,
              border: "none",
              borderRadius: 13,
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: C.t3,
                letterSpacing: ".1em",
                whiteSpace: "nowrap",
              }}
            >
              WHILE YOU SLEPT
            </span>
            <span style={{ fontSize: 13, color: C.t2, whiteSpace: "nowrap" }}>
              {handled > 0
                ? `${handled} ${handled === 1 ? "task" : "tasks"} handled for you this week`
                : "Cue is watching your inbox & calendar"}
            </span>
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
              }}
            >
              {hoursSaved > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "#E9F5EE",
                    border: "1px solid #BFE3CD",
                    borderRadius: 8,
                    padding: "5px 11px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: C.green,
                      letterSpacing: "-.3px",
                    }}
                  >
                    ≈{hoursSaved} hrs
                  </span>
                  <span style={{ fontSize: 12, color: "#3E7A55" }}>
                    saved this week
                  </span>
                </span>
              )}
              <span style={{ fontSize: 12, color: C.blueS, fontWeight: 500 }}>
                Full recap ›
              </span>
            </span>
          </button>
        </div>
      </div>

      {/* YOUR DAY — right rail. */}
      <aside
        style={{
          background: C.bg,
          borderLeft: `1px solid ${C.line}`,
          padding: "22px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 0,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              color: C.t3,
            }}
          >
            Your Day
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={() => navigate(routes.activity)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 12,
                fontWeight: 500,
                color: C.blueS,
                cursor: "pointer",
              }}
            >
              Activity ›
            </button>
            <button
              type="button"
              onClick={() => navigate(routes.meeting)}
              aria-label="Record"
              title="Record a meeting"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "none",
                background: "transparent",
                borderRadius: 6,
                padding: 0,
                cursor: "pointer",
                color: C.blueS,
              }}
            >
              <Mic width={14} height={14} />
            </button>
            <Sparkles width={13} height={13} color={C.violet} />
          </div>
        </div>

        {/* TIMELINE — upcoming schedules (real) + recently-handled work. */}
        {upcoming.length > 0 || recent.length > 0 ? (
          <div style={{ position: "relative", paddingLeft: 18 }}>
            <span
              style={{
                position: "absolute",
                left: 4,
                top: 4,
                bottom: 10,
                width: 2,
                background: C.line,
              }}
            />
            {upcoming.map((s, idx) => {
              const isNow = idx === 0;
              return (
                <div key={s.id} style={{ position: "relative", marginBottom: 18 }}>
                  <span
                    style={{
                      position: "absolute",
                      left: -18,
                      top: 3,
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: isNow ? C.blue : C.white,
                      border: `2px solid ${isNow ? C.blue : C.line2}`,
                      boxShadow: `0 0 0 3px ${C.bg}`,
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      fontFamily: mono,
                      fontSize: 10,
                      color: C.t3,
                    }}
                  >
                    {formatScheduleTime(s.nextRunAt)}
                    {isNow && (
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: 9,
                          fontWeight: 600,
                          letterSpacing: ".08em",
                          color: C.blue,
                          background: "#E6EDFC",
                          borderRadius: 5,
                          padding: "1px 5px",
                        }}
                      >
                        NEXT
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.name}
                  </div>
                  <div style={{ fontSize: 11, color: C.t2 }}>
                    {s.mode === "execute" || s.mode === "script"
                      ? "Cue will run this"
                      : "Cue will notify you"}
                  </div>
                </div>
              );
            })}
            {recent.slice(0, 5).map((r, i) => (
              <div
                key={`recent-${i}`}
                style={{ position: "relative", marginBottom: 16 }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: -18,
                    top: 3,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: C.green,
                    boxShadow: `0 0 0 3px ${C.bg}`,
                  }}
                />
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.detail}</div>
                <div style={{ fontSize: 11, color: C.t2 }}>by Cue</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: C.t2 }}>
            Your day is clear. As Cue schedules work and handles things on your
            behalf, they show up here.
          </div>
        )}

        {/* OPEN COMMITMENTS */}
        {openCommitments.length > 0 && (
          <div
            style={{
              borderTop: `1px solid ${C.line}`,
              paddingTop: 16,
              marginTop: 8,
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: C.t3,
                marginBottom: 10,
              }}
            >
              Open commitments
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {openCommitments.map((item) => (
                <div
                  key={item.id}
                  style={{
                    background: C.white,
                    border: `1px solid ${C.line}`,
                    borderRadius: 11,
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title ?? item.summary}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: C.t2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title ? item.summary : queueChipStyle(item).provenance}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

/** A slim mono stat chip linking to a detail surface. */
function StatChip({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: () => void;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: mono,
        fontSize: 11.5,
        color: accent ?? C.t2,
        background: C.white,
        border: `1px solid ${C.line}`,
        borderRadius: 8,
        padding: "6px 11px",
        cursor: "pointer",
        letterSpacing: ".01em",
      }}
    >
      {label}
      <ArrowRight size={12} color={C.t3} />
    </button>
  );
}

/**
 * "Ask Cue anything" — the command-center query bar. Reuses `useDashboardQuery`
 * (postChatMessage → fresh conversation), styled to Home's inline-hex palette
 * so it reads as one coherent surface.
 */
function HomeQueryBar({ assistantId }: { assistantId: string }) {
  const { value, setValue, submitting, error, submit } =
    useDashboardQuery(assistantId);

  return (
    <div style={{ marginTop: 18 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{
          display: "flex",
          gap: 0,
          alignItems: "center",
          background: C.white,
          border: `1px solid ${C.line2}`,
          borderRadius: 12,
          padding: "4px 4px 4px 14px",
          boxShadow: "0 1px 2px rgba(26,34,48,.04)",
        }}
      >
        <Sparkles
          width={15}
          height={15}
          color={C.violet}
          style={{ flexShrink: 0 }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask Cue anything — it’ll open a conversation with the answer…"
          style={{
            flex: 1,
            fontSize: 14,
            border: "none",
            padding: "9px 12px",
            outline: "none",
            color: C.t1,
            background: "transparent",
            minWidth: 0,
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={submitting || value.trim().length === 0}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13.5,
            fontWeight: 500,
            border: "none",
            background: C.blue,
            color: C.white,
            borderRadius: 9,
            padding: "9px 15px",
            cursor:
              submitting || value.trim().length === 0 ? "default" : "pointer",
            opacity: submitting || value.trim().length === 0 ? 0.55 : 1,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRight size={15} />
          )}
          Ask Cue
        </button>
      </form>
      {error ? (
        <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// MOBILE — design-book "Today" screen.
// ===========================================================================

/** True when a feed item's primary action needs explicit user approval. */
function isApprovalItem(item: FeedItem): boolean {
  const a = item.actions?.[0];
  if (!a) return false;
  return a.defaultMode === "needs_you" || a.allowBackground === false;
}

/** The mono eyebrow above a card title (e.g. `NEXT MOVE · DUE 10:30`). */
function moveEyebrow(item: FeedItem): string {
  if (isApprovalItem(item)) {
    return item.actions?.[0]?.label
      ? `APPROVAL NEEDED · ${item.actions[0].label.toUpperCase()}`
      : "APPROVAL NEEDED";
  }
  if (item.expiresAt) {
    const due = new Date(item.expiresAt);
    if (!Number.isNaN(due.getTime())) {
      const t = due.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `NEXT MOVE · DUE ${t.toUpperCase()}`;
    }
  }
  return "NEXT MOVE";
}

type TodayMobileProps = {
  assistantId: string;
  greeting: string;
  day: string;
  time: string;
  userName?: string;
  loading: boolean;
  moves: FeedItem[];
  actionPending: boolean;
  action: (item: FeedItem) => FeedActionShape | null;
  onRun: (item: FeedItem, mode?: RunMode) => void;
  onApprove: (item: FeedItem) => void;
  onDeny: (item: FeedItem) => void;
  onOpenConversation: (conversationId: string) => void;
  onVoice: () => void;
  onActivity: () => void;
};

/**
 * Today (mobile) — the design-book `/home` screen.
 *
 * A dark gradient canvas with a greeting header, a scrollable stack of
 * next-move + approval cards, and a composer pinned at the bottom. Three
 * first-class states: Ready (cards), Loading (shimmer skeletons), and Empty
 * ("You're all caught up"). All execution reuses the parent's wired handlers —
 * the split-button modes, approve→run, deny→dismiss, and open-as-chat.
 */
function TodayMobile({
  assistantId,
  greeting,
  day,
  time,
  userName,
  loading,
  moves,
  actionPending,
  action,
  onRun,
  onApprove,
  onDeny,
  onOpenConversation,
  onVoice,
  onActivity,
}: TodayMobileProps) {
  const initial = (userName?.trim()?.[0] ?? "C").toUpperCase();
  const isEmpty = !loading && moves.length === 0;

  return (
    <div
      className="cue-today-anim"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: `linear-gradient(180deg, ${M.ink} 0%, ${M.inkDeep} 78%, ${M.inkBottom} 100%)`,
        color: M.t1,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: MOBILE_KEYFRAMES }} />

      {/* HEADER — eyebrow + greeting + identity chip. */}
      <div style={{ flexShrink: 0, padding: "12px 20px 12px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                position: "relative",
                width: 30,
                height: 30,
                borderRadius: 9,
                background: M.markChip,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 17,
                  height: 17,
                  borderRadius: "50%",
                  boxShadow: "0 0 0 2.6px #EEF2F7 inset",
                  WebkitMask:
                    "radial-gradient(circle,transparent 56%,#000 57%)",
                  mask: "radial-gradient(circle,transparent 56%,#000 57%)",
                  transform: "rotate(40deg)",
                  animation: "cueLook 6s ease-in-out infinite",
                  position: "relative",
                  display: "block",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    borderRadius: "50%",
                    background: M.blue,
                    width: "26%",
                    height: "26%",
                    top: "8%",
                    left: "8%",
                    animation: "cueBlink 4s infinite",
                    display: "block",
                  }}
                />
              </span>
            </span>
            <span
              style={{
                fontFamily: mono,
                fontSize: 9,
                letterSpacing: ".08em",
                color: M.t2,
              }}
            >
              {day} · {time}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Persistent entry to the Activity command center — the surface
                where "Run in background" work lands. The 4-tab bar stays
                untouched; this glyph is the lasting way in on mobile. */}
            <button
              type="button"
              onClick={onActivity}
              aria-label="Activity"
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: M.surface,
                border: `1px solid ${M.line}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: M.t2,
                cursor: "pointer",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <ActivityIcon size={15} strokeWidth={2} />
            </button>
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: M.surface,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 600,
                color: M.t1,
                flexShrink: 0,
              }}
            >
              {initial}
            </span>
          </div>
        </div>
        <div
          style={{
            fontSize: 23,
            fontWeight: 600,
            letterSpacing: "-.6px",
            marginTop: 12,
          }}
        >
          {greeting}
        </div>
      </div>

      {/* SCROLL CONTENT — Ready / Loading / Empty. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "4px 20px 12px",
        }}
      >
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[128, 128, 110].map((h, i) => (
              <div
                key={i}
                style={{
                  height: h,
                  borderRadius: 18,
                  background: `linear-gradient(90deg,${M.surface} 0%,${M.surface2} 50%,${M.surface} 100%)`,
                  backgroundSize: "260px 100%",
                  animation: "cueShim 1.3s linear infinite",
                }}
              />
            ))}
          </div>
        ) : isEmpty ? (
          <TodayMobileEmpty />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {moves.map((item) =>
              isApprovalItem(item) ? (
                <ApprovalCardMobile
                  key={item.id}
                  item={item}
                  pending={actionPending}
                  onApprove={() => onApprove(item)}
                  onDeny={() => onDeny(item)}
                />
              ) : (
                <NextMoveCardMobile
                  key={item.id}
                  item={item}
                  action={action(item)}
                  pending={actionPending}
                  onRun={(mode) => onRun(item, mode)}
                  onOpen={
                    item.conversationId
                      ? () => onOpenConversation(item.conversationId!)
                      : undefined
                  }
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* COMPOSER — pinned above the app's bottom tab bar. */}
      <TodayMobileComposer assistantId={assistantId} onVoice={onVoice} />
    </div>
  );
}

/** A next-move card: eyebrow, title, summary, and the reused split-button. */
function NextMoveCardMobile({
  item,
  action,
  pending,
  onRun,
  onOpen,
}: {
  item: FeedItem;
  action: FeedActionShape | null;
  pending: boolean;
  onRun: (mode?: RunMode) => void;
  onOpen?: () => void;
}) {
  return (
    <div
      style={{
        background: M.surface,
        border: `1px solid ${M.line}`,
        borderRadius: 18,
        padding: "15px 16px",
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9,
          letterSpacing: ".07em",
          color: M.blueEyebrow,
        }}
      >
        {moveEyebrow(item)}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          marginTop: 7,
          letterSpacing: "-.2px",
          lineHeight: 1.3,
        }}
      >
        {item.title ?? item.summary}
      </div>
      {item.title && (
        <div
          style={{
            fontSize: 12.5,
            color: M.t2,
            marginTop: 4,
            lineHeight: 1.45,
          }}
        >
          {item.summary}
        </div>
      )}
      {(action || onOpen) && (
        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
          {action && (
            <MobileSplitButton
              action={action}
              pending={pending}
              onRun={onRun}
            />
          )}
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              style={{
                background: M.surface2,
                color: M.t1,
                fontSize: 13,
                fontWeight: 500,
                padding: "11px 16px",
                borderRadius: 11,
                border: "none",
                cursor: "pointer",
                minHeight: 44,
                flexShrink: 0,
              }}
            >
              Open
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The mobile split-button — primary smart action (full-width) + caret that
 * opens the override menu (Run in background / Open as chat). Same execution
 * contract as the desktop `ActionSplitButton`: `onRun("smart"|"background"|"thread")`.
 */
function MobileSplitButton({
  action,
  pending,
  onRun,
}: {
  action: FeedActionShape;
  pending: boolean;
  onRun: (mode?: RunMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "flex", flex: 1 }}>
      <div
        style={{
          display: "flex",
          flex: 1,
          borderRadius: 11,
          overflow: "hidden",
          boxShadow: "0 6px 16px -8px rgba(61,110,232,.8)",
          opacity: pending ? 0.7 : 1,
        }}
      >
        <button
          type="button"
          onClick={() => onRun("smart")}
          disabled={pending}
          style={{
            flex: 1,
            background: M.blue,
            color: M.t1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
            padding: "11px 0",
            border: "none",
            cursor: pending ? "default" : "pointer",
            minHeight: 44,
          }}
        >
          {action.label}
        </button>
        <span style={{ width: 1, background: "rgba(255,255,255,.22)" }} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={pending}
          aria-label="More run options"
          style={{
            width: 44,
            background: M.blue,
            color: M.t1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            cursor: pending ? "default" : "pointer",
            minHeight: 44,
          }}
        >
          <ChevronDown size={15} />
        </button>
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 40,
            background: M.surface2,
            border: `1px solid ${M.line2}`,
            borderRadius: 12,
            boxShadow: "0 14px 34px rgba(0,0,0,0.45)",
            overflow: "hidden",
          }}
        >
          <MobileMenuItem
            label="Run in background"
            sub={
              action.allowBackground === false
                ? "Consequential — Cue will ask first"
                : "Cue does it, posts the result"
            }
            onClick={() => {
              setOpen(false);
              onRun("background");
            }}
          />
          <MobileMenuItem
            label="Open as chat"
            sub="Work on it together"
            onClick={() => {
              setOpen(false);
              onRun("thread");
            }}
          />
        </div>
      )}
    </div>
  );
}

function MobileMenuItem({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: `1px solid ${M.line}`,
        padding: "11px 14px",
        cursor: "pointer",
        minHeight: 44,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, color: M.t1 }}>{label}</div>
      <div style={{ fontSize: 11, color: M.t3, marginTop: 1 }}>{sub}</div>
    </button>
  );
}

/** The lilac approval card — distinct style, Approve / Deny. */
function ApprovalCardMobile({
  item,
  pending,
  onApprove,
  onDeny,
}: {
  item: FeedItem;
  pending: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div
      style={{
        background: "rgba(127,119,221,.1)",
        border: "1px solid rgba(127,119,221,.4)",
        borderRadius: 18,
        padding: "15px 16px",
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9,
          letterSpacing: ".07em",
          color: M.lilacText,
        }}
      >
        {moveEyebrow(item)}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          marginTop: 7,
          letterSpacing: "-.2px",
          lineHeight: 1.3,
        }}
      >
        {item.title ?? item.summary}
      </div>
      {item.title && (
        <div style={{ fontSize: 12, color: M.t2, marginTop: 4, lineHeight: 1.45 }}>
          {item.summary}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
        <button
          type="button"
          onClick={onApprove}
          disabled={pending}
          style={{
            flex: 1,
            background: M.lilac,
            color: M.t1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
            padding: "11px 0",
            borderRadius: 11,
            border: "none",
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.7 : 1,
            minHeight: 44,
          }}
        >
          Approve
        </button>
        <button
          type="button"
          onClick={onDeny}
          disabled={pending}
          style={{
            background: M.surface2,
            color: M.t2,
            fontSize: 13,
            fontWeight: 500,
            padding: "11px 16px",
            borderRadius: 11,
            border: "none",
            cursor: pending ? "default" : "pointer",
            minHeight: 44,
            flexShrink: 0,
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** The calm empty state — aperture + "You're all caught up" + CTA. */
function TodayMobileEmpty() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        minHeight: "100%",
        padding: "0 20px 60px",
        gap: 14,
      }}
    >
      <span
        style={{
          position: "relative",
          width: 58,
          height: 58,
          borderRadius: 17,
          background: M.markChip,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 17,
            border: "1.5px solid rgba(61,110,232,.5)",
            animation: "cuePing 2.8s ease-out infinite",
          }}
        />
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            boxShadow: "0 0 0 4.5px #EEF2F7 inset",
            WebkitMask: "radial-gradient(circle,transparent 56%,#000 57%)",
            mask: "radial-gradient(circle,transparent 56%,#000 57%)",
            transform: "rotate(40deg)",
            animation: "cueLook 6s ease-in-out infinite",
            position: "relative",
            display: "block",
          }}
        >
          <span
            style={{
              position: "absolute",
              borderRadius: "50%",
              background: M.blue,
              width: "26%",
              height: "26%",
              top: "8%",
              left: "8%",
              animation: "cueBlink 4s infinite",
              display: "block",
            }}
          />
        </span>
      </span>
      <div style={{ fontSize: 17, fontWeight: 600 }}>You&apos;re all caught up</div>
      <div
        style={{
          fontSize: 13,
          color: M.t2,
          lineHeight: 1.5,
          maxWidth: 230,
        }}
      >
        Nothing needs you right now. I&apos;m watching your inbox, calendar, and
        channels.
      </div>
    </div>
  );
}

/**
 * The pinned composer. Submitting seeds a fresh conversation via the same
 * `useDashboardQuery` path the desktop "Ask Cue" bar uses; the mic routes to
 * the dedicated Voice screen (the design book's Voice tab owns hold-to-talk).
 */
function TodayMobileComposer({
  assistantId,
  onVoice,
}: {
  assistantId: string;
  onVoice: () => void;
}) {
  const { value, setValue, submitting, submit } = useDashboardQuery(assistantId);
  const canSend = value.trim().length > 0 && !submitting;

  return (
    <div style={{ flexShrink: 0, padding: "10px 16px 10px" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void submit();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: M.surface,
          border: `1px solid ${M.line2}`,
          borderRadius: 16,
          padding: "9px 10px 9px 15px",
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Message Cue…"
          style={{
            flex: 1,
            fontSize: 13,
            border: "none",
            outline: "none",
            background: "transparent",
            color: M.t1,
            minWidth: 0,
            fontFamily: "inherit",
          }}
        />
        {canSend ? (
          <button
            type="submit"
            disabled={submitting}
            aria-label="Send"
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: M.blue,
              color: M.t1,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onVoice}
            aria-label="Voice"
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: M.blue,
              color: M.t1,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Mic size={16} />
          </button>
        )}
      </form>
    </div>
  );
}
