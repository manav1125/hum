/**
 * Projects — named containers for related work. A calm list of project cards
 * (emoji + title + live per-status tally) with inline creation. Clicking a
 * card opens the per-project lanes.
 */

import { FolderKanban, Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { GroupHeader } from "@/domains/activity/group-header";
import { C, mono, serif } from "@/domains/activity/theme";
import { useWorkItems } from "@/domains/activity/use-work-items";
import { routes } from "@/utils/routes";

import { useCreateProject, useProjects, type ProjectView } from "./use-projects";

function ProjectCard({
  project,
  tally,
}: {
  project: ProjectView;
  tally: { queued: number; running: number; review: number };
}) {
  const bits = [
    tally.queued > 0 ? `${tally.queued} queued` : null,
    tally.running > 0 ? `${tally.running} running` : null,
    tally.review > 0 ? `${tally.review} review` : null,
  ].filter(Boolean);
  return (
    <Link
      to={routes.project(project.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "16px 18px",
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        background: C.surface,
        textDecoration: "none",
        color: C.ink,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          fontSize: 17,
          background: project.color ?? C.sunken,
          border: `1px solid ${C.line}`,
          flexShrink: 0,
        }}
      >
        {project.emoji ?? "📁"}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: serif,
            fontSize: 17,
            letterSpacing: "-0.2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.title}
        </div>
        <div style={{ fontFamily: mono, fontSize: 11.5, color: C.t3, marginTop: 3 }}>
          {bits.length > 0 ? bits.join(" · ") : "nothing queued"}
        </div>
      </div>
    </Link>
  );
}

export function ProjectsPage() {
  const assistantId = useActiveAssistantId();
  const { projects, isLoading, isError } = useProjects(assistantId);
  const create = useCreateProject(assistantId);
  const [draftTitle, setDraftTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // One query for all live items; group counts client-side (dedupe-friendly —
  // the same buckets other surfaces already fetch).
  const queued = useWorkItems(assistantId, "pending");
  const running = useWorkItems(assistantId, "running");
  const review = useWorkItems(assistantId, "awaiting_review");

  const tallies = useMemo(() => {
    const map = new Map<
      string,
      { queued: number; running: number; review: number }
    >();
    const bump = (
      projectId: string | null,
      key: "queued" | "running" | "review",
    ) => {
      if (!projectId) return;
      const t = map.get(projectId) ?? { queued: 0, running: 0, review: 0 };
      t[key] += 1;
      map.set(projectId, t);
    };
    for (const i of queued.items) bump(i.projectId, "queued");
    for (const i of running.items) bump(i.projectId, "running");
    for (const i of review.items) bump(i.projectId, "review");
    return map;
  }, [queued.items, running.items, review.items]);

  const submit = () => {
    const title = draftTitle.trim();
    if (!title || create.isPending) return;
    create.mutate(
      { path: { assistant_id: assistantId }, body: { title } },
      {
        onSuccess: () => {
          setDraftTitle("");
          setCreating(false);
        },
      },
    );
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "34px 22px 60px" }}>
        <GroupHeader
          kicker="Projects"
          title="Work, grouped."
          accent={C.violet}
          hint="Every project is a container Cue can file new work into automatically."
        />

        <div style={{ display: "grid", gap: 10 }}>
          {isLoading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: C.t2,
              }}
            >
              <Loader2 className="size-4 animate-spin" /> Loading projects…
            </div>
          ) : isError ? (
            <div style={{ fontSize: 13, color: C.t2 }}>
              Couldn’t load projects just now — try again in a moment.
            </div>
          ) : (
            <>
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  tally={
                    tallies.get(p.id) ?? { queued: 0, running: 0, review: 0 }
                  }
                />
              ))}
              {projects.length === 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "14px 16px",
                    border: `1px dashed ${C.line2}`,
                    borderRadius: 12,
                    color: C.t3,
                    fontSize: 13,
                  }}
                >
                  <FolderKanban size={15} />
                  No projects yet — create one and Cue will start filing
                  matching work into it.
                </div>
              )}
            </>
          )}

          {creating ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "12px 14px",
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                background: C.surface,
              }}
            >
              <input
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Project name…"
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
                onClick={submit}
                disabled={create.isPending || !draftTitle.trim()}
                style={{
                  fontFamily: mono,
                  fontSize: 11.5,
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  background: C.ink,
                  color: C.bg,
                }}
              >
                {create.isPending ? "Creating…" : "Create"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                alignSelf: "flex-start",
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
              <Plus size={13} /> New project
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
