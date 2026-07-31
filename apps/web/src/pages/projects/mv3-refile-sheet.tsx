/**
 * Mv3RefileSheet — frame 44's "Where does this belong?" move sheet, extracted
 * from the task sheet's Filed-to grammar so every mobile surface (came-in ✨
 * "Move ›", the amber below-confidence "File ›", the task sheet's "📁 File to
 * a project") opens the identical picker.
 *
 * Frame-verbatim: title "Where does this belong?", emoji-tile project rows
 * with the current pick highlighted + "current", a dashed "＋ New project" row
 * (the EXISTING Mv3NewProjectSheet flow), and the 🧠 close "Moving teaches
 * Cue — next one files itself".
 *
 * ENDPOINT — the daemon's full-record work-item PATCH (`projectId`), the same
 * write the task sheet's Filed-to uses. The daemon clears auto-file provenance
 * on a user move (autoFiledBy → null / "user_unfiled") so the ✨ chip drops on
 * its own.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { SheetShell } from "@/mobile-v3";
import { fullPatchBody } from "@/mobile-v3/work-kit";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";

import { Mv3NewProjectSheet } from "./mv3-new-project-sheet";
import { usePatchWorkItem, type ProjectView } from "./use-projects";

export function Mv3RefileSheet({
  assistantId,
  item,
  projects,
  onClose,
  onMoved,
}: {
  assistantId: string;
  /** The task being re-filed; null keeps the sheet closed. */
  item: HqWorkItem | null;
  projects: ProjectView[];
  onClose: () => void;
  /** Fires after a successful move (before close). */
  onMoved?: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const patch = usePatchWorkItem(assistantId);
  const [newProjOpen, setNewProjOpen] = useState(false);

  if (!item) return null;

  const targets = projects.filter(
    (p) => p.status === "active" || p.id === item.projectId,
  );

  const move = (projectId: string) => {
    if (projectId === item.projectId) return;
    haptic.medium();
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: item.id },
        body: fullPatchBody(item, { projectId }),
      },
      {
        onSuccess: () => {
          haptic.success();
          void queryClient.invalidateQueries();
          onMoved?.(projectId);
          onClose();
        },
      },
    );
  };

  return (
    <>
      <SheetShell open label="Where does this belong?" onClose={onClose}>
        <div
          style={{ fontSize: 16, fontWeight: 600, color: "var(--mv3-text)" }}
        >
          Where does this belong?
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--mv3-muted)",
            marginTop: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            marginTop: 12,
          }}
        >
          {targets.map((p) => {
            const current = p.id === item.projectId;
            return (
              <button
                key={p.id}
                type="button"
                className="cue-pressable"
                disabled={current || patch.isPending}
                onClick={() => move(p.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  minHeight: 44,
                  padding: "9px 11px",
                  borderRadius: 12,
                  textAlign: "left",
                  fontFamily: "inherit",
                  cursor: current ? "default" : "pointer",
                  color: "var(--mv3-text)",
                  background: current
                    ? "color-mix(in srgb, var(--mv3-accent) 14%, transparent)"
                    : "var(--mv3-btn2-bg)",
                  border: current
                    ? "1.5px solid var(--mv3-accent)"
                    : "1px solid var(--mv3-btn2-border)",
                  opacity: patch.isPending ? 0.6 : 1,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    background: current
                      ? "var(--mv3-accent)"
                      : "var(--mv3-btn2-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    flexShrink: 0,
                  }}
                >
                  {p.emoji ?? "📁"}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: current ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.title}
                </span>
                {current ? (
                  <span style={{ fontSize: 9.5, color: "var(--mv3-micro)" }}>
                    current
                  </span>
                ) : null}
              </button>
            );
          })}

          {/* ＋ New project — the existing flow, returning here selected. */}
          <button
            type="button"
            className="cue-pressable"
            disabled={patch.isPending}
            onClick={() => {
              haptic.light();
              setNewProjOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              minHeight: 44,
              padding: "9px 11px",
              borderRadius: 12,
              textAlign: "left",
              fontFamily: "inherit",
              cursor: "pointer",
              color: "var(--mv3-muted)",
              background: "transparent",
              border: "1px dashed var(--mv3-btn2-border)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background:
                  "color-mix(in srgb, var(--mv3-accent) 15%, transparent)",
                color: "var(--mv3-micro)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              +
            </span>
            <span style={{ fontSize: 12.5 }}>New project</span>
          </button>
        </div>

        {/* 🧠 the teaching line closes the sheet (frame 44). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            justifyContent: "center",
            marginTop: 10,
            paddingBottom: 4,
          }}
        >
          <span aria-hidden style={{ fontSize: 10 }}>
            🧠
          </span>
          <span style={{ fontSize: 10, color: "var(--mv3-micro)" }}>
            Moving teaches Cue — next one files itself
          </span>
        </div>

        {patch.isError ? (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--mv3-amber-text)",
              textAlign: "center",
              marginTop: 6,
            }}
          >
            Couldn’t move it — try again.
          </div>
        ) : null}
      </SheetShell>

      <Mv3NewProjectSheet
        assistantId={assistantId}
        open={newProjOpen}
        onClose={() => setNewProjOpen(false)}
        onCreated={(p) => {
          setNewProjOpen(false);
          move(p.id);
        }}
      />
    </>
  );
}
