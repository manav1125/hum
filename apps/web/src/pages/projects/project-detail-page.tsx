/**
 * Project detail — the cowork board for one project, in HQ's language.
 *
 * Restyled to the locked Cue-HQ-Build Round 5 · B2 frames while keeping every
 * function: serif hero (emoji tile · serif title · mono category chip) with a
 * tappable ⟡ mission tag (→ the owning mission on HQ), the quick-add row, the
 * ring-tone status board (four lanes, one-card-language rows with source
 * badges + live progress notes), then the CONTEXT BRIEF and KNOWLEDGE
 * accent-rail panels side by side. Lanes stack on mobile; a task drawer opens
 * on row click.
 */

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { C, mono, serif } from "@/domains/activity/theme";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { HqStyle } from "@/pages/hq/hq-kit";
import { routes } from "@/utils/routes";

import { AddExistingPanel } from "./add-existing-panel";
import { Mv3ProjectDetail } from "./mv3-project-detail";
import type { BoardItem } from "./board-item";
import { ItemCard, MissionTag, statusChip, type ItemChip } from "./item-card";
import { BOARD_LANES, categoryLabel, laneForStatus } from "./project-kit";
import { ProjectBrief } from "./project-brief";
import { ProjectKnowledge } from "./project-knowledge";
import { TaskDrawer } from "./task-drawer";
import { useQuickAddTask } from "./use-quick-add";
import {
  useMissionTitles,
  useProject,
  useProjects,
  useProjectWorkItems,
} from "./use-projects";

const DAY_MS = 24 * 3_600_000;
const LIVE_STATUSES = new Set([
  "queued",
  "pending",
  "running",
  "awaiting_review",
]);

/** One board row in the one-card language (badge · title · chip · note). */
function BoardRow({
  item,
  now,
  onOpen,
}: {
  item: BoardItem;
  now: number;
  onOpen: () => void;
}) {
  const running = item.status === "running";
  const done = item.status === "done";
  const review = item.status === "awaiting_review";
  const dueSoon =
    item.dueAt != null &&
    item.dueAt <= now + DAY_MS &&
    LIVE_STATUSES.has(item.status);

  // Slot ④ — the most informative single chip for this row (the lane already
  // names the status): due pressure wins, then REVIEW.
  let chip: ItemChip | null = null;
  if (dueSoon) {
    chip = {
      label: item.dueAt! < now ? "OVERDUE" : "DUE TODAY",
      color: C.danger,
      bg: `color-mix(in srgb, ${C.danger} 10%, transparent)`,
    };
  } else if (review) {
    chip = statusChip(item.status);
  }

  // Progress/evidence line: the runner's live note while running; the
  // non-default assignee otherwise.
  const note = running
    ? {
        text: item.lastProgressNote ?? "Cue is working on this…",
        color: C.blueS,
      }
    : review
      ? { text: "ready — waits on you", color: C.amber }
      : item.assignee && item.assignee !== "cue"
        ? { text: `@${item.assignee}` }
        : null;

  return (
    <ItemCard
      sourceType={done ? null : item.sourceType}
      title={item.title}
      chip={done ? null : chip}
      note={done ? null : note}
      live={running}
      emphasis={
        done
          ? "done"
          : running
            ? "next"
            : review || dueSoon
              ? "blocked"
              : "none"
      }
      onOpen={onOpen}
    />
  );
}

/**
 * Mobile v3 gate: narrow viewports render the frame-3 native detail
 * (Mv3ProjectDetail); desktop keeps this serif board byte-identical below.
 */
export function ProjectDetailPage() {
  const isMobile = useIsMobile();
  return isMobile ? <Mv3ProjectDetail /> : <ProjectDetailPageDesktop />;
}

function ProjectDetailPageDesktop() {
  const assistantId = useActiveAssistantId();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const isNarrow = useIsMobile();

  const { project } = useProject(assistantId, projectId);
  const { projects } = useProjects(assistantId);
  const missionTitles = useMissionTitles(assistantId);
  const { items, isLoading } = useProjectWorkItems(assistantId, projectId);
  const quickAdd = useQuickAddTask(assistantId, projectId);

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [pickingExisting, setPickingExisting] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // Stable reference time for due-pressure emphasis (no Date.now() in render).
  const [now] = useState(() => Date.now());

  const byLane = useMemo(() => {
    const map: Record<string, BoardItem[]> = {
      queued: [],
      running: [],
      review: [],
      done: [],
    };
    for (const it of items) {
      const lane = laneForStatus(it.status);
      if (lane) map[lane].push(it);
    }
    return map;
  }, [items]);

  const openTask = openTaskId
    ? (items.find((i) => i.id === openTaskId) ?? null)
    : null;

  const submitAdd = () => {
    const title = draft.trim();
    if (!title || quickAdd.isPending) return;
    quickAdd.add(title, {
      // Only clear on success — on failure the draft stays put next to the
      // inline error so the user can retry without retyping.
      onSuccess: () => {
        setDraft("");
        setAdding(false);
      },
    });
  };

  const dismissAdd = () => {
    setDraft("");
    setAdding(false);
    quickAdd.reset();
  };

  const missionTitle = project?.missionId
    ? (missionTitles.get(project.missionId) ?? "Mission")
    : null;

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <HqStyle />
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: isNarrow ? "18px 16px 60px" : "24px 26px 60px",
        }}
      >
        <Link
          to={routes.projects}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: C.blueS,
            textDecoration: "none",
            marginBottom: 14,
          }}
        >
          ‹ Projects
        </Link>

        {/* Serif hero — emoji tile · serif title · mono category · ⟡ tag */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            aria-hidden
            style={{
              width: isNarrow ? 40 : 48,
              height: isNarrow ? 40 : 48,
              borderRadius: isNarrow ? 11 : 13,
              display: "grid",
              placeItems: "center",
              fontSize: isNarrow ? 19 : 23,
              flexShrink: 0,
              background: project?.color
                ? `color-mix(in srgb, ${project.color} 16%, ${C.sunken})`
                : C.sunken,
            }}
          >
            {project?.emoji ?? "📁"}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: serif,
                  fontSize: isNarrow ? 21 : 27,
                  lineHeight: 1.05,
                  color: C.ink,
                }}
              >
                {project?.title ?? "…"}
              </span>
              {project?.category ? (
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 9,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: C.t3,
                    background: C.sunken,
                    borderRadius: 6,
                    padding: "3px 8px",
                  }}
                >
                  {categoryLabel(project.category)}
                </span>
              ) : null}
              {project?.stats ? (
                <span style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}>
                  {project.stats.counts.open} open · {project.stats.counts.done}{" "}
                  done
                </span>
              ) : null}
            </div>
            {project ? (
              <div style={{ marginTop: 7 }}>
                {project.missionId ? (
                  <MissionTag
                    label={`${missionTitle} — open mission ›`}
                    onClick={() =>
                      navigate(routes.hqMission(project.missionId!))
                    }
                    style={{ fontSize: 11.5, padding: "4px 10px" }}
                  />
                ) : (
                  <MissionTag label="Standalone" linked={false} />
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* CONTEXT BRIEF + KNOWLEDGE — kept above the board so a long task
            list never buries the context the agent reads before every run. */}
        {project ? (
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gap: 12,
              gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr",
              alignItems: "start",
            }}
          >
            <ProjectBrief
              assistantId={assistantId}
              projectId={projectId}
              initial={project.context}
              accent={C.blue}
            />
            <ProjectKnowledge
              assistantId={assistantId}
              projectId={projectId}
              accent={C.violet}
            />
          </div>
        ) : null}

        {/* Quick add */}
        <div style={{ margin: "18px 0 6px" }}>
          {adding ? (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "10px 12px",
                  border: `1px solid ${quickAdd.isError ? C.danger : C.line2}`,
                  borderRadius: 10,
                  background: C.surface,
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitAdd();
                    if (e.key === "Escape") dismissAdd();
                  }}
                  placeholder="Add a task to this project…"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: 14,
                    color: C.ink,
                  }}
                />
                <button
                  type="button"
                  onClick={submitAdd}
                  disabled={quickAdd.isPending || !draft.trim()}
                  style={{
                    fontSize: 11.5,
                    fontWeight: 500,
                    padding: "5px 12px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                    background: C.ink,
                    color: C.bg,
                    opacity: quickAdd.isPending || !draft.trim() ? 0.5 : 1,
                  }}
                >
                  {quickAdd.isPending ? "Adding…" : "Add"}
                </button>
              </div>
              {quickAdd.isError ? (
                <div
                  role="alert"
                  style={{
                    marginTop: 6,
                    fontFamily: mono,
                    fontSize: 11.5,
                    color: C.danger,
                  }}
                >
                  Couldn’t add the task — nothing was saved. Try again.
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setAdding(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontFamily: mono,
                  fontSize: 12,
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: `1px solid ${C.line2}`,
                  background: "transparent",
                  color: C.t2,
                  cursor: "pointer",
                }}
              >
                <Plus size={13} /> Add task
              </button>
              <button
                type="button"
                onClick={() => setPickingExisting(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  fontFamily: mono,
                  fontSize: 12,
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: `1px solid ${C.line2}`,
                  background: "transparent",
                  color: C.t2,
                  cursor: "pointer",
                }}
              >
                Add existing ›
              </button>
            </div>
          )}
        </div>

        {/* The ring-tone status board — columns on desktop, stacked on 390 */}
        {isLoading ? (
          <div style={{ fontSize: 13, color: C.t2, marginTop: 20 }}>
            Loading the project’s work…
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              marginTop: 20,
              padding: "22px 18px",
              border: `1px dashed ${C.line2}`,
              borderRadius: 12,
              fontSize: 13,
              color: C.t3,
              lineHeight: 1.5,
            }}
          >
            Nothing filed here yet. Add a task above, or Cue files matching work
            in automatically — everything reads the brief before it runs.
          </div>
        ) : (
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gap: isNarrow ? 4 : 12,
              gridTemplateColumns: isNarrow ? "1fr" : "repeat(4, 1fr)",
              alignItems: "start",
            }}
          >
            {BOARD_LANES.map((lane) => {
              const laneItems = byLane[lane.key];
              if (isNarrow && laneItems.length === 0) return null;
              return (
                <div key={lane.key} style={{ display: "grid", gap: 8 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      margin: isNarrow ? "10px 0 0" : "0 0 1px",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: lane.accent,
                      }}
                    />
                    <span
                      style={{
                        fontFamily: mono,
                        fontSize: 9.5,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: C.t3,
                      }}
                    >
                      {lane.label} · {laneItems.length}
                    </span>
                  </div>
                  {laneItems.length === 0 ? (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: C.t3,
                        padding: "6px 2px",
                        opacity: 0.7,
                      }}
                    >
                      —
                    </div>
                  ) : (
                    laneItems.map((it) => (
                      <BoardRow
                        key={it.id}
                        item={it}
                        now={now}
                        onOpen={() => setOpenTaskId(it.id)}
                      />
                    ))
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openTask ? (
        <TaskDrawer
          assistantId={assistantId}
          item={openTask}
          projects={projects}
          currentProjectId={projectId}
          onClose={() => setOpenTaskId(null)}
        />
      ) : null}

      {pickingExisting ? (
        <AddExistingPanel
          assistantId={assistantId}
          projectId={projectId}
          onClose={() => setPickingExisting(false)}
        />
      ) : null}
    </div>
  );
}
