/**
 * Mv3ProjectBrief — the mobile v3 project brief card (spec frame 41): the
 * project's Context brief rendered as calm prose under the "BRIEF — WHAT CUE
 * OPTIMIZES FOR" microlabel, tap-to-edit via an iOS sheet.
 *
 * DATA — nothing invented: the prose is the project's real `context` field
 * (the same field desktop's ProjectBrief edits); saves go through the real
 * PATCH /projects/:id (`usePatchProject`). The caption is honest: the runner
 * prepends this brief to EVERY work-item run in the project
 * (assistant/src/work-items/work-item-runner.ts buildWorkItemContextPreamble),
 * so edits re-steer the next run each agent starts.
 */
import { useEffect, useState } from "react";

import { SheetShell, microLabel, rise } from "@/mobile-v3";
import { haptic } from "@/utils/haptics";

import { usePatchProject } from "./use-projects";

/** Frame 41 prose tone (#C9C9D4 dark) via a mechanical text↔bg re-tone. */
const PROSE_COLOR = "color-mix(in srgb, var(--mv3-text) 80%, var(--mv3-bg))";

export function Mv3ProjectBrief({
  assistantId,
  projectId,
  brief,
  delay,
}: {
  assistantId: string;
  projectId: string;
  /** The project's canonical `context` field (null when unset). */
  brief: string | null;
  delay: number;
}) {
  const patch = usePatchProject(assistantId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");

  // Re-sync when the canonical brief changes (another client edited it),
  // but never stomp an in-progress edit.
  useEffect(() => {
    if (!editing) setDraft(brief ?? "");
  }, [brief, editing]);

  const hasBrief = (brief ?? "").trim().length > 0;

  const save = () => {
    const next = draft.trim();
    if (next === (brief ?? "").trim()) {
      setEditing(false);
      return;
    }
    haptic.medium();
    patch.mutate(
      {
        path: { assistant_id: assistantId, id: projectId },
        body: { context: next || null },
      },
      {
        onSuccess: () => {
          haptic.success();
          setEditing(false);
        },
      },
    );
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="cue-pressable"
        aria-label="Project brief — tap to edit"
        onClick={() => {
          haptic.light();
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            haptic.light();
            setEditing(true);
          }
        }}
        style={{
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-card-border)",
          borderRadius: 20,
          padding: "14px 16px",
          cursor: "pointer",
          ...rise(delay),
        }}
      >
        <div
          style={{
            ...microLabel,
            fontSize: 9.5,
            color: "var(--mv3-micro)",
            marginBottom: 9,
          }}
        >
          Brief — what Cue optimizes for
        </div>
        {hasBrief ? (
          <div
            style={{
              fontSize: 13.5,
              lineHeight: 1.55,
              color: PROSE_COLOR,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {brief}
          </div>
        ) : (
          <div
            style={{ fontSize: 13, lineHeight: 1.5, color: "var(--mv3-muted)" }}
          >
            Add a brief so Cue works every task here with the same context…
          </div>
        )}
        <div
          style={{ fontSize: 10.5, color: "var(--mv3-muted)", marginTop: 9 }}
        >
          Tap to edit — changes re-steer the agents immediately
        </div>
      </div>

      <SheetShell
        open={editing}
        onClose={() => setEditing(false)}
        label="Edit project brief"
      >
        <div
          style={{
            ...microLabel,
            fontSize: 9.5,
            color: "var(--mv3-micro)",
            marginBottom: 10,
          }}
        >
          Brief — what Cue optimizes for
        </div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          placeholder="What's this project about? Goals, constraints, who's involved, tone, links…"
          rows={6}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 16,
            lineHeight: 1.55,
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 12,
            padding: "11px 13px",
            outline: "none",
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div style={{ fontSize: 11, color: "var(--mv3-muted)", marginTop: 8 }}>
          Cue reads this before working any task in this project.
        </div>
        {patch.isError ? (
          <div style={{ fontSize: 11.5, color: "var(--mv3-amber-text)", marginTop: 8 }}>
            Couldn’t save the brief — try again.
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setDraft(brief ?? "");
              setEditing(false);
            }}
            style={{
              flex: 1,
              minHeight: 44,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
              color: "var(--mv3-muted)",
              borderRadius: 12,
              padding: 10,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cue-pressable"
            disabled={patch.isPending}
            onClick={save}
            style={{
              flex: 2,
              minHeight: 44,
              background: "var(--mv3-text)",
              color: "var(--mv3-bg)",
              border: "none",
              borderRadius: 12,
              padding: 10,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              opacity: patch.isPending ? 0.6 : 1,
            }}
          >
            {patch.isPending ? "Saving…" : "Save brief"}
          </button>
        </div>
      </SheetShell>
    </>
  );
}
