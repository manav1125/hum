/**
 * Project detail — the cowork board for one project.
 *
 * Structure:
 *   - a header carrying the emoji / title / category, colored by the project,
 *   - an INLINE-EDITABLE "Context brief" — the field that gives Cue its context
 *     for every task in this project (PATCH /projects/:id context),
 *   - a quick-add row that files a new task straight into this project,
 *   - the work board: four status lanes (Queued → Running → Review → Done),
 *     rendered as columns on desktop and stacked groups on mobile,
 *   - a task drawer that opens on row click.
 */

import { ArrowLeft, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DueChip } from "@/domains/activity/due-chip";
import { C, mono, relativeTime, serif } from "@/domains/activity/theme";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

import type { BoardItem } from "./board-item";
import { BOARD_LANES, categoryLabel, laneForStatus } from "./project-kit";
import { ProjectBrief } from "./project-brief";
import { TaskDrawer } from "./task-drawer";
import { useQuickAddTask } from "./use-quick-add";
import { useProject, useProjects, useProjectWorkItems } from "./use-projects";

function TaskCard({
  item,
  accent,
  onOpen,
}: {
  item: BoardItem;
  accent: string;
  onOpen: () => void;
}) {
  const assignee =
    item.assignee && item.assignee !== "cue" ? item.assignee : null;
  const source = item.sourceType;
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
        padding: "11px 12px",
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${accent}`,
        background: C.surface,
        cursor: "pointer",
        display: "grid",
        gap: 8,
      }}
    >
      <div
        style={{ fontSize: 13, fontWeight: 500, color: C.t1, lineHeight: 1.3 }}
      >
        {item.title}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          flexWrap: "wrap",
        }}
      >
        <DueChip dueAt={item.dueAt} status={item.status} />
        {source ? (
          <span
            style={{
              fontFamily: mono,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: C.t3,
              border: `1px solid ${C.line}`,
              borderRadius: 5,
              padding: "1px 6px",
            }}
          >
            {source}
          </span>
        ) : null}
        {assignee ? (
          <span style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}>
            @{assignee}
          </span>
        ) : null}
        {item.lastActivityAt ? (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
            }}
          >
            {relativeTime(item.lastActivityAt)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ProjectDetailPage() {
  const assistantId = useActiveAssistantId();
  const { projectId = "" } = useParams();
  useActivitySync(assistantId, true);
  const isNarrow = useIsMobile();

  const { project } = useProject(assistantId, projectId);
  const { projects } = useProjects(assistantId);
  const { items, isLoading } = useProjectWorkItems(assistantId, projectId);
  const quickAdd = useQuickAddTask(assistantId, projectId);

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

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
    quickAdd.mutate(
      {
        path: { assistant_id: assistantId },
        body: { title, if_exists: "create_duplicate" },
      },
      {
        onSettled: () => {
          setDraft("");
          setAdding(false);
        },
      },
    );
  };

  const accentColor = project?.color ?? C.violet;

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div
        style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 22px 60px" }}
      >
        <Link
          to={routes.projects}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: mono,
            fontSize: 11.5,
            color: C.t3,
            textDecoration: "none",
            marginBottom: 16,
          }}
        >
          <ArrowLeft size={12} /> All projects
        </Link>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <span
            aria-hidden
            style={{
              width: 46,
              height: 46,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              fontSize: 24,
              flexShrink: 0,
              background: project?.color
                ? `color-mix(in srgb, ${project.color} 18%, ${C.sunken})`
                : C.sunken,
              border: `1px solid ${
                project?.color
                  ? `color-mix(in srgb, ${project.color} 44%, ${C.line})`
                  : C.line
              }`,
            }}
          >
            {project?.emoji ?? "📁"}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontFamily: serif,
                fontSize: 30,
                letterSpacing: "-0.5px",
                color: C.ink,
                lineHeight: 1.05,
              }}
            >
              {project?.title ?? "…"}
            </div>
            {project ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: C.t2,
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${accentColor} 30%, transparent)`,
                  }}
                >
                  {categoryLabel(project.category)}
                </span>
                {project.stats ? (
                  <span
                    style={{ fontFamily: mono, fontSize: 11.5, color: C.t3 }}
                  >
                    {project.stats.counts.open} open ·{" "}
                    {project.stats.counts.done} done
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Inline-editable context brief — the crux of the cowork model */}
        {project ? (
          <ProjectBrief
            assistantId={assistantId}
            projectId={projectId}
            initial={project.context}
            accent={accentColor}
          />
        ) : null}

        {/* Quick add */}
        <div style={{ margin: "20px 0 6px" }}>
          {adding ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "10px 12px",
                border: `1px solid ${C.line2}`,
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
                  if (e.key === "Escape") {
                    setDraft("");
                    setAdding(false);
                  }
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
                  fontFamily: mono,
                  fontSize: 11.5,
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
          ) : (
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
          )}
        </div>

        {/* Board */}
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
              marginTop: 18,
              display: "grid",
              gap: 14,
              gridTemplateColumns: isNarrow ? "1fr" : "repeat(4, 1fr)",
              alignItems: "start",
            }}
          >
            {BOARD_LANES.map((lane) => {
              const laneItems = byLane[lane.key];
              return (
                <div key={lane.key} style={{ display: "grid", gap: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      fontFamily: mono,
                      fontSize: 11,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: lane.accent,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: lane.accent,
                      }}
                    />
                    {lane.label}
                    <span style={{ color: C.t3 }}>{laneItems.length}</span>
                  </div>
                  {laneItems.length === 0 ? (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: C.t3,
                        padding: "8px 2px",
                        opacity: 0.7,
                      }}
                    >
                      —
                    </div>
                  ) : (
                    laneItems.map((it) => (
                      <TaskCard
                        key={it.id}
                        item={it}
                        accent={lane.accent}
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
    </div>
  );
}
