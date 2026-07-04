/**
 * Project affordances for a work-item row — a "which project?" tag and a
 * lightweight "move into a project" menu.
 *
 * Lives inside the activity domain (self-contained: it imports only the
 * generated SDK + the domain's own theme, never another domain) so the
 * command-center Review lane can show the owning project and let you file a
 * finished item into one, without reaching across the domain boundary.
 *
 * The work-item PATCH requires the full record, so `MoveToProject` re-fetches
 * the item's current row from the work-items list to assemble a complete body
 * before setting `projectId`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, FolderKanban } from "lucide-react";
import { useState } from "react";

import {
  projectsGetOptions,
  workitemsByIdPatchMutation,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "../theme";

type MiniProject = {
  id: string;
  title: string;
  emoji: string | null;
};

/** Shared project list query — deduped by react-query across every row. */
function useProjectList(assistantId: string): MiniProject[] {
  const q = useQuery({
    ...projectsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  return (q.data?.projects ?? [])
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, title: p.title, emoji: p.emoji ?? null }));
}

/** A calm "in <project>" chip; renders nothing when the item is unfiled. */
export function ProjectTag({
  assistantId,
  projectId,
}: {
  assistantId: string;
  projectId: string | null;
}) {
  const projects = useProjectList(assistantId);
  if (!projectId) return null;
  const p = projects.find((x) => x.id === projectId);
  if (!p) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: mono,
        fontSize: 10.5,
        color: C.violetS,
        background: `color-mix(in srgb, ${C.violet} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.violet} 30%, transparent)`,
        borderRadius: 6,
        padding: "2px 7px",
        whiteSpace: "nowrap",
      }}
    >
      <FolderKanban size={10} />
      {p.emoji ? `${p.emoji} ` : ""}
      {p.title}
    </span>
  );
}

/** A small "Move" button that opens a project picker and files the item. */
export function MoveToProject({
  assistantId,
  itemId,
  currentProjectId,
}: {
  assistantId: string;
  itemId: string;
  currentProjectId: string | null;
}) {
  const queryClient = useQueryClient();
  const projects = useProjectList(assistantId);
  const [open, setOpen] = useState(false);

  // We need the item's full current record to build a complete PATCH body.
  const items = useQuery({
    ...workitemsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 15_000,
    enabled: open,
  });

  const patch = useMutation({
    ...workitemsByIdPatchMutation(),
    onSettled: () => {
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey.some(
            (k) =>
              typeof k === "object" &&
              k !== null &&
              "_id" in k &&
              (String((k as { _id?: string })._id).startsWith("projects") ||
                (k as { _id?: string })._id === "workitemsGet"),
          ),
      });
      setOpen(false);
    },
  });

  const moveTo = (projectId: string | null) => {
    const row = (items.data?.items ?? []).find((i) => i.id === itemId);
    if (!row) return;
    let labels: string[] = [];
    if (row.labels) {
      try {
        const parsed = JSON.parse(row.labels) as unknown;
        if (Array.isArray(parsed))
          labels = parsed.filter((l): l is string => typeof l === "string");
      } catch {
        // ignore malformed labels
      }
    }
    patch.mutate({
      path: { assistant_id: assistantId, id: itemId },
      body: {
        title: row.title,
        notes: row.notes ?? "",
        status: row.status,
        priorityTier: row.priorityTier,
        sortIndex: row.sortIndex ?? 0,
        projectId,
        dueAt: row.dueAt,
        labels,
        assignee: row.assignee ?? "cue",
        context: row.context ?? null,
      },
    });
  };

  const options = projects.filter((p) => p.id !== currentProjectId);

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={patch.isPending}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 12,
          fontWeight: 500,
          padding: "5px 10px",
          borderRadius: 8,
          border: `1px solid ${C.line2}`,
          background: C.surface,
          color: C.t2,
          cursor: patch.isPending ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <ArrowRightLeft size={12} />
        {patch.isPending ? "Moving…" : "Move to project"}
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 20,
            minWidth: 180,
            maxHeight: 240,
            overflowY: "auto",
            background: C.surface,
            border: `1px solid ${C.line2}`,
            borderRadius: 10,
            boxShadow: "0 12px 30px -12px rgba(0,0,0,0.4)",
            padding: 4,
          }}
        >
          {options.length === 0 ? (
            <div style={{ fontSize: 12, color: C.t3, padding: "8px 10px" }}>
              No projects yet.
            </div>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => moveTo(p.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  fontSize: 13,
                  color: C.t1,
                  background: "transparent",
                  border: "none",
                  borderRadius: 7,
                  padding: "7px 9px",
                  cursor: "pointer",
                }}
              >
                <span>{p.emoji ?? "📁"}</span>
                {p.title}
              </button>
            ))
          )}
          {currentProjectId ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => moveTo(null)}
              style={{
                display: "flex",
                width: "100%",
                textAlign: "left",
                fontSize: 12.5,
                color: C.t3,
                background: "transparent",
                border: "none",
                borderTop: `1px solid ${C.line}`,
                marginTop: 4,
                paddingTop: 8,
                padding: "8px 9px 6px",
                cursor: "pointer",
              }}
            >
              Remove from project
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
