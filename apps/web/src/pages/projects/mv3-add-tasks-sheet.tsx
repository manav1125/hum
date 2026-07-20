/**
 * Mv3AddTasksSheet — batch task capture (frame 43: "load in a series of
 * tasks", per-row filing).
 *
 * Opens from Today's ⋯ overflow ("Add tasks") and All-work's header ＋. A
 * multiline draft live-parses one-task-per-line into preview rows; EACH ROW
 * carries its own project assignment (frame 43's grammar):
 *   · confident suggestion → pre-filled "X ✓" chip + "suggested — tap to
 *     change"
 *   · ambiguous → an open chip row of candidates + "＋ New"
 *   · no signal → the italic "Leave unfiled — Cue will sort it" default
 * Suggestions come from the shared client-side heuristic in `filing-kit.ts`
 * (TODO(daemon-classifier) lives there — no classify/preview route exists on
 * the daemon yet). "＋ New" reuses the EXISTING Mv3NewProjectSheet flow,
 * returning here with the new project assigned to that row.
 *
 * ENDPOINT — one `POST /work-items { title, projectId? }` per line (the same
 * quick-add write the project board uses). The daemon creates each item
 * PARKED and triages without auto-running — deliberate trust semantics, said
 * out loud in the shield footnote. Per-row progress on slow networks; failed
 * lines stay in the draft for a retry; success = haptic.success + the shared
 * v3 toast ("N tasks added").
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { workitemsPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { SheetShell, mv3Mono, primaryBtn } from "@/mobile-v3";
import { UndoToast, type Mv3Toast } from "@/mobile-v3/undo-toast";
import { haptic } from "@/utils/haptics";

import { parseTaskLines, suggestProjectFor } from "./filing-kit";
import { Mv3NewProjectSheet } from "./mv3-new-project-sheet";
import { useProjects, type ProjectView } from "./use-projects";

type RowState = "idle" | "pending" | "done" | "failed";

/**
 * Per-row assignment override, keyed by the line's text (stable across
 * neighbouring edits). `undefined` = untouched (follow the suggestion);
 * `null` = explicitly unfiled; string = a chosen projectId.
 */
type Overrides = ReadonlyMap<string, string | null>;

/* ------------------------------- chip atoms ------------------------------- */

const chipBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  borderRadius: 99,
  padding: "3px 9px",
  minHeight: 24,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  flexShrink: 0,
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  color: "var(--mv3-muted)",
};

/** The pre-filled confident/selected chip — "Seed raise ✓" (frame 43). */
const chipSelected: React.CSSProperties = {
  ...chipBase,
  color: "var(--mv3-micro)",
  background: "color-mix(in srgb, var(--mv3-accent) 16%, transparent)",
  border: "1px solid color-mix(in srgb, var(--mv3-micro) 35%, transparent)",
};

/** The dashed "＋ New" chip. */
const chipNew: React.CSSProperties = {
  ...chipBase,
  color: "var(--mv3-micro)",
  background: "transparent",
  border: "1px dashed color-mix(in srgb, var(--mv3-micro) 40%, transparent)",
};

/** The italic unfiled default. */
const chipUnfiled: React.CSSProperties = {
  ...chipBase,
  fontStyle: "italic",
  color: "var(--mv3-muted)",
  border: "1px solid var(--mv3-btn2-border)",
};

/* ------------------------------ assignment row ---------------------------- */

/**
 * The per-row assignment line under a parsed title (frame 43): renders the
 * row's current grammar (confident chip / open candidates / unfiled) and, when
 * expanded, the full chooser (every active project + ＋ New + Leave unfiled).
 */
function RowAssignment({
  line,
  projects,
  overrides,
  expanded,
  disabled,
  onExpand,
  onPick,
  onNew,
}: {
  line: string;
  projects: ProjectView[];
  overrides: Overrides;
  expanded: boolean;
  disabled: boolean;
  onExpand: () => void;
  onPick: (projectId: string | null) => void;
  onNew: () => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, ProjectView>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const suggestion = useMemo(
    () => suggestProjectFor(line, projects),
    [line, projects],
  );
  const override = overrides.get(line);
  const touched = overrides.has(line);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 7,
    paddingLeft: 23,
    flexWrap: "wrap",
    opacity: disabled ? 0.6 : 1,
    pointerEvents: disabled ? "none" : "auto",
  };

  // Expanded chooser — every active project, ＋ New, Leave unfiled.
  if (expanded) {
    return (
      <div style={rowStyle} role="radiogroup" aria-label={`File "${line}" into`}>
        {projects.map((p) => {
          const selected = touched
            ? override === p.id
            : suggestion.kind === "confident" &&
              suggestion.projectId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                onPick(p.id);
              }}
              style={selected ? chipSelected : chipBase}
            >
              {p.title}
              {selected ? " ✓" : ""}
            </button>
          );
        })}
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onNew();
          }}
          style={chipNew}
        >
          ＋ New
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={touched && override === null}
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onPick(null);
          }}
          style={chipUnfiled}
        >
          Leave unfiled — Cue will sort it
        </button>
      </div>
    );
  }

  // Explicit pick → the selected chip (tap to change).
  if (touched && override != null) {
    const p = byId.get(override);
    return (
      <div style={rowStyle}>
        <button
          type="button"
          className="cue-pressable"
          aria-label={`Filed into ${p?.title ?? "project"} — tap to change`}
          onClick={() => {
            haptic.light();
            onExpand();
          }}
          style={chipSelected}
        >
          {p?.title ?? "Project"} ✓
        </button>
      </div>
    );
  }

  // Untouched + confident → the pre-filled suggestion (frame 43 row 1).
  if (!touched && suggestion.kind === "confident") {
    const p = byId.get(suggestion.projectId);
    return (
      <div style={rowStyle}>
        <button
          type="button"
          className="cue-pressable"
          aria-label={`Suggested: ${p?.title ?? "project"} — tap to change`}
          onClick={() => {
            haptic.light();
            onExpand();
          }}
          style={chipSelected}
        >
          {p?.title ?? "Project"} ✓
        </button>
        <span style={{ fontSize: 9.5, color: "var(--mv3-faint)" }}>
          suggested — tap to change
        </span>
      </div>
    );
  }

  // Untouched + ambiguous → the open chip row (frame 43 row 2).
  if (!touched && suggestion.kind === "ambiguous") {
    return (
      <div style={rowStyle}>
        {suggestion.candidateIds.map((id) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <button
              key={id}
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                onPick(id);
              }}
              style={chipBase}
            >
              {p.title}
            </button>
          );
        })}
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onNew();
          }}
          style={chipNew}
        >
          ＋ New
        </button>
      </div>
    );
  }

  // No signal (or explicitly unfiled) → the italic default (frame 43 row 3).
  return (
    <div style={rowStyle}>
      <button
        type="button"
        className="cue-pressable"
        aria-label={`"${line}" stays unfiled — tap to file it`}
        onClick={() => {
          haptic.light();
          onExpand();
        }}
        style={chipUnfiled}
      >
        Leave unfiled — Cue will sort it
      </button>
    </div>
  );
}

/* --------------------------------- sheet ---------------------------------- */

export function Mv3AddTasksSheet({
  assistantId,
  open,
  onClose,
}: {
  assistantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { projects } = useProjects(assistantId);
  const create = useMutation({ ...workitemsPostMutation() });

  const [draft, setDraft] = useState("");
  const [overrides, setOverrides] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  /** Line whose full chooser is open (one at a time). */
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  /** Line waiting on the ＋ New project flow. */
  const [newProjFor, setNewProjFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Per-parsed-line submit state, by line index. */
  const [rowStates, setRowStates] = useState<RowState[]>([]);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [toast, setToast] = useState<Mv3Toast | null>(null);

  const lines = useMemo(() => parseTaskLines(draft), [draft]);
  const activeProjects = projects.filter((p) => p.status === "active");
  const canSubmit = lines.length > 0 && !submitting;

  /** The projectId a line will POST with (override else confident suggestion). */
  const assignmentFor = (line: string): string | null => {
    if (overrides.has(line)) return overrides.get(line) ?? null;
    const s = suggestProjectFor(line, activeProjects);
    return s.kind === "confident" ? s.projectId : null;
  };

  const setOverride = (line: string, projectId: string | null) => {
    setOverrides((prev) => new Map(prev).set(line, projectId));
    setExpandedLine((v) => (v === line ? null : v));
  };

  const close = () => {
    setErrorLine(null);
    setRowStates([]);
    setExpandedLine(null);
    onClose();
  };

  const submit = async () => {
    if (!canSubmit) return;
    haptic.medium();
    setSubmitting(true);
    setErrorLine(null);
    setExpandedLine(null);
    const states: RowState[] = lines.map(() => "idle");
    setRowStates([...states]);

    for (let i = 0; i < lines.length; i++) {
      states[i] = "pending";
      setRowStates([...states]);
      const projectId = assignmentFor(lines[i]);
      try {
        await create.mutateAsync({
          path: { assistant_id: assistantId },
          body: {
            title: lines[i],
            ...(projectId ? { projectId } : {}),
          },
        });
        states[i] = "done";
      } catch {
        states[i] = "failed";
      }
      setRowStates([...states]);
    }

    setSubmitting(false);
    const added = states.filter((s) => s === "done").length;
    const failed = lines.filter((_, i) => states[i] === "failed");
    void queryClient.invalidateQueries();

    if (failed.length === 0) {
      haptic.success();
      setDraft("");
      setRowStates([]);
      setOverrides(new Map());
      setToast({
        key: Date.now(),
        message: `${added} ${added === 1 ? "task" : "tasks"} added`,
      });
      close();
    } else {
      haptic.error();
      // Keep only the failed lines in the draft for a clean retry.
      setDraft(failed.join("\n"));
      setRowStates([]);
      setErrorLine(
        `${added > 0 ? `${added} added · ` : ""}${failed.length} didn’t make it — they stay below, tap Add to retry.`,
      );
    }
  };

  return (
    <>
      <SheetShell open={open} onClose={close} label="Add tasks">
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--mv3-text)" }}>
          Add tasks
        </div>

        {/* The draft — one task per line, live-parsed below. */}
        <textarea
          aria-label="Tasks, one per line"
          placeholder="One per line — paste a whole list, Cue parses it"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          disabled={submitting}
          style={{
            width: "100%",
            boxSizing: "border-box",
            marginTop: 11,
            minHeight: 96,
            fontSize: 16,
            lineHeight: 1.5,
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1.5px solid var(--mv3-accent)",
            borderRadius: 14,
            padding: "10px 13px",
            outline: "none",
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />

        {/* Parsed preview — each row with its own filing (frame 43). */}
        {lines.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontFamily: mv3Mono,
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  color: "var(--mv3-micro)",
                }}
              >
                {lines.length} {lines.length === 1 ? "TASK" : "TASKS"} PARSED
              </span>
              <span
                aria-hidden
                style={{
                  flex: 1,
                  height: 1,
                  background: "var(--mv3-card-border)",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {lines.map((line, i) => {
                const state = rowStates[i] ?? "idle";
                return (
                  <div
                    key={`${i}-${line}`}
                    style={{
                      background: "var(--mv3-card)",
                      border: "1px solid var(--mv3-card-border)",
                      borderRadius: 14,
                      padding: "10px 12px",
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 15,
                          height: 15,
                          borderRadius: 5,
                          border: "1.5px solid var(--mv3-btn2-border)",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          color:
                            state === "done"
                              ? "var(--mv3-green)"
                              : state === "failed"
                                ? "var(--mv3-amber)"
                                : "var(--mv3-micro)",
                        }}
                      >
                        {state === "done"
                          ? "✓"
                          : state === "failed"
                            ? "!"
                            : state === "pending"
                              ? "…"
                              : ""}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: "var(--mv3-text)",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          opacity: state === "done" ? 0.6 : 1,
                        }}
                      >
                        {line}
                      </span>
                      {state === "pending" ? (
                        <span
                          style={{ fontSize: 10.5, color: "var(--mv3-faint)" }}
                        >
                          adding…
                        </span>
                      ) : null}
                    </div>
                    <RowAssignment
                      line={line}
                      projects={activeProjects}
                      overrides={overrides}
                      expanded={expandedLine === line}
                      disabled={submitting || state === "done"}
                      onExpand={() =>
                        setExpandedLine((v) => (v === line ? null : line))
                      }
                      onPick={(pid) => setOverride(line, pid)}
                      onNew={() => setNewProjFor(line)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {errorLine ? (
          <div style={{ fontSize: 11.5, color: "var(--mv3-amber)", marginTop: 10 }}>
            {errorLine}
          </div>
        ) : null}

        {/* Shield footnote — the trust boundary, said at the moment of entry
            (frame 43: above the button, centered). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            justifyContent: "center",
            marginTop: 12,
            paddingBottom: 8,
          }}
        >
          <svg
            aria-hidden
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--mv3-green)"
            strokeWidth="2"
          >
            <path d="M12 2l7 4v6c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z" />
          </svg>
          <span style={{ fontSize: 10, color: "var(--mv3-faint)" }}>
            Added parked — nothing runs or spends until you say so
          </span>
        </div>

        <button
          type="button"
          className="cue-pressable"
          disabled={!canSubmit}
          onClick={() => void submit()}
          style={{
            // Frame 43's blue-gradient CTA (the v3 "Send it" primary).
            ...primaryBtn,
            flex: "initial",
            width: "100%",
            borderRadius: 14,
            padding: 13,
            minHeight: 44,
            cursor: canSubmit ? "pointer" : "default",
            opacity: canSubmit ? 1 : 0.55,
          }}
        >
          {submitting
            ? "Adding…"
            : lines.length > 1
              ? `Add ${lines.length} tasks`
              : "Add task"}
        </button>
      </SheetShell>

      {/* The EXISTING new-project flow; on create we come back here with the
          fresh project assigned to the row that asked for it. */}
      <Mv3NewProjectSheet
        assistantId={assistantId}
        open={newProjFor !== null}
        onClose={() => setNewProjFor(null)}
        onCreated={(p) => {
          if (newProjFor !== null) setOverride(newProjFor, p.id);
          setNewProjFor(null);
        }}
      />

      <UndoToast toast={toast} onClear={() => setToast(null)} />
    </>
  );
}
