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
import { LiveDot } from "@/components/live-dot";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import { usageTotalsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { getBudgetConfig } from "@/lib/budget-api";
import { relativeTime } from "@/domains/activity/theme";
import { BuildOutTiles } from "@/pages/command-center/build-out-tiles";
import {
  dismissMeter,
  readSetupState,
  useSetupProgress,
} from "@/pages/hq-onboarding/setup-state";
import {
  useProjects,
  usePatchWorkItem,
  type ProjectView,
} from "@/pages/projects/use-projects";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";

import { MakeItARuleCard } from "@/domains/chat/components/make-it-a-rule-card";

import { CaptureBar } from "./capture-bar";
import { HqWorkLoopBoard } from "./hq-board";
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
  CameInErrorStrip,
  HqDeckSkeleton,
  NextMoveCard,
  QueuedScheduledSection,
  ReconnectBanner,
  TimeBackChip,
  useDegradedState,
  useNextMove,
  useTodayStart,
  WatchingLine,
  type NextMove,
} from "./hq-modules";
import { HqOrientationPanel, useHqOrientation } from "./hq-orientation";
import {
  C,
  HERO_GRADIENT,
  HqStyle,
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
import { NewMissionModal } from "./new-mission-modal";
import {
  missionByProject,
  ringStatusFor,
  useCompanyProfile,
  useHqSchedules,
  useHqWorkItems,
  useMissionEvents,
  useMissions,
  usePatchMission,
  useRunCycle,
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
  const rings = missions.map((m, i) => ({
    status: ringStatusFor(m),
    hue: missionHue(i),
  }));
  const onTrack = rings.filter((r) => r.status === "on_track").length;
  const needsYou = rings.filter((r) => r.status === "needs_you").length;
  const blocked = rings.filter((r) => r.status === "blocked").length;

  return (
    <div
      data-slot="hq-hero-card"
      data-coach="hq-rings"
      style={{
        display: "flex",
        gap: 22,
        alignItems: "center",
        background: HERO_GRADIENT,
        borderRadius: 16,
        padding: "22px 24px",
        color: "#fff",
        marginTop: 16,
      }}
    >
      <RingsHero
        rings={rings}
        onTrack={onTrack}
        total={missions.length}
        size={176}
      />
      <div data-slot="hq-hero-lines" style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,.55)",
          }}
        >
          {dayLabel}
          {doneToday > 0 ? ` · ${doneToday} handled today` : ""}
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 24,
            lineHeight: 1.15,
            marginTop: 6,
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
                role="link"
                tabIndex={0}
                onClick={() => navigate(routes.hqMission(m.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(routes.hqMission(m.id));
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 12.5,
                  cursor: "pointer",
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
    if (item.lastRunConversationId) {
      navigate(routes.conversation(item.lastRunConversationId));
    } else {
      navigate(routes.allWork);
    }
  };
  return (
    <div
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
          onClick={() => navigate(routes.hqMission(mission.id))}
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
            role="button"
            tabIndex={0}
            onClick={() => navigate(routes.hqMission(m.id))}
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

/** The pulse — HQ with zero missions. Never a blank canvas. */
function PulseLayout({
  assistantId,
  move,
  needsYou,
  cameIn,
  running,
  done,
  missionsByProjectId,
  userName,
  dayLabel,
  onNewMission,
  onSuggest,
}: {
  assistantId: string;
  move: NextMove;
  needsYou: HqWorkItem[];
  cameIn: HqWorkItem[];
  running: HqWorkItem[];
  done: HqWorkItem[];
  missionsByProjectId: Map<string, Mission>;
  userName: string | null;
  dayLabel: string;
  onNewMission: () => void;
  onSuggest: (title: string) => void;
}) {
  const glanceCount = needsYou.length + (move.hasMove ? 1 : 0);
  const firstRun = useHqFirstRun();
  return (
    <div data-slot="hq-stream">
      <MicroLabel
        color={C.t3}
        style={{ fontSize: 11, letterSpacing: "0.14em" }}
      >
        {dayLabel}
      </MicroLabel>
      <div
        data-slot="hq-title"
        style={{
          fontFamily: serif,
          fontSize: 34,
          lineHeight: 1.08,
          color: C.ink,
          marginTop: 8,
        }}
      >
        {userName ? `Good ${dayPart()}, ${userName}.` : `Good ${dayPart()}.`}
        <br />
        {glanceCount > 0
          ? `A calm one — ${glanceCount === 1 ? "one thing" : `${glanceCount} things`} I'd glance at.`
          : "A calm one — nothing needs you right now."}
      </div>

      <div style={{ marginTop: 22, maxWidth: 640 }} data-coach="hq-capture">
        <CaptureBar
          placeholder="Ask Cue anything, or give it a mission…"
          autoFilesChip={false}
        />
      </div>

      {/* First-run — three cards that teach the loop, once. Shown on the pulse
          path too: a zero-mission account is exactly who needs the explainer. */}
      {firstRun.show ? <HqFirstRun onDismiss={firstRun.dismiss} /> : null}

      {/* auto-fit + minmax(0,…) so the pair collapses to one column on narrow
          viewports AND the tracks can shrink below their content's min-content
          width — a bare `1fr` refuses to, which pushed these cards ~100px past
          a 390px screen (the clipped-card bug). */}
      <div
        data-slot="hq-columns"
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          gap: 30,
          marginTop: 32,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {glanceCount > 0 ? (
            <>
              <MicroLabel color={C.danger}>
                Needs you · {glanceCount}
              </MicroLabel>
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
                {needsYou.slice(0, 4).map((item) => (
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
            </>
          ) : null}

          {cameIn.length > 0 ? (
            <>
              <MicroLabel
                style={{
                  margin: glanceCount > 0 ? "24px 0 12px" : "0 0 12px",
                }}
              >
                Came in · {cameIn.length}
              </MicroLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[...cameIn]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .slice(0, 4)
                  .map((item) => {
                    const badge = sourceBadge(item.sourceType);
                    return (
                      <div
                        key={item.id}
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
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.title}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </>
          ) : null}
        </div>

        <div style={{ minWidth: 0 }}>
          <MicroLabel color={C.blueS}>Cue could take these on</MicroLabel>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 11,
              marginTop: 12,
            }}
          >
            {SUGGESTED_MISSIONS.map((s) => (
              <div
                key={s.title}
                style={{
                  border: `1px solid ${C.line}`,
                  borderRadius: 14,
                  padding: 16,
                  background: `linear-gradient(160deg, ${C.surface}, color-mix(in srgb, ${C.blue} 4%, ${C.surface}))`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span aria-hidden style={{ fontSize: 18 }}>
                    {s.glyph}
                  </span>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
                    {s.title}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: C.t2,
                    marginTop: 7,
                    lineHeight: 1.45,
                  }}
                >
                  {s.blurb}
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => onSuggest(s.title)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      background: C.blue,
                      color: "#fff",
                      border: "none",
                      borderRadius: 9,
                      padding: "8px 14px",
                      cursor: "pointer",
                    }}
                  >
                    Start mission
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              color: C.t3,
              lineHeight: 1.5,
            }}
          >
            No open missions yet — and that&rsquo;s fine. Cue keeps catching
            what comes in;{" "}
            <button
              type="button"
              onClick={onNewMission}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                fontSize: 12,
                color: C.blueS,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              give it a mission
            </button>{" "}
            when you&rsquo;re ready.
          </div>
        </div>
      </div>

      {/* The work loop doesn't depend on missions — a zero-mission account
          still captures, runs, and reviews work, so the board belongs here
          too (it's the whole point of the surface). */}
      <HqWorkLoopBoard
        assistantId={assistantId}
        running={running}
        review={needsYou}
        done={done}
        byProject={missionsByProjectId}
      />

      <div
        style={{
          marginTop: 36,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          color: C.t3,
        }}
      >
        NO MISSIONS YET
        {glanceCount === 0 ? " · NOTHING TO REVIEW" : ""}
      </div>
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
 */
function SetupMeter() {
  const { done, total, nextStep, nextLabel } = useSetupProgress();
  const dismissed = readSetupState().meterDismissed;
  if (done >= total || dismissed || !nextStep) return null;
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
 * §4 · The came-in strip, re-filable. Each newest captured item shows its
 * mission/project tag; tapping the tag opens {@link ReassignMenu} (one row's
 * menu open at a time). Items with NO projectId get the honest
 * {@link LowConfidenceFilePrompt} instead of a guessed tag. A successful move
 * confirms out loud via {@link ReassignTeachToast} — the correction teaches.
 */
function CameInReassignStrip({
  items,
  projects,
  missionsByProjectId,
  assistantId,
  onNewMission,
}: {
  items: HqWorkItem[];
  projects: ProjectView[];
  missionsByProjectId: Map<string, Mission>;
  assistantId: string;
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

  const recent = useMemo(
    () => [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4),
    [items],
  );
  if (recent.length === 0) return null;

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <MicroLabel>Came in · {items.length}</MicroLabel>
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
          return (
            <div key={item.id} style={{ position: "relative" }}>
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
                {unfiled ? null : (
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
              {/* Low-confidence unfiled item — asks, doesn't guess. */}
              {unfiled ? (
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
              {isOpen ? (
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
              ) : null}
            </div>
          );
        })}
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

export function HqPage() {
  const assistantId = useActiveAssistantId();
  // SSE keeps every lane current; polls below are 60s safety-nets.
  useActivitySync(assistantId, true);

  const { missions, isLoading } = useMissions(assistantId);
  const { projects } = useProjects(assistantId);
  const review = useHqWorkItems(assistantId, "awaiting_review");
  const running = useHqWorkItems(assistantId, "running");
  const queued = useHqWorkItems(assistantId, "pending");
  const done = useHqWorkItems(assistantId, "done");
  const { schedules } = useHqSchedules(assistantId);
  const stateQuery = useHomeStateQuery(assistantId);
  const { profile } = useCompanyProfile(assistantId);
  const { move } = useNextMove(assistantId);
  const { degraded, syncedLabel } = useDegradedState();
  const orientation = useHqOrientation();
  const firstRun = useHqFirstRun();
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
  // The next-move card and the Needs-you lane read the same stores — when the
  // move IS one of the review items, the emphasized card replaces its row.
  const reviewItems = review.items.filter((item) => item.id !== move.itemId);
  const doneToday = done.items.filter(
    (item) => (item.updatedAt ?? item.createdAt) >= todayStart,
  );

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
          padding: "28px 24px 60px",
          opacity: degraded ? 0.72 : 1,
          transition: "opacity .3s ease",
        }}
      >
        {/* Header: kicker + live dot + Company & New mission actions. */}
        <header style={{ marginBottom: 4 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 6,
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
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={() => setShowCompany(true)}
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
                  onClick={() => setShowNewMission({ open: true })}
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
              <LiveDot />
            </div>
          </div>
        </header>

        {/* SETTING UP · N OF M — non-shaming first-run meter (self-hides). */}
        {!isLoading ? <SetupMeter /> : null}

        {/* Build-out tiles — live counts, deep-linking. Render only once
            setup is COMPLETE (the component gates itself), so this never
            competes with the meter above for attention. */}
        {!isLoading ? <BuildOutTiles assistantId={assistantId} /> : null}

        {isLoading ? (
          <HqDeckSkeleton />
        ) : !hasMissions ? (
          <PulseLayout
            assistantId={assistantId}
            move={move}
            needsYou={reviewItems}
            cameIn={cameIn}
            running={running.items}
            done={doneToday}
            missionsByProjectId={byProject}
            userName={stateQuery.data?.userName?.trim() || null}
            dayLabel={dayLabel}
            onNewMission={() => setShowNewMission({ open: true })}
            onSuggest={(title) =>
              setShowNewMission({ open: true, presetTitle: title })
            }
          />
        ) : (
          <div data-slot="hq-stream" style={{ minWidth: 0 }}>
            <div data-coach="hq-capture">
              <CaptureBar />
            </div>
            <RingsHeroCard
              missions={deckMissions}
              doneToday={doneToday.length}
              dayLabel={dayLabel}
            />

            {/* Inbound — the watching line + came-in strip. Reassign/teach
                lives here; the board below picks the loop up from Running. */}
            <WatchingLine assistantId={assistantId} />
            {queued.isError ? (
              <CameInErrorStrip onRetry={() => void queued.refetch()} />
            ) : (
              <CameInReassignStrip
                items={cameIn}
                projects={projects}
                missionsByProjectId={byProject}
                assistantId={assistantId}
                onNewMission={() => setShowNewMission({ open: true })}
              />
            )}

            {/* §6 · Drifting — honest nudge on any mission that's idling. */}
            <MissionDriftNudges
              assistantId={assistantId}
              missions={deckMissions}
            />

            {/* ◆ YOUR NEXT MOVE — the chief-of-staff pick, emphasized above the
                board. reviewItems already excludes it, so it never doubles. */}
            {move.hasMove ? (
              <div style={{ marginTop: 16 }}>
                <NextMoveCard assistantId={assistantId} move={move} />
              </div>
            ) : null}

            {/* First-run — three cards that teach the loop, once. */}
            {firstRun.show ? <HqFirstRun onDismiss={firstRun.dismiss} /> : null}

            {/* The work-loop board — Running → Needs you → Review → Done, with
                live movement on the running cards. Inbound stays in the strip
                above, so this is the four-lane active loop. */}
            <HqWorkLoopBoard
              assistantId={assistantId}
              running={running.items}
              review={reviewItems}
              done={doneToday}
              byProject={byProject}
            />

            {/* Standing schedules — what fires on its own. */}
            <QueuedScheduledSection
              queued={cameIn}
              schedules={schedules}
              missionsByProjectId={byProject}
            />

            {/* Spend + time-back — the honest cost line (from the retired rail). */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 16,
              }}
            >
              <div
                style={{
                  minWidth: 140,
                  background: C.surface,
                  border: `1px solid ${C.line}`,
                  borderRadius: 10,
                  padding: 11,
                }}
              >
                <MicroLabel style={{ fontSize: 9.5 }}>Spend · month</MicroLabel>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: C.ink,
                    marginTop: 2,
                  }}
                >
                  $
                  {(usage.data?.totalEstimatedCostUsd ?? 0).toFixed(
                    (usage.data?.totalEstimatedCostUsd ?? 0) >= 100 ? 0 : 2,
                  )}
                  {budget.data?.monthlyCapUsd != null ? (
                    <span
                      style={{ fontSize: 11, color: C.t3, fontWeight: 400 }}
                    >
                      {" "}
                      / ${budget.data.monthlyCapUsd}
                    </span>
                  ) : null}
                </div>
              </div>
              <TimeBackChip ledger={null} />
            </div>

            <MicroLabel style={{ margin: "20px 0 10px" }}>
              Missions · {deckMissions.length}
            </MicroLabel>
            <MissionList missions={deckMissions} />
          </div>
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
