/**
 * Mv3MissionDetail — round-4 frame 58: the mobile rendering of
 * /assistant/hq/:id (a standing goal — read + pause). Desktop keeps the
 * two-column mission page untouched; HqPage's MissionDetailPage branches
 * here on mobile.
 *
 * Grammar (spec-verbatim, docs/design/mobile-round4 #f58):
 *   ‹ HQ → "MISSION · ON TRACK" mono microlabel → title 27/700 → the charter
 *   in quotes (agent grammar) → owning agent + cadence on one line + a quiet
 *   ‖ Pause chip (resume swaps to ▶ blue) → "WORK UNDER THIS MISSION ·
 *   ACROSS N PROJECTS" rows keeping the taxonomy states incl. the new
 *   ○ parked dashed ring and the 4.1 queued solid faint-blue ring ("will run
 *   on its own" vs parked's "waiting for you") → "RECENT SWEEPS" honest
 *   about "no action" days.
 *
 * HONESTY NOTES (deviations from the drawn frame, all data-bound):
 *   · cadence renders "sweeps daily · 8:00 AM" from the mission's REAL
 *     `sweepAt` clock (daemon migration 309; new missions default 08:00).
 *     Legacy rows without a clock keep the clock-less "sweeps daily" —
 *     still nothing fabricated.
 *   · the owning agent comes from real work-item attribution (assignee →
 *     roster); with nothing attributable the line reads "Cue runs it".
 *   · Pause is REAL — the same mission PATCH (status paused/active) the
 *     desktop page drives.
 *   · sweeps derive from the mission event feed; with no events the section
 *     is omitted rather than invented.
 *   · the frame's ⋯ overflow is omitted — this surface is read + pause only
 *     (alpha) and there are no menu actions to put behind it.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { goBackWithFallback } from "@/domains/chat/utils/conversation-navigation";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useCharters } from "@/pages/hq-agents/charters";
import {
  useHqWorkItems,
  useMission,
  useMissionEvents,
  usePatchMission,
  type HqWorkItem,
} from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { AuroraBackdrop } from "../aurora-backdrop";
import { cardBody, mv3Mono } from "../mv3-kit";
import { isParked, BackRow, LivePulseBadge, sectionMicro } from "../work-kit";
import {
  cadenceLine,
  missionStatusLabel,
  owningAgent,
  sweepsFromEvents,
  type SweepRow,
} from "./mission-kit";

type RowState = "running" | "review" | "parked" | "queued";

/** Taxonomy state for a mission work row (running > review > parked > queued). */
function rowState(item: HqWorkItem): RowState {
  if (item.status === "running") return "running";
  if (item.status === "awaiting_review") return "review";
  if (isParked(item)) return "parked";
  return "queued";
}

const STATE_SUB: Record<RowState, string> = {
  running: "running now",
  review: "ready for review",
  parked: "parked — waiting for ▶",
  queued: "queued — runs next, no ▶ needed",
};

/** The 22px leading state tile per taxonomy (incl. the ○ parked dashed ring). */
function StateTile({ state }: { state: RowState }) {
  if (state === "running") return <LivePulseBadge size={22} />;
  if (state === "review") {
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          background: "color-mix(in srgb, var(--mv3-violet) 16%, transparent)",
          color: "var(--mv3-violet)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        ◱
      </span>
    );
  }
  if (state === "parked") {
    // ○ parked (round-4 README): 12px circle, 1.5px DASHED faint ring, no
    // fill — deliberately colorless, no state color spent on "waiting".
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          background: "color-mix(in srgb, var(--mv3-faint) 8%, transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border:
              "1.5px dashed color-mix(in srgb, var(--mv3-faint) 70%, transparent)",
          }}
        />
      </span>
    );
  }
  // Queued (round-4.1, frame 58): solid hollow ring in faint blue — visibly
  // "will run on its own", vs parked's dashed mono "waiting for you".
  // Drawn 1.5px solid rgba(127,163,242,.55); --mv3-micro is that exact blue
  // in dark and re-tones to the AA blue in light (no new colors this round).
  return (
    <span
      aria-hidden
      data-state-tile="queued"
      style={{
        width: 22,
        height: 22,
        borderRadius: 7,
        background: "color-mix(in srgb, var(--mv3-faint) 8%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          border:
            "1.5px solid color-mix(in srgb, var(--mv3-micro) 55%, transparent)",
        }}
      />
    </span>
  );
}

function WorkRow({
  item,
  projectTitle,
  onOpen,
}: {
  item: HqWorkItem;
  projectTitle: string | null;
  onOpen: () => void;
}) {
  const state = rowState(item);
  const dim = state === "parked" || state === "queued";
  return (
    <button
      type="button"
      className="cue-pressable"
      aria-label={`Work item: ${item.title}`}
      onClick={onOpen}
      style={{
        background: "var(--mv3-card)",
        border:
          state === "review"
            ? "1px solid color-mix(in srgb, var(--mv3-violet) 30%, transparent)"
            : "1px solid var(--mv3-card-border)",
        borderRadius: 16,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        textAlign: "left",
        color: "inherit",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <StateTile state={state} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13.5,
            fontWeight: dim ? 400 : 600,
            color: dim ? "var(--mv3-muted)" : "var(--mv3-text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            color: dim ? "var(--mv3-faint)" : "var(--mv3-muted)",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {[projectTitle ?? "unfiled", STATE_SUB[state]].join(" · ")}
        </span>
      </span>
      <span aria-hidden style={{ color: "var(--mv3-faint)", flexShrink: 0 }}>
        ›
      </span>
    </button>
  );
}

const SWEEP_TONE: Record<
  SweepRow["tone"],
  { glyph: string; color: string; textColor: string }
> = {
  ok: { glyph: "✓", color: "var(--mv3-green)", textColor: "var(--mv3-text)" },
  quiet: {
    glyph: "✓",
    color: "var(--mv3-green)",
    textColor: "var(--mv3-muted)",
  },
  attention: {
    glyph: "‖",
    color: "var(--mv3-amber)",
    textColor: "var(--mv3-text)",
  },
  error: {
    glyph: "✕",
    color: "var(--mv3-fail-text)",
    textColor: "var(--mv3-text)",
  },
};

export function Mv3MissionDetail({ missionId }: { missionId: string }) {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);

  const { mission, isLoading, isError } = useMission(assistantId, missionId);
  const { events } = useMissionEvents(assistantId, missionId);
  const charters = useCharters(assistantId);
  const running = useHqWorkItems(assistantId, "running");
  const pending = useHqWorkItems(assistantId, "pending");
  const review = useHqWorkItems(assistantId, "awaiting_review");
  const patch = usePatchMission(assistantId);

  const linked = useMemo(
    () => new Map((mission?.rollup.projects ?? []).map((p) => [p.id, p.title])),
    [mission],
  );

  // Work under this mission = open items filed into its linked projects,
  // running first, then review, then parked/queued.
  const items = useMemo(() => {
    const all = [...running.items, ...review.items, ...pending.items].filter(
      (i) => i.projectId != null && linked.has(i.projectId),
    );
    const order: Record<RowState, number> = {
      running: 0,
      review: 1,
      parked: 2,
      queued: 3,
    };
    return all.sort(
      (a, b) =>
        order[rowState(a)] - order[rowState(b)] || b.updatedAt - a.updatedAt,
    );
  }, [running.items, review.items, pending.items, linked]);

  const agent = useMemo(() => owningAgent(items, charters), [items, charters]);
  const sweeps = useMemo(() => sweepsFromEvents(events), [events]);
  const projectCount = useMemo(
    () => new Set(items.map((i) => i.projectId)).size,
    [items],
  );

  const back = () => {
    haptic.light();
    goBackWithFallback(navigate, routes.hq);
  };

  const shell = (children: React.ReactNode) => (
    <div
      data-mv3
      data-slot="mv3-mission-detail"
      style={{
        position: "relative",
        height: "100%",
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <AuroraBackdrop />
      <BackRow label="HQ" onBack={back} />
      {children}
    </div>
  );

  if (isLoading && !mission) {
    return shell(
      <div style={{ padding: "8px 22px", position: "relative", zIndex: 2 }}>
        {[92, 200, 64].map((h, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              height: h,
              borderRadius: 16,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-line)",
              opacity: 0.55,
              marginBottom: 10,
            }}
          />
        ))}
      </div>,
    );
  }

  if (isError || !mission) {
    return shell(
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 32px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ ...cardBody, textAlign: "center", fontSize: 14 }}>
          Couldn&rsquo;t load this mission — it may have been archived.{" "}
          <button
            type="button"
            onClick={back}
            style={{
              color: "var(--mv3-micro)",
              background: "none",
              border: "none",
              padding: 0,
              fontSize: 14,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Back to HQ ›
          </button>
        </div>
      </div>,
    );
  }

  const status = missionStatusLabel(mission);
  const statusColor =
    status.tone === "on_track"
      ? "var(--mv3-micro)"
      : status.tone === "achieved"
        ? "var(--mv3-green)"
        : status.tone === "blocked"
          ? "var(--mv3-fail-text)"
          : "var(--mv3-amber)";
  const paused = mission.status === "paused";
  const charter = (mission.brief ?? mission.outcome).trim();

  const togglePause = () => {
    haptic.medium();
    patch.mutate({
      path: { assistant_id: assistantId, id: mission.id },
      body: { status: paused ? "active" : "paused" },
    });
  };

  const openItem = (item: HqWorkItem) => {
    haptic.light();
    const state = rowState(item);
    if (state === "running") navigate(routes.workLive(item.id));
    else if (state === "review")
      navigate(`${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`);
    else navigate(routes.allWork);
  };

  return shell(
    <>
      {/* Header block — status, title, charter, agent + cadence + pause. */}
      <div
        style={{
          padding: "2px 22px 12px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          style={{
            fontFamily: mv3Mono,
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: statusColor,
          }}
        >
          {status.text}
        </div>
        <div
          style={{
            fontSize: 27,
            fontWeight: 700,
            letterSpacing: "-0.7px",
            marginTop: 6,
            lineHeight: 1.15,
          }}
        >
          {mission.title}
        </div>
        {charter ? (
          // The charter in quotes — agent grammar (frame 58).
          <div
            style={{
              background: "color-mix(in srgb, var(--mv3-text) 5%, transparent)",
              borderRadius: 13,
              padding: "10px 13px",
              marginTop: 10,
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.55,
              fontStyle: "italic",
            }}
          >
            &ldquo;{charter}&rdquo;
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 11,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              minWidth: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: 7,
                background: "var(--mv3-violet-fill)",
                color: "#fff",
                fontSize: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {agent?.emoji ?? "◆"}
            </span>
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {agent ? `${agent.name} runs it` : "Cue runs it"}
            </span>
          </span>
          <span
            style={{
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              flexShrink: 0,
            }}
          >
            · {cadenceLine(mission.cadence, mission.sweepAt)}
          </span>
          {/* Quiet pause chip — REAL mission PATCH; resume swaps to ▶ blue.
              Drawn ~26px, ≥44pt hit target via padding + negative margin. */}
          <button
            type="button"
            className="cue-pressable"
            disabled={patch.isPending}
            aria-label={paused ? "Resume this mission" : "Pause this mission"}
            onClick={togglePause}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              padding: "9px 0 9px 9px",
              margin: "-9px 0",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
              opacity: patch.isPending ? 0.6 : 1,
            }}
          >
            <span
              style={{
                display: "inline-block",
                fontSize: 12,
                color: paused ? "var(--mv3-micro)" : "var(--mv3-muted)",
                border: paused
                  ? "1px solid color-mix(in srgb, var(--mv3-accent) 45%, transparent)"
                  : "1px solid var(--mv3-line)",
                borderRadius: 99,
                padding: "5px 13px",
              }}
            >
              {patch.isPending ? "…" : paused ? "▶ Resume" : "⏸ Pause"}
            </span>
          </button>
        </div>
      </div>

      {/* Scrolling body — work rows + sweeps. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "0 16px 16px",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ ...sectionMicro, padding: "2px 4px" }}>
            Work under this mission
            {projectCount > 0
              ? projectCount === 1
                ? " · in 1 project"
                : ` · across ${projectCount} projects`
              : ""}
          </div>
          {items.length === 0 ? (
            <div style={{ ...cardBody, padding: "2px 4px" }}>
              Nothing queued under this mission right now — its next sweep can
              change that.
            </div>
          ) : (
            items.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                projectTitle={
                  item.projectId ? (linked.get(item.projectId) ?? null) : null
                }
                onOpen={() => openItem(item)}
              />
            ))
          )}

          {/* RECENT SWEEPS — omitted entirely when the event feed is empty
              (no fabricated history). */}
          {sweeps.length > 0 ? (
            <>
              <div style={{ ...sectionMicro, padding: "8px 4px 2px" }}>
                Recent sweeps
              </div>
              <div
                style={{
                  background:
                    "color-mix(in srgb, var(--mv3-card) 70%, transparent)",
                  border: "1px solid var(--mv3-line)",
                  borderRadius: 16,
                  overflow: "hidden",
                }}
              >
                {sweeps.map((s, i) => {
                  const tone = SWEEP_TONE[s.tone];
                  return (
                    <div
                      key={s.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "11px 14px",
                        borderBottom:
                          i < sweeps.length - 1
                            ? "1px solid var(--mv3-line)"
                            : "none",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{ color: tone.color, fontSize: 11 }}
                      >
                        {tone.glyph}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          flex: 1,
                          color: tone.textColor,
                        }}
                      >
                        {s.dayLabel} — {s.summary}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>,
  );
}
