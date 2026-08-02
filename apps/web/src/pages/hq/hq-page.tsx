/**
 * HQ — the one landing surface ("Home grew up. There's one landing surface
 * now." — Cue-HQ-Build §1). The old Home retired into this deck; the rail
 * and the mobile Today tab both land here.
 *
 * One glance answers: are we moving, what moved today, what needs me?
 *  · Rings hero — one STATUS-ONLY ring per mission (✓ on track / ! needs you /
 *    ◼ blocked, derived from live rollups; % is phase 2, only with a metric)
 *    with the "N/M ON TRACK" stack and a one-line daily-brief headline.
 *  · Capture bar — the same thread-seeding mechanic Create/Home use.
 *  · Watching line + came-in strip — the connected sources Cue watches and
 *    the newest captured work items with source badges (inline Retry on a
 *    refresh failure — the error stays inside its strip).
 *  · Needs-you — "◆ YOUR NEXT MOVE" (the daemon's chief-of-staff pick) atop
 *    the awaiting_review lane, tagged by mission via the project→mission link.
 *  · Queued & scheduled — pending work items + standing schedules with their
 *    next-fire times.
 *  · Done today — compact chips with OPEN into the run conversation.
 *  · Right rail — agents at work (running items w/ live progress notes),
 *    the honest spend chip, and TIME BACK ("measuring…" until the act
 *    ledger is real — no number until it's true).
 *
 * Zero missions renders the PULSE: calm brief + next move + needs-you +
 * came-in + suggested missions + the New-mission CTA. Freshness:
 * `useActivitySync` (SSE) + 60s safety-net polls; on SSE loss the deck keeps
 * the last state under a quiet "Reconnecting to Cue…" line. Loading is the
 * headers-first shimmer skeleton. One-time switch-over orientation
 * ("Your Home is now HQ") is localStorage-gated in `hq-orientation`.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { AgentChip, StateBadge } from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { Mv3Today } from "@/mobile-v3";
import { LiveDot } from "@/components/live-dot";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import {
  actsSummaryGetOptions,
  arrivalsSummaryGetOptions,
  pendinginteractionsGetOptions,
  workitemsAutofileHealthGetOptions,
  usageTotalsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useIsMobile, useMobileLayout } from "@/hooks/use-is-mobile";
import { getBudgetConfig } from "@/lib/budget-api";
import { haptic } from "@/utils/haptics";
import { relativeTime } from "@/domains/activity/theme";
import { BuildOutTiles } from "@/pages/command-center/build-out-tiles";
import { AssessmentSignal, holdReason } from "@/pages/hq/assessment-kit";
import {
  dismissMeter,
  hasRealUsage,
  shouldShowSetupMeter,
  useSetupProgress,
  useSetupState,
  type AccountUsageSignals,
} from "@/pages/hq-onboarding/setup-state";
import type { WorkspaceMode } from "@/pages/hq-onboarding/use-setup-data";
import {
  useProjects,
  usePatchWorkItem,
  type ProjectView,
} from "@/pages/projects/use-projects";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";

import { MakeItARuleCard } from "@/domains/chat/components/make-it-a-rule-card";
import { fullPatchBody, isAutoFiled } from "@/mobile-v3/work-kit";
import {
  AutoFiledPill,
  FilingKitStyle,
  RefilePopover,
} from "@/pages/projects/filing-desktop";

import { CaptureBar } from "./capture-bar";
import {
  PausedNeedsYouRow,
  readPausedApprovals,
  type PausedApproval,
} from "./paused-approvals";
import { HqFirstRun, useHqFirstRun } from "./hq-firstrun";
import { useAgentFor } from "./hq-agent-identity";
import { DriftNudge, driftFromEvents } from "./drift-nudge";
import {
  LowConfidenceFilePrompt,
  ReassignMenu,
  ReassignTeachToast,
  type ReassignTarget,
} from "./reassign-menu";
import { CompanyPanel } from "./company-panel";
import {
  HqDeckSkeleton,
  NextMoveCard,
  ReconnectBanner,
  useDegradedState,
  useNextMove,
  useTodayStart,
  type NextMove,
} from "./hq-modules";
import { HqOrientationPanel, useHqOrientation } from "./hq-orientation";
import {
  useUnreadableArrivals,
  type UnreadableArrival,
  type UnreadableArrivalsResult,
} from "./uncomprehended";
import { UnreadableCount, UnreadableRow } from "./uncomprehended-row";
import type { WorkVerbId } from "./work-vocabulary";
import {
  C,
  HERO_GRADIENT,
  HqStyle,
  LiveBars,
  MicroLabel,
  MODE_META,
  RING_META,
  RingsHero,
  StatusRing,
  horizonLabel,
  missionHue,
  mono,
  serif,
  sourceBadge,
} from "./hq-kit";
import {
  AgentsNow,
  type AgentNow,
  DayRail,
  type DayPicture,
  type Horizon,
  LifeHorizons,
  TrustChip,
  type Unavailable,
  waitingSentence,
  type WaitingItem,
} from "./hq-k1-modules";
import {
  useDayPicture,
  useLifeHorizons,
  useWaitingOnPeople,
} from "./use-hq-k1-data";
import {
  arrivalsSentence,
  type ArrivalsSummary,
  CensusBar,
  DeliveredBlock,
  EmptyState,
  NEEDS_YOU_CAP,
  pulseSentence,
} from "./hq-deck";
import {
  counted,
  DeliverySentence,
  fromUnavailable,
  known,
  LaneCards,
  type LaneId,
  type LaneSlot,
  TIER1_IDS,
  TIER2_IDS,
  tier1,
  tier2,
  tier3,
  TierRail,
  unavailable,
} from "./hq-tiers";
import { useWatchers } from "@/mobile-v3/you/use-automations-data";
import { NewMissionModal } from "./new-mission-modal";
import {
  missionByProject,
  ringStatusFor,
  useCompanyProfile,
  useHqSchedules,
  useHqWorkItems,
  useMissionEvents,
  useAbandonedMissions,
  useMissions,
  usePatchMission,
  useRunCycle,
  type HqSchedule,
  type HqWorkItem,
  type Mission,
} from "./use-missions";

/** Current calendar-month window [start, now] in epoch ms (stable `to`). */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { from: start.getTime(), to: usageRangeNow() };
}

/** Agent-identity line for a work-item card; renders nothing when unattributable. */
function WorkItemAgent({
  assignee,
  detail,
  style,
}: {
  assignee: string | null | undefined;
  detail?: string;
  style?: React.CSSProperties;
}) {
  const agent = useAgentFor(assignee);
  if (!agent) return null;
  return (
    <div style={{ marginTop: 8, ...style }}>
      <AgentChip
        name={agent.name}
        emoji={agent.emoji}
        detail={detail}
        size="sm"
      />
    </div>
  );
}

/** The one-line brief headline — derived, never fabricated. */
function briefHeadline(
  onTrack: number,
  needsYou: number,
  blocked: number,
  total: number,
): string {
  if (total === 0) return "";
  if (blocked > 0 && needsYou > 0)
    return "Several rings are waiting on you to keep moving.";
  if (blocked === 1)
    return `${onTrack > 0 ? `${onTrack} moving — ` : ""}one ring is blocked on your call.`;
  if (blocked > 1) return `${blocked} rings are blocked on your call.`;
  if (needsYou === 1)
    return `${onTrack > 0 ? `${onTrack} moving. ` : ""}One needs your call to keep closing.`;
  if (needsYou > 1) return `${needsYou} missions need your call.`;
  return total === 1
    ? "Your mission is on track."
    : `All ${total} missions on track.`;
}

function StatusLabel({ mission }: { mission: Mission }) {
  const status = ringStatusFor(mission);
  const meta = RING_META[status];
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 10,
        color: meta.color,
        whiteSpace: "nowrap",
      }}
    >
      {status === "on_track" ? meta.label : `${meta.label} ›`}
    </span>
  );
}

/**
 * The living aperture — Cue's "awake" mark, ported from the retired elevated
 * Home (`cueLook`/`cuePing`/`cueBlink`). It gives the primary landing screen a
 * breath. It always renders inside the `hq-hero-card` slot, so `HqStyle`'s
 * `@media (prefers-reduced-motion:reduce){[data-slot^='hq-'] *{animation:none}}`
 * rule freezes it to a composed resting state (ring at rotate(40deg), pupil lit,
 * ping hidden) with no extra handling here. Tuned for the always-dark hero, so
 * the ring rides translucent white and the pupil/ping ride `--mv1-blue`.
 */
function HqApertureMark({ size = 30 }: { size?: number }) {
  const ring = Math.round(size * 0.58);
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: 9,
        background: "rgba(255,255,255,.05)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: [
            "@keyframes cueLook{0%,100%{transform:rotate(40deg)}50%{transform:rotate(64deg)}}",
            "@keyframes cueBlink{0%,90%,100%{opacity:1}94%{opacity:.15}}",
            "@keyframes cuePing{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.6);opacity:0}}",
          ].join(""),
        }}
      />
      {/* Ping halo — resting opacity 0 so the frozen (reduced-motion) state is
          simply invisible; the keyframe drives it from .6 → 0 while animating. */}
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 9,
          border:
            "1.5px solid color-mix(in srgb, var(--mv1-blue) 55%, transparent)",
          opacity: 0,
          animation: "cuePing 2.8s ease-out infinite",
        }}
      />
      <span
        style={{
          width: ring,
          height: ring,
          borderRadius: "50%",
          boxShadow: "0 0 0 3px rgba(255,255,255,.92) inset",
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
            background: "var(--mv1-blue)",
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

/** Dark hero card: concentric rings + headline + per-mission status lines. */
function RingsHeroCard({
  missions,
  doneToday,
  dayLabel,
}: {
  missions: Mission[];
  doneToday: number;
  dayLabel: string;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const rings = missions.map((m, i) => ({
    status: ringStatusFor(m),
    hue: missionHue(i),
  }));
  const onTrack = rings.filter((r) => r.status === "on_track").length;
  const needsYou = rings.filter((r) => r.status === "needs_you").length;
  const blocked = rings.filter((r) => r.status === "blocked").length;

  const openMission = (id: string) => {
    haptic.light();
    navigate(routes.hqMission(id));
  };

  return (
    <div
      data-slot="hq-hero-card"
      data-coach="hq-rings"
      style={{
        display: "flex",
        // Stack on mobile so the fixed-width rings visual sits ABOVE the copy
        // instead of cramming beside it in a non-wrapping row at 390px.
        flexDirection: isMobile ? "column" : "row",
        gap: isMobile ? 16 : 22,
        alignItems: "center",
        background: HERO_GRADIENT,
        borderRadius: 16,
        padding: isMobile ? "20px 18px" : "22px 24px",
        color: "#fff",
        marginTop: 16,
      }}
    >
      <RingsHero
        rings={rings}
        onTrack={onTrack}
        total={missions.length}
        size={isMobile ? 140 : 176}
      />
      <div
        data-slot="hq-hero-lines"
        style={{
          flex: 1,
          minWidth: 0,
          width: isMobile ? "100%" : undefined,
          textAlign: isMobile ? "center" : "left",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: isMobile ? "center" : "flex-start",
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,.55)",
          }}
        >
          {/* The living aperture — Cue is awake. */}
          <HqApertureMark size={26} />
          <span>
            {dayLabel}
            {doneToday > 0 ? ` · ${doneToday} handled today` : ""}
          </span>
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: isMobile ? 20 : 24,
            lineHeight: 1.15,
            marginTop: 8,
          }}
        >
          {briefHeadline(onTrack, needsYou, blocked, missions.length)}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 13,
          }}
        >
          {missions.slice(0, 6).map((m, i) => {
            const status = ringStatusFor(m);
            return (
              <div
                key={m.id}
                className="cue-pressable"
                role="link"
                tabIndex={0}
                onClick={() => openMission(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openMission(m.id);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 12.5,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background:
                      status === "on_track"
                        ? missionHue(i)
                        : RING_META[status].color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.title}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: mono,
                    fontSize: 10.5,
                    color:
                      status === "on_track"
                        ? "rgba(255,255,255,.6)"
                        : RING_META[status].color,
                    whiteSpace: "nowrap",
                    ...(status !== "on_track"
                      ? {
                          borderBottom: `1px dotted ${RING_META[status].color}`,
                        }
                      : {}),
                  }}
                >
                  {status === "on_track"
                    ? "on track"
                    : status === "needs_you"
                      ? "needs you · open ›"
                      : "blocked · decide ›"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One "Needs you" card — the awaiting_review item, tagged by mission. */
function NeedsYouCard({
  item,
  mission,
}: {
  item: HqWorkItem;
  mission: Mission | null;
}) {
  const navigate = useNavigate();
  const openReview = () => {
    haptic.light();
    if (item.lastRunConversationId) {
      navigate(routes.conversation(item.lastRunConversationId));
    } else {
      navigate(routes.allWork);
    }
  };
  return (
    <div
      className="cue-pressable"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: "12px 14px",
        background: C.surface,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title truncates; the state badge is a non-shrinking sibling so it
            never gets clipped by the ellipsis on narrow viewports. */}
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
              fontSize: 13.5,
              fontWeight: 500,
              color: C.ink,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {item.title}
          </span>
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <StateBadge state="review" size="sm" />
          </span>
        </div>
        <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>
          {mission ? (
            <b style={{ fontWeight: 600 }}>{mission.title}</b>
          ) : (
            <span>Unfiled</span>
          )}
          {" · "}Cue finished this — it waits for your yes
          {item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ""}.
        </div>
        <WorkItemAgent assignee={item.assignee} style={{ marginTop: 6 }} />
      </div>
      <button type="button" onClick={openReview} style={reviewBtn}>
        Review
      </button>
      {mission ? (
        <button
          type="button"
          onClick={() => {
            haptic.light();
            navigate(routes.hqMission(mission.id));
          }}
          style={openMissionBtn}
        >
          Open mission ›
        </button>
      ) : null}
    </div>
  );
}

const reviewBtn: React.CSSProperties = {
  fontSize: 11.5,
  background: C.blue,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "7px 13px",
  cursor: "pointer",
  flexShrink: 0,
};

const openMissionBtn: React.CSSProperties = {
  fontSize: 11.5,
  background: C.sunken,
  color: C.t2,
  border: "none",
  borderRadius: 8,
  padding: "7px 13px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

/** Mission list rows — every ring, as a list (the map is a delight layer). */
function MissionList({ missions }: { missions: Mission[] }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {missions.map((m) => {
        const status = ringStatusFor(m);
        const horizon = horizonLabel(m.horizon);
        const meta = [
          horizon,
          m.rollup.projects.length > 0
            ? `${m.rollup.projects.length} initiative${m.rollup.projects.length === 1 ? "" : "s"}`
            : null,
          m.rollup.counts.running > 0
            ? `${m.rollup.counts.running} running`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={m.id}
            className="cue-pressable"
            role="button"
            tabIndex={0}
            onClick={() => {
              haptic.light();
              navigate(routes.hqMission(m.id));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate(routes.hqMission(m.id));
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background:
                status === "needs_you" || status === "blocked"
                  ? `color-mix(in srgb, ${RING_META[status].color} 7%, ${C.surface})`
                  : C.surface,
              border: `1px solid ${
                status === "on_track"
                  ? C.line
                  : `color-mix(in srgb, ${RING_META[status].color} 38%, ${C.line})`
              }`,
              borderRadius: 12,
              padding: "10px 13px",
              cursor: "pointer",
            }}
          >
            <StatusRing status={status} size={34} stroke={4} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: C.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {m.title}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: status === "on_track" ? C.t3 : RING_META[status].color,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {status === "blocked"
                  ? `blocked · ${meta || "open to unblock"}`
                  : meta || m.outcome}
              </div>
            </div>
            <StatusLabel mission={m} />
          </div>
        );
      })}
    </div>
  );
}

/** Static phase-1 mission suggestions for the pulse (zero-mission) state. */
const SUGGESTED_MISSIONS: Array<{
  glyph: string;
  title: string;
  blurb: string;
}> = [
  {
    glyph: "💰",
    title: "Raise the next round",
    blurb:
      "Deck, target list, warm intros, data room — Cue runs the ring, you approve anything that sends.",
  },
  {
    glyph: "🚀",
    title: "Ship the next release",
    blurb:
      "Cue plans the sprint work, drafts the launch copy, and keeps the ring moving between check-ins.",
  },
  {
    glyph: "📈",
    title: "Grow revenue",
    blurb:
      "Pipeline research, outreach drafts, and follow-ups — publishing always waits for your yes.",
  },
];

/**
 * First line of a provider error, capped. Watcher failures can be an entire
 * HTML 404 page — Gmail returns one — and pasting that into a card tells the
 * user nothing while destroying the layout.
 */
function firstLine(raw: string, max = 120): string {
  const line = (raw.split("\n")[0] ?? "").trim();
  if (line.length === 0) return "no detail reported";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** "4 rhythms run on their own — the next fires in 2h." */
function rhythmsSentence(schedules: HqSchedule[]): string {
  if (schedules.length === 0) return "Nothing runs on a schedule yet.";
  const next = relativeTime(schedules[0]!.nextRunAt);
  const many = schedules.length === 1 ? "rhythm runs" : "rhythms run";
  return `${schedules.length} ${many} on their own${next ? ` — the next fires ${next}` : ""}.`;
}

/** "Cue is doing 2 things · 128 acts, 0 reversed." */
function inMotionSentence(running: HqWorkItem[], queued: HqWorkItem[]): string {
  if (running.length === 0 && queued.length === 0)
    return "Nothing is running and nothing is queued.";
  if (running.length === 0)
    return `Nothing is running — ${queued.length} ${queued.length === 1 ? "item is" : "items are"} queued.`;
  return `Cue is working on ${running.length} ${running.length === 1 ? "thing" : "things"}.`;
}

/** Tier 1 · Needs you — a card at zero, because "nothing needs you" earns it. */
function NeedsYouLane({
  assistantId,
  move,
  items,
  glanceCount,
  extraApprovalItems,
  missionsByProjectId,
}: {
  assistantId: string;
  move: NextMove;
  items: HqWorkItem[];
  glanceCount: number;
  /** Pending interactions beyond the one the next-move card already carries. */
  /** Paused runs beyond the one the next-move card carries. */
  extraApprovalItems: PausedApproval[];
  missionsByProjectId: Map<string, Mission>;
}) {
  return (
    <section data-slot="hq-needs-you">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel color={glanceCount > 0 ? C.danger : C.t3}>
          ‖ Needs you ·{" "}
          {glanceCount > NEEDS_YOU_CAP
            ? `${NEEDS_YOU_CAP} of ${glanceCount}`
            : glanceCount}
        </MicroLabel>
        {glanceCount > NEEDS_YOU_CAP ? (
          <Link
            to={routes.reviewQueue}
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: C.t3,
              textDecoration: "none",
              fontFamily: mono,
            }}
          >
            Triage the rest ›
          </Link>
        ) : null}
      </div>
      {glanceCount === 0 ? (
        /* Zero is a real number, not a hidden absence. Cue says it in its own
           voice rather than rendering "0 items" — and the lane keeps its card,
           because a calm deck and a broken query must not look alike. */
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 9,
            marginTop: 10,
            fontSize: 13.5,
            color: C.t2,
          }}
        >
          <span aria-hidden style={{ color: C.green }}>
            ✓
          </span>
          <span>Nothing needs you. Go do something else.</span>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            marginTop: 12,
          }}
        >
          {/* ◆ YOUR NEXT MOVE — always the first card in the lane. */}
          <NextMoveCard assistantId={assistantId} move={move} />
          {/* Paused runs sort above everything: unlike a draft awaiting review,
              NOTHING proceeds until these are answered. */}
          {extraApprovalItems
            .slice(0, Math.max(0, NEEDS_YOU_CAP - (move.hasMove ? 1 : 0)))
            .map((approval) => (
              <PausedNeedsYouRow
                key={approval.requestId}
                assistantId={assistantId}
                approval={approval}
              />
            ))}
          {items
            .slice(
              0,
              Math.max(
                0,
                NEEDS_YOU_CAP -
                  (move.hasMove ? 1 : 0) -
                  extraApprovalItems.length,
              ),
            )
            .map((item) => (
              <NeedsYouCard
                key={item.id}
                item={item}
                mission={
                  item.projectId
                    ? (missionsByProjectId.get(item.projectId) ?? null)
                    : null
                }
              />
            ))}
        </div>
      )}
    </section>
  );
}

/**
 * Tier 1 · Missions — the rings when there are any, the offer when there
 * aren't.
 *
 * The zero state used to be three full suggestion cards in a second column.
 * They are one line each now: a suggestion is an offer, and an offer does not
 * need a card to be legible.
 */
function MissionsLane({
  assistantId,
  missions,
  doneToday,
  dayLabel,
  onNewMission,
  onSuggest,
}: {
  assistantId: string;
  missions: Mission[];
  doneToday: number;
  dayLabel: string;
  onNewMission: () => void;
  onSuggest: (title: string) => void;
}) {
  if (missions.length === 0) {
    return (
      <section data-slot="hq-missions">
        <MicroLabel>◎ Missions · 0</MicroLabel>
        <div
          style={{
            fontSize: 13,
            color: C.t2,
            marginTop: 10,
            lineHeight: 1.5,
          }}
        >
          No missions yet — and that&rsquo;s fine. Cue still catches what comes
          in. Three it could take on:
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            marginTop: 10,
          }}
        >
          {SUGGESTED_MISSIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                onSuggest(s.title);
              }}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                textAlign: "left",
                background: "none",
                border: "none",
                padding: "7px 0",
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
                color: C.ink,
              }}
            >
              <span aria-hidden style={{ fontSize: 13 }}>
                {s.glyph}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{s.title}</span>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.blueText,
                  whiteSpace: "nowrap",
                }}
              >
                Start ›
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onNewMission}
          style={{
            border: "none",
            background: "none",
            padding: "8px 0 0",
            fontSize: 12.5,
            color: C.blueText,
            cursor: "pointer",
          }}
        >
          Or name your own ›
        </button>
      </section>
    );
  }
  return (
    <section data-slot="hq-missions">
      <RingsHeroCard
        missions={missions}
        doneToday={doneToday}
        dayLabel={dayLabel}
      />
      {/* §6 · Drifting — the honest nudge on any mission that's idling. It
          belongs INSIDE this lane: a drift is a fact about a mission, and
          floating it as its own deck card was chrome. */}
      <MissionDriftNudges assistantId={assistantId} missions={missions} />
      <MicroLabel style={{ margin: "20px 0 10px" }}>
        Missions · {missions.length}
      </MicroLabel>
      <MissionList missions={missions} />
    </section>
  );
}

/** Tier 2 · In motion — running work, with the staff's receipts underneath. */
function InMotionLane({
  running,
  queued,
  agents,
  missionsByProjectId,
}: {
  running: HqWorkItem[];
  queued: HqWorkItem[];
  agents: AgentNow[];
  missionsByProjectId: Map<string, Mission>;
}) {
  return (
    <section data-slot="hq-in-motion" data-coach="hq-lanes">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel>◉ In motion · {running.length + queued.length}</MicroLabel>
        <Link
          to={routes.allWork}
          style={{
            marginLeft: "auto",
            fontFamily: mono,
            fontSize: 11.5,
            color: C.t3,
            textDecoration: "none",
          }}
        >
          Open the ledger ›
        </Link>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 12,
        }}
      >
        {running.slice(0, 3).map((item) => {
          const mission = item.projectId
            ? (missionsByProjectId.get(item.projectId) ?? null)
            : null;
          return (
            <div
              key={item.id}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <LiveBars color={C.blue} />
              <span
                style={{
                  fontSize: 13,
                  color: C.t1,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
                {mission ? (
                  <span style={{ color: C.t3 }}> · {mission.title}</span>
                ) : null}
              </span>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.t3,
                  whiteSpace: "nowrap",
                }}
              >
                {item.lastProgressNote
                  ? item.lastProgressNote.slice(0, 40)
                  : (relativeTime(item.updatedAt) ?? "")}
              </span>
            </div>
          );
        })}
        {queued.length > 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--hq-muted)" }}>
            <span aria-hidden style={{ marginRight: 8 }}>
              ○
            </span>
            {queued.length} queued behind {running.length === 1 ? "it" : "them"}
            .
          </div>
        ) : null}
      </div>
      {/* The staff, with receipts. "128 acts · 0 reversed" is what makes
          autonomy credible, and both halves are queryable today. */}
      <div data-coach="hq-agents">
        <AgentsNow agents={agents} />
      </div>
    </section>
  );
}

/**
 * The HQ deck — ONE surface, whether the account has missions or not.
 *
 * There used to be two decks here: a `PulseLayout` for zero-mission accounts
 * carrying every K1 module, and a separate mission layout carrying a board, a
 * came-in strip, a schedules block and a spend chip. Two HQs meant a reorder had
 * to be done twice and the tiers could only be true on one of them. Missions
 * are now a lane like any other — a Tier-1 card that shows rings or an offer.
 *
 * Reading order is design's Q2 answer, and it is load-bearing:
 *
 *   delivery sentence · composer · needs-you · delivered · missions ·
 *   the Tier-2 cards that earned one · the Tier-3 rail · the census
 *
 * Invariant 1 says lead with delivered, not needed. The exception it names is
 * exactly this screen: needs-you leads the CARDS because the delivery sentence
 * one line above has already given the receipts. When the landing surface ships,
 * that sentence lifts out and becomes the door, and no further reorder is owed.
 */
function HqDeck({
  assistantId,
  move,
  needsYou,
  needsYouError,
  extraApprovalItems,
  cameIn,
  running,
  done,
  doneError,
  missions,
  missionsError,
  projects,
  schedules,
  schedulesError,
  missionsByProjectId,
  userName,
  dayLabel,
  trust,
  day,
  dayUnavailable,
  lifeGroups,
  lifeUnavailable,
  agentsNow,
  waiting,
  waitingUnavailable,
  established,
  moveIsExtraToNeedsYou,
  heartbeatRuns,
  watchingCount,
  failingWatchers,
  autoFileDegraded,
  arrivals,
  arrivalsError,
  onNewMission,
  onSuggest,
}: {
  assistantId: string;
  move: NextMove;
  needsYou: HqWorkItem[];
  needsYouError: boolean;
  extraApprovalItems: PausedApproval[];
  cameIn: HqWorkItem[];
  running: HqWorkItem[];
  done: HqWorkItem[];
  doneError: boolean;
  missions: Mission[];
  missionsError: boolean;
  projects: ProjectView[];
  schedules: HqSchedule[];
  schedulesError: boolean;
  missionsByProjectId: Map<string, Mission>;
  userName: string | null;
  dayLabel: string;
  /**
   * Whether the next-move card represents work that is NOT already one of the
   * `needsYou` rows, and so genuinely adds one to the glance count.
   */
  moveIsExtraToNeedsYou: boolean;
  /** Lifetime heartbeat runs — real evidence Cue has been working. */
  heartbeatRuns: number | null;
  /** Sources currently observed AND healthy. Existing != working. */
  watchingCount: number;
  /** Provisioned watchers that are erroring — named, never hidden. */
  failingWatchers: { id: string; name: string; lastError: string }[];
  /**
   * The daemon's own sentence for why filing has stalled, or null when it is
   * healthy. A string rather than a boolean on purpose: the deck must never
   * author its own explanation for a backend condition it cannot see.
   */
  autoFileDegraded: string | null;
  /** What arrived on its own, and what Cue did with it. */
  arrivals: ArrivalsSummary;
  arrivalsError: boolean;
  /** Autonomy tier + spend, shown beside the greeting (§23 step 7). */
  trust: {
    mode: WorkspaceMode;
    spentCents: number | null;
    capCents: number | null;
  };
  /**
   * Live evidence that this account already has work in it. The only thing it
   * gates is the first-run explainer, which must never teach the loop to
   * someone who has been running it for weeks — see `useHqFirstRun`.
   */
  established: boolean;
  /** Today's calendar picture, or why there isn't one. */
  day: DayPicture | null;
  dayUnavailable?: Unavailable;
  /** Life items grouped by horizon, or why there aren't any. */
  lifeGroups: { horizon: Horizon; titles: string[] }[];
  lifeUnavailable?: Unavailable;
  /** The staff, with receipts. */
  agentsNow: AgentNow[];
  /** Waiting on people, four states (§7). */
  waiting: WaitingItem[];
  waitingUnavailable?: Unavailable;
  onNewMission: () => void;
  onSuggest: (title: string) => void;
}) {
  const firstRun = useHqFirstRun({ established });
  const isMobile = useIsMobile();
  // Stamped once per mount, like `dayLabel`. Reading the clock during render is
  // impure — the now-marker would move on every unrelated re-render.
  const [nowMs] = useState(() => Date.now());
  const [hour] = useState(() => new Date().getHours());

  // `needsYou` has already had the next-move item filtered out when the move
  // WAS one of the review rows, so adding 1 unconditionally double-counted a
  // move that is neither a review row nor an approval — a queued work item.
  // That is what made this headline read 6 while the sidebar badge, reading the
  // same two queries, read 5.
  const glanceCount = needsYou.length + (moveIsExtraToNeedsYou ? 1 : 0);
  const unfiled = useMemo(() => cameIn.filter((i) => !i.projectId), [cameIn]);

  /**
   * Everything the deck already holds. Handed to the un-comprehended scan
   * purely so it can skip a round-trip per item it can already see; it is an
   * optimisation and nothing more, because an un-comprehended item is excluded
   * from every one of these list reads and so can never appear here.
   */
  const knownWorkItemIds = useMemo(
    () =>
      new Set(
        [...needsYou, ...cameIn, ...running, ...done].map((item) => item.id),
      ),
    [needsYou, cameIn, running, done],
  );
  // Hoisted out of the strip because the strip's own render is gated on the
  // FILING lane having rows. An arrival Cue could not read is not a filing
  // problem and must not be hidden behind one.
  const unreadable = useUnreadableArrivals(assistantId, { knownWorkItemIds });

  // ── Lane states ────────────────────────────────────────────────────────────
  // Each is EITHER a queried payload or a sentence saying we could not ask. A
  // lane never gets to be an empty array standing in for "we didn't check".
  const needsYouState = needsYouError
    ? unavailable<{ move: NextMove; items: HqWorkItem[]; glanceCount: number }>(
        "Cue couldn't read your review queue just now.",
      )
    : known({ move, items: needsYou, glanceCount });
  const deliveredState = doneError
    ? unavailable<HqWorkItem[]>("Cue couldn't read what it finished today.")
    : known(done);
  const missionsState = missionsError
    ? unavailable<Mission[]>("Cue couldn't load your missions just now.")
    : known(missions);
  const inMotionState = known({ running, queued: cameIn });
  const dayState = fromUnavailable(day, dayUnavailable);
  const lifeState = fromUnavailable(lifeGroups, lifeUnavailable);
  // The batch offer has no data behind it yet. It states that rather than
  // vanishing — a lane we have not built and a lane with nothing in it are
  // different sentences.
  const batchState = unavailable<null>(
    "Cue isn't grouping arrivals into batches yet — when it does it will offer, never merge on its own.",
  );
  const correctionState = known(unfiled);
  const arrivalsState = arrivalsError
    ? unavailable<ArrivalsSummary>("Cue couldn't read what arrived today.")
    : known(arrivals);
  const waitingState = fromUnavailable(waiting, waitingUnavailable);
  const rhythmsState = schedulesError
    ? unavailable<HqSchedule[]>("Cue couldn't read your schedules just now.")
    : known(schedules);
  const pulseState = known({
    sources: watchingCount,
    checks: heartbeatRuns,
  });

  /**
   * Every lane, in one exhaustive record.
   *
   * TypeScript will not let this object literal omit a `LaneId`, and no builder
   * can return "nothing" — so "a lane went silently absent" is a compile error
   * rather than a bug you find in production three weeks later.
   */
  const lanes: Record<LaneId, LaneSlot> = {
    needs_you: tier1("needs_you", needsYouState, (p) => (
      <NeedsYouLane
        assistantId={assistantId}
        move={p.move}
        items={p.items}
        glanceCount={p.glanceCount}
        extraApprovalItems={extraApprovalItems}
        missionsByProjectId={missionsByProjectId}
      />
    )),
    delivered: tier1("delivered", deliveredState, (items) => (
      <DeliveredBlock items={items} />
    )),
    missions: tier1("missions", missionsState, (ms) => (
      <MissionsLane
        assistantId={assistantId}
        missions={ms}
        doneToday={done.length}
        dayLabel={dayLabel}
        onNewMission={onNewMission}
        onSuggest={onSuggest}
      />
    )),
    in_motion: tier2(
      "in_motion",
      inMotionState,
      (p) =>
        p.running.length === 0 ? null : (
          <InMotionLane
            running={p.running}
            queued={p.queued}
            agents={agentsNow}
            missionsByProjectId={missionsByProjectId}
          />
        ),
      (p) => ({ sentence: inMotionSentence(p.running, p.queued) }),
    ),
    day: tier2(
      "day",
      dayState,
      (d) =>
        d == null || d.commitments.length === 0 ? null : (
          <DayRail day={d} nowMs={nowMs} />
        ),
      (d) => ({
        sentence:
          d == null
            ? "Cue is still reading your calendar."
            : `Nothing is booked today — ${Math.floor(d.unbookedMinutes / 60)}h free.`,
      }),
    ),
    life: tier2(
      "life",
      lifeState,
      (groups) =>
        groups.length === 0 ? null : <LifeHorizons groups={groups} />,
      () => ({ sentence: "Nothing personal is on your list." }),
    ),
    batch: tier2(
      "batch",
      batchState,
      () => null,
      () => ({ sentence: "Cue isn't batching anything." }),
    ),
    correction: tier2(
      "correction",
      correctionState,
      (items) =>
        items.length === 0 && unreadable.count === 0 ? null : (
          <CameInReassignStrip
            items={items}
            projects={projects}
            missionsByProjectId={missionsByProjectId}
            assistantId={assistantId}
            unreadable={unreadable}
            onNewMission={onNewMission}
          />
        ),
      () => ({ sentence: "Everything that arrived found a home." }),
    ),
    arrivals: tier3("arrivals", arrivalsState, (a) => ({
      sentence: arrivalsSentence(a),
      tone: a.kept > 0 ? "attention" : "muted",
    })),
    waiting: tier3("waiting", waitingState, (items) => ({
      sentence: waitingSentence(items),
      tone: items.some((w) => w.state === "going_cold") ? "attention" : "muted",
    })),
    rhythms: tier3("rhythms", rhythmsState, (ss) => ({
      sentence: rhythmsSentence(ss),
    })),
    pulse: tier3("pulse", pulseState, (p) => ({
      sentence: pulseSentence(p.sources, p.checks, null),
    })),
  };

  return (
    <div data-slot="hq-stream">
      {/*
        The day and the greeting are ONE row.

        They were two, and the greeting is computed from the same clock the
        stamp above it prints — "SUNDAY 21:17" then "Good evening." is the time
        of day rendered twice, one line apart, which is §4's "is this already
        visible somewhere else on this screen?" at the tightest possible range.
        Neither fact is dropped; they stop taking a line each.
      */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          data-slot="hq-title"
          style={{
            fontFamily: serif,
            fontSize: isMobile ? 26 : 34,
            lineHeight: 1.08,
            color: C.ink,
          }}
        >
          {userName ? `Good ${dayPart()}, ${userName}.` : `Good ${dayPart()}.`}
        </div>
        <MicroLabel
          color={C.t3}
          style={{ fontSize: 11, letterSpacing: "0.14em" }}
        >
          {dayLabel}
        </MicroLabel>
      </div>

      {/*
        0 · THE DELIVERY SENTENCE — "While you slept: 3 done, 2 need you."

        One line, no new surface, no new data: it reads the two lanes the deck
        already queried, which is why both counts are `Queried` and a lane we
        could not ask contributes nothing rather than a zero. It is a strict
        subset of the landing screen, so when that ships the sentence lifts out
        of HQ and becomes the door.
      */}
      <div style={{ marginTop: 10 }}>
        <DeliverySentence
          delivered={counted(deliveredState, (items) => items.length)}
          needsYou={counted(needsYouState, (p) => p.glanceCount)}
          hour={hour}
        />
      </div>

      {/* Trust chip. Trust lives where the work is, not in Settings (§23 step
          7), and the chip is the contextual door to Guardrails (§3). The lens
          switch that shared this row is gone — see the note in hq-k1-modules. */}
      <div style={{ marginTop: 14 }}>
        <TrustChip
          mode={trust.mode}
          spentCents={trust.spentCents}
          capCents={trust.capCents}
        />
      </div>

      {/* 1 · THE COMPOSER — fixed furniture. It has been dropped twice; the
          handoff makes it an invariant. Never remove it. */}
      <div style={{ marginTop: 18, maxWidth: 640 }} data-coach="hq-capture">
        <CaptureBar
          placeholder={
            'Tell Cue what you need — or "take the Halo pricing" to hand it straight over'
          }
          autoFilesChip={false}
        />
      </div>

      {/* First-run — three cards that teach the loop, once. */}
      {firstRun.show ? <HqFirstRun onDismiss={firstRun.dismiss} /> : null}

      {/*
        The screen-OWNING empty states (§14). These keep their cards: a filer
        that has silently stopped, a watcher that cannot be reached, and an
        inbox nothing is watching are not routine emptiness — they are the
        product being less than the user believes it is, and a grey line would
        under-state them. Everything routine became a Tier-3 line instead.
      */}
      {autoFileDegraded ? (
        <EmptyState
          kind="broken"
          title="Cue has stopped filing"
          body={autoFileDegraded}
          action={
            <Link
              to={routes.allWork}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: C.amberText,
                textDecoration: "none",
              }}
            >
              See the unfiled work ›
            </Link>
          }
        />
      ) : null}

      {failingWatchers.length > 0 ? (
        <EmptyState
          kind="broken"
          title={`${failingWatchers.length === 1 ? failingWatchers[0]!.name : `${failingWatchers.length} sources`} can't be reached`}
          body={
            failingWatchers.length === 1
              ? `Cue set up watching but the last check failed: ${firstLine(failingWatchers[0]!.lastError)}`
              : `Cue set up watching but the last checks failed. First error: ${firstLine(failingWatchers[0]!.lastError)}`
          }
          action={
            <Link
              to={routes.automations}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: C.amberText,
                textDecoration: "none",
              }}
            >
              See what Cue watches ›
            </Link>
          }
        />
      ) : null}

      {watchingCount === 0 && failingWatchers.length === 0 ? (
        <EmptyState
          kind="not_set_up"
          title="Cue can see your inbox — but it isn't watching it"
          body="Right now Cue works when you ask. Turn on watching and things start arriving on their own — and your missions fill themselves in."
          action={
            <Link
              to={routes.connectors}
              className="cue-pressable"
              style={{
                display: "inline-block",
                fontSize: 12.5,
                fontWeight: 600,
                background: C.blue,
                color: "#fff",
                borderRadius: 9,
                padding: "9px 15px",
                textDecoration: "none",
              }}
            >
              Start watching
            </Link>
          }
        />
      ) : null}

      {/* 2 · TIER 1 — always a card: needs-you, delivered, missions. */}
      <div style={{ marginTop: 30 }}>
        <LaneCards lanes={lanes} ids={TIER1_IDS} gap={30} />
      </div>

      {/* 3 · TIER 2 — a card only where there was something to put in it.
          Everything else demoted into the rail below, never to nothing. */}
      <div style={{ marginTop: 30 }}>
        <LaneCards lanes={lanes} ids={TIER2_IDS} gap={26} />
      </div>

      {/* 4 · TIER 3 — one grey line each, always present. */}
      <TierRail lanes={lanes} />

      {/* 5 · CENSUS — the honest count and the door to the ledger. */}
      <CensusBar
        segments={[
          { label: "need you", value: needsYou.length },
          // `keep` because in-motion no longer takes a Tier-3 line — this
          // segment is what answers "is anything running?". Without it, an idle
          // account and a busy one look identical on the whole screen.
          { label: "Cue is doing", value: running.length, keep: true },
          { label: "waiting", value: cameIn.length },
          { label: "done today", value: done.length },
        ]}
      />
    </div>
  );
}

function dayPart(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/**
 * SETTING UP · N OF M — the slim, non-shaming first-run meter. Sits at the top
 * of the deck (and the pulse) until every tracked step is done, or until the
 * user dismisses it ("this never nags"). Mono microlabel + a subtle progress
 * rail; the × calls `dismissMeter` (forever). Hidden when done===total.
 *
 * `usage` is the honesty gate: progress lives in localStorage only, so an
 * account that never ran `/assistant/hq/setup` (or reached HQ from another
 * browser / the desktop shell's own origin) reads a pristine "0 OF 6" however
 * long it has been running missions. When there's no local record of setup
 * being started AND the account plainly has real work in it, the meter stays
 * off rather than nagging an established user to "choose what Cue is for".
 */
function SetupMeter({ usage }: { usage: AccountUsageSignals }) {
  const { done, total, nextStep, nextLabel } = useSetupProgress();
  // Subscribed read (not the raw snapshot) so dismissing re-renders the meter.
  const state = useSetupState();
  if (
    !shouldShowSetupMeter(
      state,
      { doneCount: done, total, next: nextStep },
      usage,
    )
  ) {
    return null;
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        background: C.blueW,
        border: `1px solid color-mix(in srgb, ${C.blue} 22%, transparent)`,
        borderRadius: 12,
        padding: "10px 15px",
        marginBottom: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.06em",
              color: C.blueS,
              whiteSpace: "nowrap",
            }}
          >
            SETTING UP · {done} OF {total}
          </span>
          {nextLabel ? (
            <span
              style={{
                fontSize: 12,
                color: C.t2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nextLabel}
            </span>
          ) : null}
        </div>
        <div
          style={{
            height: 5,
            borderRadius: 3,
            background: C.surface,
            marginTop: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: C.blue,
              borderRadius: 3,
            }}
          />
        </div>
      </div>
      <Link
        to={routes.hqSetup}
        style={{
          fontSize: 11.5,
          color: C.blueS,
          fontWeight: 500,
          whiteSpace: "nowrap",
          textDecoration: "none",
        }}
      >
        Finish setup ›
      </Link>
      <button
        type="button"
        aria-label="Dismiss setup meter"
        title="Dismiss — this never nags"
        onClick={dismissMeter}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          color: C.t3,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Project list → the reassign menu's target chips (id/title/emoji). */
function reassignTargets(
  projects: Array<{ id: string; title: string; emoji: string | null }>,
): ReassignTarget[] {
  return projects.map((p) => ({
    id: p.id,
    title: p.title,
    emoji: p.emoji,
  }));
}

/** Full-record PATCH body for a work-item move (mirrors the task-drawer path). */
/**
 * Pull the sender + channel off a captured item so the "Make it a rule" offer
 * can name a real scope. `sourceContext` is the JSON snapshot commitment-capture
 * stamps at ingress; anything missing or malformed just means no offer — we
 * never guess a sender.
 */
function senderContext(item: HqWorkItem): {
  sender: string | null;
  channel: string | null;
} {
  let sender: string | null = null;
  try {
    const raw = item.sourceContext ? JSON.parse(item.sourceContext) : null;
    const s = (raw as { sender?: unknown } | null)?.sender;
    if (typeof s === "string" && s.trim()) sender = s.trim();
  } catch {
    // Malformed snapshot — fall back to channel-only scope.
  }
  return { sender, channel: item.sourceType ?? null };
}

function moveBody(item: HqWorkItem, projectId: string | null) {
  let labels: string[] = [];
  if (item.labels) {
    try {
      const parsed = JSON.parse(item.labels) as unknown;
      if (Array.isArray(parsed))
        labels = parsed.filter((l): l is string => typeof l === "string");
    } catch {
      // ignore malformed labels
    }
  }
  return {
    title: item.title,
    notes: item.notes ?? "",
    status: item.status,
    priorityTier: item.priorityTier,
    sortIndex: item.sortIndex ?? 0,
    projectId,
    dueAt: item.dueAt,
    labels,
    assignee: item.assignee ?? "cue",
    context: item.context ?? null,
  };
}

/**
 * How many `⌗` rows the strip will draw. The rest live in the header count.
 * Same reasoning as the needs-you cap: the deck never grows.
 */
const UNREADABLE_ROW_CAP = 2;

/**
 * One `⌗` row, wired to the verbs this app can honestly perform on it.
 *
 * `File` is offered and it does move the item — but note what it does NOT do:
 * filing an un-comprehended arrival does not return it to the task list.
 * Comprehension is a separate verdict and filing does not re-run it, so the row
 * stays `⌗` under its new project. That is the truthful behaviour and the
 * reason `File` is not dressed up as a resolution.
 *
 * `Archive` and `Done elsewhere` DO retire the row, because the scan drops
 * settled items. `approve` (nothing was proposed), `later` and `hand_off` (no
 * mutation exists for either anywhere in this app) are omitted rather than
 * stubbed — {@link WorkVerbBar} renders only what it is handed, precisely so an
 * unimplemented verb cannot teach a shortcut that does nothing.
 */
function UnreadableCameInRow({
  entry,
  assistantId,
  targets,
  onNewMission,
}: {
  entry: UnreadableArrival;
  assistantId: string;
  targets: ReassignTarget[];
  onNewMission: () => void;
}) {
  const patch = usePatchWorkItem(assistantId);
  const [busyVerb, setBusyVerb] = useState<WorkVerbId | null>(null);
  const [filing, setFiling] = useState(false);

  const apply = (verb: WorkVerbId, body: ReturnType<typeof fullPatchBody>) => {
    setBusyVerb(verb);
    patch.mutate(
      { path: { assistant_id: assistantId, id: entry.item.id }, body },
      {
        onSettled: () => {
          setBusyVerb(null);
          setFiling(false);
        },
      },
    );
  };

  return (
    <div>
      <UnreadableRow
        item={entry}
        busyVerb={busyVerb}
        verbs={{
          file: () => setFiling((v) => !v),
          archive: () =>
            apply("archive", fullPatchBody(entry.item, { status: "archived" })),
          done_elsewhere: () =>
            apply(
              "done_elsewhere",
              fullPatchBody(entry.item, { status: "done" }),
            ),
        }}
      />
      {filing ? (
        <div style={{ marginTop: 8, marginLeft: 28 }}>
          <ReassignMenu
            targets={targets}
            currentId={entry.item.projectId}
            busy={patch.isPending}
            onPick={(projectId) =>
              apply("file", fullPatchBody(entry.item, { projectId }))
            }
            onNew={onNewMission}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * §4 · The came-in strip, re-filable. Each newest captured item shows its
 * mission/project tag; tapping the tag opens {@link ReassignMenu} (one row's
 * menu open at a time). Items with NO projectId get the honest
 * {@link LowConfidenceFilePrompt} instead of a guessed tag. A successful move
 * confirms out loud via {@link ReassignTeachToast} — the correction teaches.
 *
 * The strip also carries the `⌗` rows (v9 §Q3) — arrivals Cue read and could
 * not make sense of. They are NOT in `items`: the daemon keeps an
 * un-comprehended arrival out of every task-list read, and this renders the
 * other side of that rule rather than undoing it. They are counted separately
 * in the header, because "I couldn't file this" and "I couldn't read this" are
 * different failures and only one of them is a claim about Cue.
 */
function CameInReassignStrip({
  items,
  projects,
  missionsByProjectId,
  assistantId,
  unreadable,
  onNewMission,
}: {
  items: HqWorkItem[];
  projects: ProjectView[];
  missionsByProjectId: Map<string, Mission>;
  assistantId: string;
  /** Scanned by the deck, not here — see {@link useUnreadableArrivals}. */
  unreadable: UnreadableArrivalsResult;
  onNewMission: () => void;
}) {
  const patch = usePatchWorkItem(assistantId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [taught, setTaught] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [ruleOffer, setRuleOffer] = useState<{
    sender: string | null;
    channel: string | null;
    workItemId: string;
    taskId: string;
  } | null>(null);
  const targets = useMemo(() => reassignTargets(projects), [projects]);
  const [allUnreadable, setAllUnreadable] = useState(false);

  const recent = useMemo(
    () => [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4),
    [items],
  );
  // The strip renders for either population. Returning null on `recent.length`
  // alone would put the un-comprehended count behind the very silence it exists
  // to break: nothing readable arrived, two things Cue couldn't read did, and
  // the surface would have said nothing at all.
  if (recent.length === 0 && unreadable.count === 0) return null;

  const move = (item: HqWorkItem, projectId: string | null) => {
    const dest = projectId
      ? (projects.find((p) => p.id === projectId) ?? null)
      : null;
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: item.id },
        body: moveBody(item, projectId),
      },
      {
        onSuccess: () => {
          setOpenId(null);
          setTaught(dest ? { from: item.title, to: dest.title } : null);
          // Filing a captured commitment IS the confirmation the rule offer
          // hangs off — promote it to a standing auto-confirm if the owner
          // wants. Only offered when we actually know the sender/channel.
          const ctx = senderContext(item);
          if (ctx.sender || ctx.channel) {
            setRuleOffer({ ...ctx, workItemId: item.id, taskId: item.taskId });
          }
        },
      },
    );
  };

  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        background: C.sunken,
        padding: "11px 15px",
        marginTop: 10,
      }}
    >
      <FilingKitStyle />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Two counts, never one. "Came in" is what arrived; the `⌗` count is
            what Cue failed to understand, and folding it into the first would
            hide the failure rate inside a healthy-looking total. */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <MicroLabel>Came in · {items.length}</MicroLabel>
          <UnreadableCount count={unreadable.count} />
        </span>
        <Link
          to={routes.allWork}
          style={{
            fontSize: 11.5,
            color: C.blueS,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          See what arrived ›
        </Link>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 10,
        }}
      >
        {recent.map((item) => {
          const badge = sourceBadge(item.sourceType);
          const mission = item.projectId
            ? (missionsByProjectId.get(item.projectId) ?? null)
            : null;
          const project = item.projectId
            ? (projects.find((p) => p.id === item.projectId) ?? null)
            : null;
          const tagLabel = mission?.title ?? project?.title ?? null;
          const isOpen = openId === item.id;
          const unfiled = !item.projectId;
          // Frame D2: Cue-filed rows carry the ✨ provenance pill (hover
          // "Move ›" → the anchored "Where does this belong?" popover);
          // user-filed rows keep the plain FILED tag + reassign menu.
          const autoFiled = !unfiled && isAutoFiled(item);
          return (
            <div key={item.id} data-filing-row style={{ position: "relative" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12.5,
                  color: C.t2,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: badge.tint,
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    flexShrink: 0,
                  }}
                >
                  {badge.glyph}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: C.ink,
                  }}
                >
                  {item.title}
                </span>
                {/* Held by the pre-run assessment: it is waiting on you, and
                    the strip has to say so before you click into it. */}
                <AssessmentSignal item={item} />
                {unfiled ? (
                  /* v7 §B: low filing confidence shows a `?` where a filed item
                     shows its thing chip. It is a REQUEST, not provenance — the
                     one thing allowed on the row besides the verb phrase, the
                     chip and the timing fact. The picker lives behind it; six
                     target chips per row is what made a lane of these
                     unreadable. */
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : item.id)}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    aria-label={`Cue isn't sure where "${item.title}" belongs — file it`}
                    title="Cue isn't sure where this belongs. Tell it."
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      flexShrink: 0,
                      fontFamily: mono,
                      fontSize: 11,
                      fontWeight: 600,
                      color: C.amberText,
                      background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${C.amber} 34%, transparent)`,
                      borderRadius: 999,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    ?
                  </button>
                ) : autoFiled ? (
                  <AutoFiledPill
                    projectTitle={tagLabel ?? "project"}
                    onMove={() => setOpenId(isOpen ? null : item.id)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : item.id)}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontFamily: mono,
                      fontSize: 9.5,
                      letterSpacing: "0.04em",
                      color: C.blueS,
                      background: C.blueW,
                      border: `1px solid color-mix(in srgb, ${C.blue} 24%, transparent)`,
                      borderRadius: 999,
                      padding: "3px 9px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {tagLabel ? tagLabel.toUpperCase() : "FILED"}
                    <span aria-hidden style={{ opacity: 0.7 }}>
                      ⌄
                    </span>
                  </button>
                )}
              </div>
              {/* Why it is holding, in the assessor's own words. */}
              {holdReason(item) ? (
                <div
                  style={{
                    fontSize: 11.5,
                    // amberText, not amber: 11.5px with no glyph beside it, so
                    // colour is the only carrier and the bright stop reads at
                    // 3.6:1 on white. See design addendum A1.
                    color: C.amberText,
                    lineHeight: 1.45,
                    marginTop: 5,
                    marginLeft: 28,
                  }}
                >
                  {holdReason(item)}
                </div>
              ) : null}
              {/* Behind the `?`, not beside it. */}
              {unfiled && isOpen ? (
                <div style={{ marginTop: 8 }}>
                  <LowConfidenceFilePrompt
                    sourceLabel={item.sourceType?.toUpperCase() ?? null}
                    targets={targets}
                    busy={patch.isPending}
                    onPick={(pid) => move(item, pid)}
                    onSomethingElse={onNewMission}
                  />
                </div>
              ) : null}
              {/* Unfiled items open the ask above, not this menu — the `?` is
                  now their only opener, and without this guard both would
                  render at once. */}
              {isOpen && !unfiled ? (
                autoFiled ? (
                  // Frame D2's anchored popover — current pick marked, ＋ New
                  // project, the 🧠 teaching close.
                  <RefilePopover
                    targets={targets}
                    currentId={item.projectId}
                    busy={patch.isPending}
                    onPick={(pid) => move(item, pid)}
                    onNew={onNewMission}
                    onClose={() => setOpenId(null)}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 8px)",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 6px)",
                      zIndex: 20,
                    }}
                  >
                    <ReassignMenu
                      targets={targets}
                      currentId={item.projectId}
                      busy={patch.isPending}
                      onPick={(pid) => move(item, pid)}
                      onNew={onNewMission}
                    />
                  </div>
                )
              ) : null}
            </div>
          );
        })}
        {/* The `⌗` rows. Capped like every other lane on this deck — the
            header count is what stays honest at volume; a lane of rows Cue
            cannot describe is the least useful thing that could grow. */}
        {(allUnreadable
          ? unreadable.items
          : unreadable.items.slice(0, UNREADABLE_ROW_CAP)
        ).map((entry) => (
          <UnreadableCameInRow
            key={entry.workItemId}
            entry={entry}
            assistantId={assistantId}
            targets={targets}
            onNewMission={onNewMission}
          />
        ))}
        {/* A count with no door is a fake affordance, and "See what arrived ›"
            is not that door — it goes to the task list, which is precisely
            where these items are not. The cap holds by default and opens only
            when asked; the set behind it is bounded by the scan window. */}
        {unreadable.count > UNREADABLE_ROW_CAP ? (
          <button
            type="button"
            onClick={() => setAllUnreadable((v) => !v)}
            aria-expanded={allUnreadable}
            style={{
              alignSelf: "flex-start",
              marginLeft: 28,
              fontSize: 11.5,
              fontWeight: 500,
              color: C.blueS,
              background: "transparent",
              border: "none",
              padding: "2px 0",
              cursor: "pointer",
            }}
          >
            {allUnreadable
              ? "Show fewer"
              : `Show the other ${unreadable.count - UNREADABLE_ROW_CAP} ›`}
          </button>
        ) : null}
      </div>
      {/* §4·B — the correction teaches. */}
      {taught ? (
        <div style={{ marginTop: 10 }}>
          <ReassignTeachToast
            destinationTitle={taught.to}
            fromTitle={null}
            onDismiss={() => setTaught(null)}
          />
        </div>
      ) : null}
      {/* "Make it a rule" — offered right after the owner confirms a captured
          commitment, so a one-off decision can become standing policy. The
          rule is consulted by the auto-run gate; it never widens the hard-deny
          floor. */}
      {ruleOffer ? (
        <div style={{ marginTop: 10 }}>
          <MakeItARuleCard
            assistantId={assistantId}
            sender={ruleOffer.sender}
            channel={ruleOffer.channel}
            sourceWorkItemId={ruleOffer.workItemId}
            sourceTaskId={ruleOffer.taskId}
            onDismiss={() => setRuleOffer(null)}
            onRuleCreated={() => setRuleOffer(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * §6 · Drift nudges for the deck. Each mission's events are watched for the
 * orchestrator's drift checkpoint; a real marker renders a {@link DriftNudge}
 * in the needs-you area. One watcher per mission keeps the event fetch scoped
 * (hooks can't run in a loop, so each mission gets its own tiny watcher).
 */
function MissionDriftNudges({
  assistantId,
  missions,
}: {
  assistantId: string;
  missions: Mission[];
}) {
  return (
    <>
      {missions.map((m) => (
        <MissionDriftWatcher key={m.id} assistantId={assistantId} mission={m} />
      ))}
    </>
  );
}

function MissionDriftWatcher({
  assistantId,
  mission,
}: {
  assistantId: string;
  mission: Mission;
}) {
  const navigate = useNavigate();
  const { events } = useMissionEvents(assistantId, mission.id);
  const drift = useMemo(
    () =>
      driftFromEvents(
        events.map((e) => ({ kind: e.kind, payload: e.payload, at: e.at })),
      ),
    [events],
  );
  const patch = usePatchMission(assistantId);
  const runCycle = useRunCycle(assistantId);
  if (!drift) return null;
  return (
    <div style={{ marginTop: 9 }}>
      <DriftNudge
        title={mission.title}
        idleCycles={drift.idleCycles}
        busy={patch.isPending || runCycle.isPending}
        onReplan={() =>
          runCycle.mutate({
            path: { assistant_id: assistantId, id: mission.id },
          })
        }
        onStepIn={() => navigate(routes.hqMission(mission.id))}
        onPause={() =>
          patch.mutate({
            path: { assistant_id: assistantId, id: mission.id },
            body: { status: "paused" },
          })
        }
      />
    </div>
  );
}

/** The header pills (Company & never-lines · New mission). Extracted so the
 *  desktop inline row and the mobile wrapped row share one definition. */
function HqHeaderActions({
  workspaceMode,
  hasMissions,
  onOpenCompany,
  onNewMission,
}: {
  workspaceMode: "observe" | "assist" | "autonomous";
  hasMissions: boolean;
  onOpenCompany: () => void;
  onNewMission: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onOpenCompany();
        }}
        title={`Workspace runs ${MODE_META[workspaceMode].label}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: C.t2,
          padding: "4px 10px",
          borderRadius: 999,
          border: `1px solid ${C.line2}`,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        ☰ Company &amp; never-lines
      </button>
      {hasMissions ? (
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onNewMission();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: C.blueS,
            padding: "4px 10px",
            borderRadius: 999,
            border: `1px solid color-mix(in srgb, ${C.blue} 32%, transparent)`,
            background: `color-mix(in srgb, ${C.blue} 10%, transparent)`,
            cursor: "pointer",
          }}
        >
          <Plus size={12} /> New mission
        </button>
      ) : null}
    </>
  );
}

export function HqPage() {
  const assistantId = useActiveAssistantId();
  const isMobile = useMobileLayout();
  // SSE keeps every lane current; polls below are 60s safety-nets.
  useActivitySync(assistantId, true);

  const {
    missions: liveMissions,
    isLoading,
    isError: missionsError,
  } = useMissions(assistantId);
  // Abandoned missions still get a ring, in the blocked tone. A goal that
  // drifted is information; omitting it made a real deck look like an empty
  // product. Appended after live ones so they never outrank active work.
  const { missions: abandonedMissions } = useAbandonedMissions(assistantId);
  const missions = useMemo(
    () => [...liveMissions, ...abandonedMissions],
    [liveMissions, abandonedMissions],
  );
  const { projects } = useProjects(assistantId);
  const review = useHqWorkItems(assistantId, "awaiting_review");
  const running = useHqWorkItems(assistantId, "running");
  const queued = useHqWorkItems(assistantId, "pending");
  const done = useHqWorkItems(assistantId, "done");
  const { schedules, isError: schedulesError } = useHqSchedules(assistantId);
  // Stamped once per mount: "waiting 6 days" must not tick over mid-session
  // because something unrelated re-rendered. Reading the clock during render is
  // impure for exactly that reason.
  const [nowMs] = useState(() => Date.now());
  // The three modules that shipped stating a reason. Each hook returns EITHER
  // data or a sentence — never an empty array standing in for "couldn't ask".
  const dayPicture = useDayPicture(assistantId);
  const life = useLifeHorizons(assistantId);
  const waitingOn = useWaitingOnPeople(assistantId, nowMs);
  // Drives the "not set up" / "broken" states and the pulse strip. Read from
  // the real watcher list rather than assumed: the moment auto-provisioning
  // lands, this flips on its own and the blue "Cue can see your inbox" card
  // retires itself.
  const watchersQuery = useWatchers();
  const watchers = watchersQuery.data ?? [];
  // A watcher that EXISTS is not a watcher that WORKS. Counting rows would let
  // two provisioned-but-failing watchers retire the "not watching" card and
  // silently imply Cue is observing the inbox — the precise dishonesty the
  // design forbids ("never promise something the system can't do"). So a
  // watcher counts as watching only while it is enabled and not currently
  // erroring; the ones that are erroring get named in the broken state instead.
  const liveWatchers = watchers.filter((w) => w.enabled && !w.lastError);
  const failingWatchers = watchers.filter((w) => w.enabled && w.lastError);
  /**
   * Pending approvals. These are deliberately NOT folded into the needs-you
   * count: invariant 2 fixes one needs-you definition (`awaiting_review` +
   * assigned to you) shared by the badge, the headline and the rows, and
   * widening it here is what made the headline read 6 while the sidebar read 5.
   * The next-move card already carries the top one, so only the remainder gets
   * its own line inside the lane.
   */
  const interactionsQuery = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  const stateQuery = useHomeStateQuery(assistantId);
  const { profile } = useCompanyProfile(assistantId);
  const { move, isLoading: moveLoading } = useNextMove(assistantId);
  const { degraded, syncedLabel } = useDegradedState();
  const orientation = useHqOrientation();
  const todayStart = useTodayStart();

  const month = monthWindow();
  const usage = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId },
      query: { from: month.from, to: month.to },
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const budget = useQuery({
    queryKey: ["budget", "config", assistantId],
    queryFn: () => getBudgetConfig(assistantId),
    staleTime: 60_000,
    retry: false,
  });

  const [showNewMission, setShowNewMission] = useState<
    { open: false } | { open: true; presetTitle?: string }
  >({ open: false });
  const [showCompany, setShowCompany] = useState(false);
  const navigate = useNavigate();

  // Stamped once per mount — keeps timestamps out of the render path.
  const [dayLabel] = useState(() =>
    new Date()
      .toLocaleDateString(undefined, {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
      .toUpperCase(),
  );

  const byProject = useMemo(() => missionByProject(missions), [missions]);
  const cameIn = queued.items;
  // What arrived on its own, split by what Cue managed to do with it. `filed`
  // has a named destination and provenance; `kept` was scored and deliberately
  // NOT guessed (the auto-filer stamps a confidence while leaving the item
  // unfiled — that shape is the "Cue was unsure" signal). Anything in neither
  // bucket is still in flight and is not counted as handled.
  // The staff, with receipts. "128 acts · 0 reversed" is the line that makes
  // autonomy credible, and both halves are queryable today.
  const actsSummary = useQuery({
    ...actsSummaryGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const agentsNow: AgentNow[] = useMemo(
    () =>
      (actsSummary.data?.byAgent ?? []).map((a) => ({
        name: a.agent,
        emoji: null,
        tier: null,
        activity: null,
        acts: a.acts,
        reversed: a.reversed,
      })),
    [actsSummary.data],
  );

  /**
   * The arrivals census, read from the daemon rather than inferred.
   *
   * The first version of this computed `filed` from `autoFiledBy`, which in
   * this codebase means "assigned to a project" — those items are still sitting
   * in the owner's lane. So the digest claimed Cue had *handled* things it had
   * merely categorised, which is precisely the overstatement the digest exists
   * to avoid. `filed` now means recorded and out of your way, and `kept` means
   * Cue looked and decided you need to see it. Both are counted by the gate
   * that made the decision.
   */
  // Filing health. Polled on the slow lane — a stalled filer is measured in
  // sweeps, not seconds, and this must never add load to the deck.
  const autoFileHealth = useQuery({
    ...workitemsAutofileHealthGetOptions({
      path: { assistant_id: assistantId },
    }),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const arrivalsQuery = useQuery({
    ...arrivalsSummaryGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const arrivals: ArrivalsSummary = useMemo(
    () => ({
      total: arrivalsQuery.data?.arrived ?? 0,
      filed: arrivalsQuery.data?.filed ?? 0,
      kept: arrivalsQuery.data?.kept ?? 0,
    }),
    [arrivalsQuery.data],
  );
  const workspaceMode = profile?.workspaceMode ?? "assist";

  // The deck's live surfaces (pulse ring, headline, mission list, drift
  // nudges) show only open rings — an achieved mission is done, not "on
  // track", and belongs to its detail page's achieved banner instead.
  // `byProject` above stays unfiltered so review/came-in items keep their
  // mission tag even after the mission is achieved.
  const deckMissions = useMemo(
    () => missions.filter((m) => m.status !== "achieved"),
    [missions],
  );
  const hasMissions = deckMissions.length > 0;

  // Real-usage evidence for the first-run meter. The meter's own progress is
  // localStorage-only, so this is what stops it nagging an account that has
  // obviously been running for weeks (see `shouldShowSetupMeter`).
  const setupUsage: AccountUsageSignals = useMemo(
    () => ({
      missionCount: missions.length,
      projectCount: projects.length,
      scheduleCount: schedules.length,
      workItemCount:
        review.items.length +
        running.items.length +
        queued.items.length +
        done.items.length,
      hasIdentity:
        (profile?.identity ?? "").trim().length > 0 ||
        (profile?.direction ?? "").trim().length > 0,
    }),
    [
      missions.length,
      projects.length,
      schedules.length,
      review.items.length,
      running.items.length,
      queued.items.length,
      done.items.length,
      profile?.identity,
      profile?.direction,
    ],
  );

  // The next-move card and the Needs-you lane read the same stores — when the
  // move IS one of the review items, the emphasized card replaces its row.
  const reviewItems = review.items.filter((item) => item.id !== move.itemId);
  const doneToday = done.items.filter(
    (item) => (item.updatedAt ?? item.createdAt) >= todayStart,
  );
  /**
   * The one needs-you number. `reviewItems` has already had the next-move item
   * filtered out when the move WAS one of the review rows, so adding 1
   * unconditionally double-counted a move that is neither a review row nor an
   * approval — a queued work item. That is what made the headline read 6 while
   * the sidebar badge, reading the same two queries, read 5.
   */
  const moveIsExtraToNeedsYou =
    move.hasMove &&
    (review.items.length !== reviewItems.length || move.kind === "approval");
  const extraApprovalItems = useMemo(() => {
    const all = readPausedApprovals(interactionsQuery.data?.interactions);
    // The next-move card already carries the top one; the rest need to be
    // decidable here rather than counted here and decidable nowhere.
    return move.hasMove && move.kind === "approval" ? all.slice(1) : all;
  }, [interactionsQuery.data, move.hasMove, move.kind]);

  // Paused runs count. Invariant 2 says "needs you" has ONE definition shared
  // by the badge, the headline and the rows — and `use-needs-you-badge` has
  // always counted approvals + awaiting-review. The headline counted only the
  // reviews, so the two agreed solely while nothing was paused; the moment a
  // run stopped they diverged. Design's ruling settles it in the badge's
  // favour, and rightly: a stopped run is the most literal instance of
  // "blocked on a human decision" in the product.
  const glanceCount =
    reviewItems.length +
    (moveIsExtraToNeedsYou ? 1 : 0) +
    extraApprovalItems.length;

  // The next-move card carries at most one approval; the rest need a door.

  // MOBILE → the v3 native Today screen (docs/design/mobile-v3, frame 1).
  // Same stores, new skin: next-move → NEXT MOVE card, approvals → NEEDS
  // YOUR OK, awaiting_review → REVIEW READY, running → WORKING NOW, pending
  // → the came-in strip. Desktop keeps the serif HQ deck below, untouched.
  if (isMobile) {
    return (
      <Mv3Today
        assistantId={assistantId}
        userName={stateQuery.data?.userName?.trim() || null}
        move={move}
        moveLoading={moveLoading}
        review={reviewItems}
        reviewError={review.isError}
        // Computed ONCE, here, and handed to both surfaces — the badge, the
        // headline and the rows are provably the same set (invariant 2).
        glanceCount={glanceCount}
        running={running.items}
        cameIn={cameIn}
        done={doneToday}
        doneError={done.isError}
        missions={deckMissions}
        missionsError={missionsError}
        day={dayPicture.day}
        dayUnavailable={dayPicture.unavailable}
        lifeGroups={life.groups}
        lifeUnavailable={life.unavailable}
        arrivals={arrivals}
        arrivalsError={arrivalsQuery.isError}
        waiting={waitingOn.items}
        waitingUnavailable={waitingOn.unavailable}
        schedules={schedules}
        schedulesError={schedulesError}
        watchingCount={liveWatchers.length}
        heartbeatRuns={null}
        degraded={degraded}
      />
    );
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <HqStyle />
      {/* Degraded: cached deck stays readable under a quiet reconnect line. */}
      {degraded ? <ReconnectBanner syncedLabel={syncedLabel} /> : null}
      <div
        data-slot="hq-page-pad"
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: isMobile ? "18px 14px 60px" : "28px 24px 60px",
          opacity: degraded ? 0.72 : 1,
          transition: "opacity .3s ease",
        }}
      >
        {/* Header: kicker + live dot + Company & New mission actions. On mobile
            the actions drop to their own wrapped row so the long "Company &
            never-lines" pill never collides with the kicker at 390px. */}
        <header style={{ marginBottom: 4 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: isMobile ? 10 : 6,
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 11.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: C.blueS,
              }}
            >
              HQ
            </div>
            {/* Actions sit inline on desktop; on mobile only the live dot
                stays on this row (the pills move below). */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {!isMobile ? (
                <HqHeaderActions
                  workspaceMode={workspaceMode}
                  hasMissions={hasMissions}
                  onOpenCompany={() => setShowCompany(true)}
                  onNewMission={() => setShowNewMission({ open: true })}
                />
              ) : null}
              <LiveDot />
            </div>
          </div>
          {isMobile ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <HqHeaderActions
                workspaceMode={workspaceMode}
                hasMissions={hasMissions}
                onOpenCompany={() => setShowCompany(true)}
                onNewMission={() => setShowNewMission({ open: true })}
              />
            </div>
          ) : null}
        </header>

        {/* SETTING UP · N OF M — non-shaming first-run meter (self-hides). */}
        {!isLoading ? <SetupMeter usage={setupUsage} /> : null}

        {/* Build-out tiles — live counts, deep-linking. Render only once
            setup is COMPLETE (the component gates itself), so this never
            competes with the meter above for attention. */}
        {!isLoading ? <BuildOutTiles assistantId={assistantId} /> : null}

        {isLoading ? (
          <HqDeckSkeleton />
        ) : (
          <HqDeck
            assistantId={assistantId}
            move={move}
            needsYou={reviewItems}
            needsYouError={review.isError}
            extraApprovalItems={extraApprovalItems}
            moveIsExtraToNeedsYou={moveIsExtraToNeedsYou}
            arrivals={arrivals}
            arrivalsError={arrivalsQuery.isError}
            established={hasRealUsage(setupUsage)}
            trust={{
              // The id, not a capitalised copy of it: TrustChip renders the
              // label design wrote (`MODE_META`), never the raw enum.
              mode: workspaceMode,
              // Both sources report dollars, not cents — convert once here so
              // TrustChip only ever deals in one unit.
              spentCents:
                usage.data?.totalEstimatedCostUsd != null
                  ? Math.round(usage.data.totalEstimatedCostUsd * 100)
                  : null,
              capCents:
                budget.data?.monthlyCapUsd != null
                  ? Math.round(budget.data.monthlyCapUsd * 100)
                  : null,
            }}
            missions={deckMissions}
            missionsError={missionsError}
            projects={projects}
            schedules={schedules}
            schedulesError={schedulesError}
            // Each of these is EITHER data or a sentence saying why there is
            // none. What changed with v7 is what happens next: an empty lane
            // is now one grey line rather than a card stating its emptiness.
            day={dayPicture.day}
            dayUnavailable={dayPicture.unavailable}
            lifeGroups={life.groups}
            lifeUnavailable={life.unavailable}
            agentsNow={agentsNow}
            waiting={waitingOn.items}
            waitingUnavailable={waitingOn.unavailable}
            autoFileDegraded={
              autoFileHealth.data?.degraded
                ? (autoFileHealth.data.degradedReason ??
                  "Cue has stopped filing work into projects.")
                : null
            }
            watchingCount={liveWatchers.length}
            failingWatchers={failingWatchers.map((w) => ({
              id: w.id,
              name: w.name,
              lastError: w.lastError ?? "",
            }))}
            heartbeatRuns={null}
            cameIn={cameIn}
            running={running.items}
            done={doneToday}
            doneError={done.isError}
            missionsByProjectId={byProject}
            userName={stateQuery.data?.userName?.trim() || null}
            dayLabel={dayLabel}
            onNewMission={() => setShowNewMission({ open: true })}
            onSuggest={(title) =>
              setShowNewMission({ open: true, presetTitle: title })
            }
          />
        )}
      </div>

      {showNewMission.open ? (
        <NewMissionModal
          assistantId={assistantId}
          presetTitle={showNewMission.presetTitle}
          workspaceMode={workspaceMode}
          onClose={() => setShowNewMission({ open: false })}
          onCreated={(id) => {
            setShowNewMission({ open: false });
            navigate(routes.hqMission(id));
          }}
        />
      ) : null}
      {showCompany ? (
        <CompanyPanel
          assistantId={assistantId}
          onClose={() => setShowCompany(false)}
        />
      ) : null}
      {/* One-time switch-over orientation — "Your Home is now HQ". */}
      {orientation.show ? (
        <HqOrientationPanel onDismiss={orientation.dismiss} />
      ) : null}
    </div>
  );
}
