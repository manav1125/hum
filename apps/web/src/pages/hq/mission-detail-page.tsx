/**
 * Mission detail — scope into one ring and see the work.
 *
 * Hero: the outcome + honest status ring + horizon, on the dark gradient card.
 * Left column: inline-editable brief ("the why") and initiatives (linked
 * projects, rendered with the existing ProjectCard + a link-project affordance).
 * Right rail: mission-scoped Needs-you, the budget module (spent/cap bar),
 * cadence + mode controls (workspace default badge + override), and the
 * humanized activity feed from mission events. "Run a cycle now" drives
 * POST /missions/:id/run-cycle with a loading state and refresh.
 */

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { relativeTime } from "@/domains/activity/theme";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useMobileLayout } from "@/hooks/use-is-mobile";
import { Mv3MissionDetail } from "@/mobile-v3/mission/mission-detail-page";
import { ProjectCard } from "@/pages/projects/projects-page";
import { useProjects } from "@/pages/projects/use-projects";
import { routes } from "@/utils/routes";

import {
  C,
  HERO_GRADIENT,
  HqStyle,
  MicroLabel,
  MODE_META,
  RING_META,
  fmtCents,
  horizonLabel,
  mono,
  serif,
} from "./hq-kit";
import { DriftNudge, driftFromEvents } from "./drift-nudge";
import { MissionDetailSkeleton } from "./hq-modules";
import {
  AchievedCelebration,
  buildAchievedShareText,
  PausedState,
} from "./mission-lifecycle";
import { useMissionAchievedSummary } from "./use-mission-lifecycle";
import {
  humanizeEvent,
  ringStatusFor,
  useCompanyProfile,
  useHqWorkItems,
  useLinkProject,
  useMission,
  useMissionEvents,
  usePatchMission,
  useRunCycle,
  type WorkspaceMode,
} from "./use-missions";

export function MissionDetailPage() {
  const assistantId = useActiveAssistantId();
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useMobileLayout();
  useActivitySync(assistantId, true);

  const { mission, isLoading, isError } = useMission(assistantId, id);
  const { events } = useMissionEvents(assistantId, id);
  const { projects } = useProjects(assistantId);
  const { profile } = useCompanyProfile(assistantId);
  const review = useHqWorkItems(assistantId, "awaiting_review");
  const patch = usePatchMission(assistantId);
  const runCycle = useRunCycle(assistantId);
  const linker = useLinkProject(assistantId);

  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [cycleNote, setCycleNote] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  const achieved = useMissionAchievedSummary(
    assistantId,
    id,
    mission?.status === "achieved",
  );

  const linkedIds = useMemo(
    () => new Set((mission?.rollup.projects ?? []).map((p) => p.id)),
    [mission],
  );

  // MOBILE → the round-4 frame 58 native mission surface (read + pause).
  // Placed after every hook above so the hook order stays stable across a
  // resize; desktop below is untouched.
  if (isMobile) {
    return <Mv3MissionDetail missionId={id} />;
  }
  const initiatives = projects.filter((p) => linkedIds.has(p.id));
  const linkable = projects.filter(
    (p) => p.status === "active" && !linkedIds.has(p.id),
  );
  const missionReview = review.items.filter(
    (item) => item.projectId != null && linkedIds.has(item.projectId),
  );

  if (isLoading && !mission) {
    // R5·A5 frame 3 — structure first, shimmer where the data goes.
    return (
      <Shell>
        <MissionDetailSkeleton />
      </Shell>
    );
  }
  if (isError || !mission) {
    return (
      <Shell>
        <div style={{ fontSize: 13, color: C.t2 }}>
          Couldn&rsquo;t load this mission.{" "}
          <Link to={routes.hq} style={{ color: C.blueS }}>
            Back to HQ ›
          </Link>
        </div>
      </Shell>
    );
  }

  const backLink = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontSize: 12.5,
        color: C.t2,
        marginBottom: 16,
      }}
    >
      <Link to={routes.hq} style={{ color: C.t2, textDecoration: "none" }}>
        ‹ HQ
      </Link>
      <span aria-hidden style={{ color: C.line2 }}>
        /
      </span>
      <span style={{ color: C.ink, fontWeight: 500 }}>{mission.title}</span>
    </div>
  );

  // ── §6 · ACHIEVED — the celebration receipt, made to share ─────────────
  if (mission.status === "achieved") {
    const doShare = () => {
      const text = buildAchievedShareText({
        title: mission.title,
        outcome: mission.outcome,
        summary: achieved.summary,
        spentCents: mission.spentCents,
      });
      void navigator.clipboard?.writeText(text).catch(() => {});
      setShared(true);
      setTimeout(() => setShared(false), 2500);
    };
    return (
      <Shell>
        {backLink}
        <AchievedCelebration
          title={mission.title}
          outcome={mission.outcome}
          summary={achieved.summary}
          spentCents={mission.spentCents}
          onShare={doShare}
          shared={shared}
        />
      </Shell>
    );
  }

  // ── §6 · PAUSED — calm & reversible ────────────────────────────────────
  if (mission.status === "paused") {
    const budgetStopped =
      mission.budgetCents != null &&
      mission.budgetCents > 0 &&
      mission.spentCents >= mission.budgetCents;
    return (
      <Shell>
        {backLink}
        <PausedState
          title={mission.title}
          pausedAt={mission.updatedAt}
          reason={
            budgetStopped ? "paused at the budget ceiling" : "paused by you"
          }
          busy={patch.isPending}
          onResume={() =>
            patch.mutate({
              path: { assistant_id: assistantId, id: mission.id },
              body: { status: "active" },
            })
          }
          onArchive={() =>
            patch.mutate({
              path: { assistant_id: assistantId, id: mission.id },
              body: { status: "abandoned" },
            })
          }
        />
      </Shell>
    );
  }

  const drift = driftFromEvents(events);
  const status = ringStatusFor(mission);
  const horizon = horizonLabel(mission.horizon);
  const workspaceMode: WorkspaceMode = profile?.workspaceMode ?? "assist";
  const effectiveMode = mission.mode ?? workspaceMode;
  const budgetPct =
    mission.budgetCents != null && mission.budgetCents > 0
      ? Math.min(
          100,
          Math.round((mission.spentCents / mission.budgetCents) * 100),
        )
      : null;

  const doRunCycle = () => {
    setCycleNote(null);
    runCycle.mutate(
      { path: { assistant_id: assistantId, id: mission.id } },
      {
        onSuccess: (res) => {
          setCycleNote(
            res.ran
              ? `Cycle started${res.enqueued > 0 ? ` — ${res.enqueued} item${res.enqueued === 1 ? "" : "s"} queued` : ""}.`
              : `Didn't run: ${res.reason}`,
          );
        },
        onError: () => setCycleNote("Couldn't start a cycle — try again."),
      },
    );
  };

  return (
    <Shell>
      {backLink}

      {/* HERO */}
      <div
        data-slot="hq-detail-hero"
        style={{
          display: "flex",
          gap: 22,
          alignItems: "center",
          background: HERO_GRADIENT,
          borderRadius: 16,
          padding: "22px 26px",
          color: "#fff",
        }}
      >
        <DarkStatusRing status={status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color:
                status === "on_track"
                  ? "rgba(255,255,255,.55)"
                  : RING_META[status].color,
            }}
          >
            {horizon ? `Target: ${horizon} · ` : ""}
            {RING_META[status].label}
          </div>
          <div
            style={{
              fontFamily: serif,
              fontSize: 25,
              lineHeight: 1.1,
              marginTop: 5,
            }}
          >
            {mission.title}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,.75)",
              marginTop: 6,
            }}
          >
            {mission.outcome}
          </div>
          {/* continuationSummary is the orchestrator's state doc (markdown
              boilerplate), not display copy — the humanized activity feed on
              the rail carries "what happened" instead. */}
        </div>
        <div
          style={{
            alignSelf: "flex-start",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={doRunCycle}
            disabled={runCycle.isPending}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              background: "rgba(255,255,255,.12)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,.18)",
              borderRadius: 10,
              padding: "9px 14px",
              cursor: runCycle.isPending ? "default" : "pointer",
              opacity: runCycle.isPending ? 0.7 : 1,
            }}
          >
            {runCycle.isPending ? "◌ Running…" : "▸ Run a cycle now"}
          </button>
          {mission.lastCycleAt != null ? (
            <span
              style={{
                fontFamily: mono,
                fontSize: 9.5,
                color: "rgba(255,255,255,.5)",
              }}
            >
              last cycle {relativeTime(mission.lastCycleAt)}
            </span>
          ) : null}
        </div>
      </div>
      {cycleNote ? (
        <div
          role="status"
          style={{
            marginTop: 10,
            fontSize: 12.5,
            fontFamily: mono,
            color: cycleNote.startsWith("Cycle") ? C.green : C.amber,
          }}
        >
          {cycleNote}
        </div>
      ) : null}

      {/* BODY: main column + rail */}
      <div
        data-slot="hq-columns"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: 22,
          marginTop: 22,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {/* Brief — inline editable */}
          <MicroLabel style={{ marginBottom: 10 }}>Brief · the why</MicroLabel>
          <BriefEditor
            key={`${mission.id}:${mission.brief ?? ""}`}
            brief={mission.brief}
            saving={patch.isPending}
            onSave={(next) =>
              patch.mutate({
                path: { assistant_id: assistantId, id: mission.id },
                body: { brief: next.trim() ? next.trim() : null },
              })
            }
          />

          {/* Initiatives */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              margin: "22px 0 11px",
            }}
          >
            <MicroLabel>Initiatives · {initiatives.length}</MicroLabel>
            {linkable.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowLinkPicker((v) => !v)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.blueS,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Plus size={12} /> Link a project
              </button>
            ) : null}
          </div>
          {showLinkPicker ? (
            <div
              style={{
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                padding: 10,
                marginBottom: 12,
                background: C.surface,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {linkable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={linker.isPending}
                  onClick={() =>
                    linker.link(p.id, mission.id, {
                      onSettled: () => setShowLinkPicker(false),
                    })
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    fontSize: 13,
                    color: C.ink,
                    background: "transparent",
                    border: "none",
                    borderRadius: 7,
                    padding: "7px 8px",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span aria-hidden>{p.emoji ?? "📁"}</span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.title}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontFamily: mono,
                      fontSize: 10,
                      color: C.blueS,
                    }}
                  >
                    link ›
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {initiatives.length === 0 ? (
            <div
              style={{
                border: `1px dashed ${C.line2}`,
                borderRadius: 14,
                padding: "26px 18px",
                textAlign: "center",
                fontSize: 13,
                color: C.t3,
                background: C.surface,
              }}
            >
              No initiatives yet — link a project and its work rolls up to this
              ring.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 12,
              }}
            >
              {initiatives.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={() => navigate(routes.project(p.id))}
                />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT RAIL */}
        <div style={{ minWidth: 0 }}>
          {/* §6 · Drifting nudge — idling with nothing to run */}
          {drift ? (
            <div style={{ marginBottom: 14 }}>
              <DriftNudge
                title={mission.title}
                metric={mission.metric ?? mission.title}
                idleCycles={drift.idleCycles}
                busy={runCycle.isPending || patch.isPending}
                onReplan={doRunCycle}
                onStepIn={() =>
                  navigate(
                    `${routes.home}?focus=${encodeURIComponent(mission.id)}`,
                  )
                }
                onPause={() =>
                  patch.mutate({
                    path: { assistant_id: assistantId, id: mission.id },
                    body: { status: "paused" },
                  })
                }
              />
            </div>
          ) : null}

          {/* Mission-scoped needs-you */}
          {missionReview.length > 0 ? (
            <div
              style={{
                background: `color-mix(in srgb, ${C.amber} 7%, ${C.surface})`,
                border: `1px solid color-mix(in srgb, ${C.amber} 38%, ${C.line})`,
                borderRadius: 13,
                padding: 15,
                marginBottom: 14,
              }}
            >
              <MicroLabel color={C.amber}>
                Needs you · in this mission
              </MicroLabel>
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 9,
                }}
              >
                {missionReview.slice(0, 4).map((item) => (
                  <div
                    key={item.id}
                    style={{ display: "flex", gap: 9, alignItems: "center" }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: C.ink,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.title}
                      </div>
                      <div style={{ fontSize: 11, color: C.t2 }}>
                        ready {relativeTime(item.updatedAt) ?? ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        item.lastRunConversationId
                          ? navigate(
                              routes.conversation(item.lastRunConversationId),
                            )
                          : navigate(
                              `${routes.home}?focus=${encodeURIComponent(item.id)}`,
                            )
                      }
                      style={{
                        fontSize: 11,
                        background: C.blue,
                        color: "#fff",
                        border: "none",
                        borderRadius: 7,
                        padding: "5px 10px",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      Review
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Budget module */}
          <div
            style={{
              background: C.sunken,
              borderRadius: 13,
              padding: 15,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <MicroLabel>Budget · this mission</MicroLabel>
              <span style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}>
                {fmtCents(mission.spentCents)}
                {mission.budgetCents != null
                  ? ` / ${fmtCents(mission.budgetCents)}`
                  : ""}
              </span>
            </div>
            {budgetPct != null ? (
              <div
                style={{
                  height: 7,
                  borderRadius: 4,
                  background: `color-mix(in srgb, ${C.t3} 22%, transparent)`,
                  marginTop: 9,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${budgetPct}%`,
                    background:
                      budgetPct >= 100
                        ? C.danger
                        : budgetPct >= 80
                          ? `linear-gradient(90deg, ${C.blue}, ${C.amber})`
                          : C.blue,
                    borderRadius: 4,
                    transition: "width 240ms",
                  }}
                />
              </div>
            ) : null}
            <div style={{ fontSize: 11, color: C.t3, marginTop: 8 }}>
              {mission.budgetCents != null
                ? budgetPct != null && budgetPct >= 100
                  ? "At the ceiling — Cue stopped instead of overrunning."
                  : "Model compute + tool calls · caps itself at the ceiling."
                : "No ceiling set — spend is logged either way."}
            </div>
          </div>

          {/* Cadence & autonomy */}
          <div
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 13,
              padding: 15,
              marginTop: 11,
              background: C.surface,
            }}
          >
            <MicroLabel style={{ marginBottom: 10 }}>
              Cadence &amp; autonomy
            </MicroLabel>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12.5,
              }}
            >
              <span style={{ color: C.t2 }}>Check-in</span>
              <select
                value={mission.cadence ?? "daily"}
                onChange={(e) =>
                  patch.mutate({
                    path: { assistant_id: assistantId, id: mission.id },
                    body: {
                      cadence: e.target.value as "hourly" | "daily" | "weekly",
                    },
                  })
                }
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: C.ink,
                  background: C.surface,
                  border: `1px solid ${C.line}`,
                  borderRadius: 7,
                  padding: "4px 6px",
                  cursor: "pointer",
                }}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div style={{ height: 1, background: C.line, margin: "10px 0" }} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12.5,
              }}
            >
              <span style={{ color: C.t2 }}>This mission runs</span>
              <select
                value={mission.mode ?? "__default"}
                onChange={(e) =>
                  patch.mutate({
                    path: { assistant_id: assistantId, id: mission.id },
                    body: {
                      mode:
                        e.target.value === "__default"
                          ? null
                          : (e.target.value as WorkspaceMode),
                    },
                  })
                }
                style={{
                  fontFamily: mono,
                  fontSize: 10.5,
                  color: mission.mode ? C.amber : C.blueS,
                  background: mission.mode
                    ? `color-mix(in srgb, ${C.amber} 12%, ${C.surface})`
                    : C.blueW,
                  border: "none",
                  borderRadius: 6,
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                <option value="__default">
                  {MODE_META[workspaceMode].glyph} default ·{" "}
                  {MODE_META[workspaceMode].label.toLowerCase()}
                </option>
                {(["observe", "assist", "autonomous"] as const).map((m) => (
                  <option key={m} value={m}>
                    {MODE_META[m].glyph} override ·{" "}
                    {MODE_META[m].label.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div
              style={{
                fontSize: 11,
                color: C.t3,
                marginTop: 9,
                lineHeight: 1.4,
              }}
            >
              {mission.mode
                ? `Overridden ${mission.mode === "observe" ? "below" : mission.mode === "autonomous" ? "above" : "off"} the workspace default. ${MODE_META[effectiveMode].blurb}`
                : `Uses the workspace default. ${MODE_META[effectiveMode].blurb}`}
            </div>
          </div>

          {/* Activity feed */}
          <MicroLabel style={{ margin: "18px 0 9px" }}>Activity</MicroLabel>
          {events.length === 0 ? (
            <div style={{ fontSize: 12, color: C.t3 }}>
              Nothing yet — run a cycle and the trail starts here.
            </div>
          ) : (
            <div
              style={{
                borderLeft: `2px solid ${C.line}`,
                paddingLeft: 14,
                display: "flex",
                flexDirection: "column",
                gap: 13,
              }}
            >
              {events.slice(0, 14).map((e) => {
                const h = humanizeEvent(e);
                return (
                  <div key={e.id} style={{ position: "relative" }}>
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: -21,
                        top: 3,
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: h.color,
                        boxShadow: `0 0 0 3px ${C.bg}`,
                      }}
                    />
                    <div
                      style={{ fontSize: 12.5, fontWeight: 500, color: C.ink }}
                    >
                      {h.title}
                    </div>
                    <div style={{ fontSize: 11, color: C.t3 }}>
                      {relativeTime(e.at)}
                      {h.detail ? ` · ${h.detail}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <HqStyle />
      <div
        data-slot="hq-page-pad"
        style={{ maxWidth: 1100, margin: "0 auto", padding: "26px 24px 60px" }}
      >
        {children}
      </div>
    </div>
  );
}

/** Big status ring for the dark hero (track reads on the gradient). */
function DarkStatusRing({
  status,
}: {
  status: "on_track" | "needs_you" | "blocked";
}) {
  const meta = RING_META[status];
  const size = 104;
  const stroke = 10;
  const r = size / 2 - stroke;
  return (
    <div
      role="img"
      aria-label={`Mission ${meta.label}`}
      style={{ position: "relative", width: size, height: size, flexShrink: 0 }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,.12)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={meta.color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          color: meta.color,
        }}
      >
        {meta.glyph}
      </div>
    </div>
  );
}

/** Inline-editable mission brief: click to edit, save on blur/⌘-enter. */
function BriefEditor({
  brief,
  saving,
  onSave,
}: {
  brief: string | null;
  saving: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");

  const commit = () => {
    setEditing(false);
    if (draft !== (brief ?? "")) onSave(draft);
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") setEditing(true);
        }}
        title="Click to edit the brief"
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 13,
          padding: "14px 16px",
          background: C.surface,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: brief ? C.ink : C.t3,
          cursor: "text",
          whiteSpace: "pre-wrap",
        }}
      >
        {brief ??
          "Why this mission matters — context Cue reads before every cycle. Click to write it."}
        {saving ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
              marginLeft: 8,
            }}
          >
            saving…
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <textarea
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
        if (e.key === "Escape") {
          setDraft(brief ?? "");
          setEditing(false);
        }
      }}
      rows={Math.max(3, draft.split("\n").length + 1)}
      style={{
        width: "100%",
        boxSizing: "border-box",
        border: `1.5px solid ${C.blue}`,
        borderRadius: 13,
        padding: "14px 16px",
        background: C.surface,
        fontSize: 13.5,
        lineHeight: 1.55,
        color: C.ink,
        outline: "none",
        resize: "vertical",
        fontFamily: "inherit",
      }}
    />
  );
}
