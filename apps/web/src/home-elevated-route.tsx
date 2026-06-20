import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  CalendarClock,
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
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useDashboardQuery } from "@/domains/dashboard/use-dashboard-query";
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

export function HomeElevatedRoute() {
  const navigate = useNavigate();
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
      query: { from: monthStart, to: Date.now() },
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

  // Invoke a feed item's primary action for real. When the action carries an
  // `id`, fire the daemon action endpoint via the hook's triggerAction (which
  // optimistically marks the item acted_on and refetches). Fall back to seeding
  // chat only when an action has a prompt but no id (defensive).
  const runAction = (item: FeedItem) => {
    const a = action(item);
    if (!a) return;
    if (a.id) {
      feedQuery.triggerAction.mutate({ itemId: item.id, actionId: a.id });
    } else {
      seedChat(a.prompt);
    }
  };

  const dismissItem = (item: FeedItem) => {
    feedQuery.updateStatus.mutate({ itemId: item.id, status: "dismissed" });
  };

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
                    <button
                      type="button"
                      onClick={() => runAction(nextMove)}
                      disabled={feedQuery.triggerAction.isPending}
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        background: C.blue,
                        color: C.white,
                        border: "none",
                        borderRadius: 9,
                        padding: "10px 17px",
                        cursor: feedQuery.triggerAction.isPending
                          ? "default"
                          : "pointer",
                        opacity: feedQuery.triggerAction.isPending ? 0.7 : 1,
                      }}
                    >
                      {action(nextMove)!.label}
                    </button>
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
                          <button
                            type="button"
                            onClick={() => runAction(item)}
                            disabled={feedQuery.triggerAction.isPending}
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              border: `1px solid ${C.line2}`,
                              background: C.white,
                              borderRadius: 8,
                              padding: "8px 14px",
                              cursor: feedQuery.triggerAction.isPending
                                ? "default"
                                : "pointer",
                              flexShrink: 0,
                              color: C.t1,
                            }}
                          >
                            {a.label}
                          </button>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
