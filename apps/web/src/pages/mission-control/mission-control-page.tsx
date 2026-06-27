/**
 * Mission Control — the unified five-lane command center.
 *
 * One surface that shows the whole activity lifecycle as columns of the same
 * object, updated live (docs/MISSION_CONTROL.md §2.3). Left → right mirrors the
 * lifecycle:
 *
 *   Inbound      → Home's action-board feed (Run / Snooze / Dismiss)
 *   Awaiting you → pending interactions + approvals (Approve / Decline inline)
 *   In progress  → running work-items + live subagents (Cancel / Output / Abort)
 *   Scheduled    → schedules + watchers + sequences (Run-now / Pause / Digest)
 *   Done         → recently completed, results inline (Re-run / Open thread)
 *
 * This is a composition, not a rewrite: each lane body REUSES the existing
 * Activity section components (which already bind the real daemon endpoints +
 * steer controls) and Home's feed for Inbound. The page mounts `useActivitySync`
 * so every lane updates the instant the daemon broadcasts — the header carries a
 * real ● live indicator.
 *
 * Desktop: five flex columns. Mobile: one lane at a time, switched via a
 * scrollable lane-tab bar (swipe-equivalent).
 */

import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CheckCircle2,
  Inbox,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { LiveDot } from "@/components/live-dot";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { C, mono, serif } from "@/domains/activity/theme";
import { NeedsYouSection } from "@/domains/activity/sections/needs-you-section";
import { RecentlyDoneSection } from "@/domains/activity/sections/recently-done-section";
import { RunningSection } from "@/domains/activity/sections/running-section";
import { ScheduledSection } from "@/domains/activity/sections/scheduled-section";
import { SequencesSection } from "@/domains/activity/sections/sequences-section";
import { WatchingSection } from "@/domains/activity/sections/watching-section";
import {
  pendinginteractionsGetOptions,
  schedulesGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { InboundLane } from "./inbound-lane";
import { MissionLane } from "./mission-lane";

const SAFETY_NET_MS = 60_000;

type LaneId = "inbound" | "awaiting" | "in_progress" | "scheduled" | "done";

interface LaneDef {
  id: LaneId;
  title: string;
  icon: typeof Inbox;
  accent: string;
  urgent?: boolean;
}

const LANES: LaneDef[] = [
  { id: "inbound", title: "Inbound", icon: Inbox, accent: C.blueS },
  {
    id: "awaiting",
    title: "Awaiting you",
    icon: ShieldAlert,
    accent: C.danger,
    urgent: true,
  },
  { id: "in_progress", title: "In progress", icon: Zap, accent: C.blue },
  { id: "scheduled", title: "Scheduled", icon: CalendarClock, accent: C.violet },
  { id: "done", title: "Done", icon: CheckCircle2, accent: C.green },
];

/**
 * Header tally — reads the same react-query caches the lanes use (deduped by
 * key), so the counts never trigger a second fetch and stay honest. Polls are a
 * 60s safety-net; SSE drives the real-time updates.
 */
function useTally(assistantId: string) {
  const running = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "running" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  const done = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "done" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 20_000,
  });
  const schedules = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 20_000,
  });
  const awaiting = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 10_000,
  });

  const standing = (schedules.data?.schedules ?? []).filter(
    (s) => s.status !== "cancelled",
  ).length;

  return {
    awaiting: awaiting.data?.interactions?.length ?? 0,
    running: running.data?.items?.length ?? 0,
    standing,
    done: done.data?.items?.length ?? 0,
  };
}

function LaneBody({
  id,
  assistantId,
  validConversationIds,
}: {
  id: LaneId;
  assistantId: string;
  validConversationIds?: Set<string>;
}) {
  switch (id) {
    case "inbound":
      return (
        <InboundLane
          assistantId={assistantId}
          validConversationIds={validConversationIds}
        />
      );
    case "awaiting":
      return <NeedsYouSection assistantId={assistantId} />;
    case "in_progress":
      return <RunningSection assistantId={assistantId} />;
    case "scheduled":
      return (
        <>
          <ScheduledSection assistantId={assistantId} />
          <WatchingSection assistantId={assistantId} />
          <SequencesSection assistantId={assistantId} />
        </>
      );
    case "done":
      return <RecentlyDoneSection assistantId={assistantId} />;
    default:
      return null;
  }
}

export function MissionControlPage({
  validConversationIds,
}: {
  validConversationIds?: Set<string>;
} = {}) {
  const assistantId = useActiveAssistantId();
  const isMobile = useIsMobile();
  // Real-time: drive every lane off the SSE stream.
  useActivitySync(assistantId, true);
  const tally = useTally(assistantId);

  const [activeLane, setActiveLane] = useState<LaneId>("inbound");

  const laneCount: Record<LaneId, number | null> = {
    inbound: null,
    awaiting: tally.awaiting,
    in_progress: tally.running,
    scheduled: tally.standing,
    done: tally.done,
  };

  const tallyText = [
    `${tally.awaiting} awaiting`,
    `${tally.running} running`,
    `${tally.standing} standing`,
    `${tally.done} done today`,
  ].join("  ·  ");

  const visibleLanes = isMobile
    ? LANES.filter((l) => l.id === activeLane)
    : LANES;

  return (
    <div
      data-slot="mission-control-page"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        minHeight: 0,
      }}
    >
      <header
        style={{
          flexShrink: 0,
          padding: "18px 22px 14px",
          borderBottom: `1px solid ${C.line}`,
          background: C.surface,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
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
            Mission Control
          </div>
          <LiveDot />
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 30,
            letterSpacing: "-0.4px",
            lineHeight: 1.1,
            color: C.ink,
            marginTop: 4,
          }}
        >
          Everything, end to end.
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 13,
            color: C.t2,
            marginTop: 6,
          }}
        >
          {tallyText}
        </div>
      </header>

      {isMobile ? (
        <nav
          aria-label="Lanes"
          style={{
            flexShrink: 0,
            display: "flex",
            gap: 6,
            padding: "10px 12px",
            overflowX: "auto",
            background: C.surface,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          {LANES.map((lane) => {
            const active = lane.id === activeLane;
            const count = laneCount[lane.id];
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => setActiveLane(lane.id)}
                aria-current={active ? "page" : undefined}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 12px",
                  borderRadius: 999,
                  border: `1px solid ${active ? lane.accent : C.line2}`,
                  background: active ? lane.accent : C.surface,
                  color: active ? "#fff" : C.t1,
                  fontFamily: mono,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <lane.icon size={13} aria-hidden />
                {lane.title}
                {typeof count === "number" && count > 0 ? (
                  <span
                    style={{
                      fontSize: 11,
                      opacity: active ? 0.9 : 0.6,
                    }}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      ) : null}

      <div
        data-slot="mission-control-board"
        style={{
          flex: 1,
          minHeight: 0,
          display: isMobile ? "flex" : "grid",
          flexDirection: isMobile ? "column" : undefined,
          gridTemplateColumns: isMobile ? undefined : "repeat(5, minmax(0, 1fr))",
          gap: isMobile ? 0 : 14,
          padding: isMobile ? 12 : 16,
          overflowX: isMobile ? "hidden" : "auto",
          overflowY: "hidden",
        }}
      >
        {visibleLanes.map((lane) => (
          <MissionLane
            key={lane.id}
            id={lane.id}
            title={lane.title}
            icon={lane.icon}
            accent={lane.accent}
            count={laneCount[lane.id]}
            urgent={lane.urgent}
          >
            <LaneBody
              id={lane.id}
              assistantId={assistantId}
              validConversationIds={validConversationIds}
            />
          </MissionLane>
        ))}
      </div>
    </div>
  );
}
