/**
 * AddTasksModal — frame D1's global ⌘⇧A two-pane batch capture (desktop; the
 * serif ink product system). Raw entry left (paste-anything), parsed rows
 * right updating live per keystroke, with the SAME per-row assignment grammar
 * as mobile frame 43: confident → pre-filled "X ✓" chip, ambiguous → open
 * chip row + "＋ New", no signal → the italic "Leave unfiled" default.
 * Suggestions come from the shared kit in `filing-kit.ts`: the client-side
 * heuristic paints instantly, and the daemon's `classify-preview` scorer
 * (debounced, feature-detected — see `useServerSuggestions`) overrides it a
 * beat later.
 *
 * Mounted globally in ChatLayout (beside the command palette) and driven by
 * `useAddTasksStore` (⌘⇧A anywhere + All-work's "＋ Add tasks" button).
 *
 * ENDPOINT — one `POST /work-items { title, projectId? }` per line; the
 * daemon creates each item PARKED (the shield footnote says so at entry).
 * Failed lines stay in the draft for a retry, exactly like mobile.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { C, mono, serif } from "@/domains/activity/theme";
import { workitemsPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAddTasksStore } from "@/stores/add-tasks-store";

import {
  parseTaskLines,
  resolveSuggestionFor,
  type ServerSuggestion,
  useServerSuggestions,
} from "./filing-kit";
import { NewProjectModal } from "./new-project-modal";
import { useProjects, type ProjectView } from "./use-projects";

type RowState = "idle" | "pending" | "done" | "failed";

/** One line that failed to POST, with its short human reason (frame D4). */
interface FailedRow {
  line: string;
  reason: string;
}

/** Post-submit partial-failure snapshot (D4 — the modal never closes). */
interface SubmitResult {
  added: string[];
  failed: FailedRow[];
}

/** Short reason for the D4 inline red line ("connection dropped"). */
function describeSubmitError(err: unknown): string {
  if (err instanceof TypeError) return "connection dropped";
  if (err instanceof Error && err.message && err.message.length <= 60) {
    return err.message.replace(/\.$/, "");
  }
  return "didn’t go through";
}

const wash = (accent: string, pct: number) =>
  `color-mix(in srgb, ${accent} ${pct}%, transparent)`;

/** D4's failure red — #C24E42 on cream light / re-toned dark (index.css). */
const RED = "var(--mv1-red)";
const RED_WASH = "var(--mv1-red-wash)";

/* ------------------------------- chip atoms ------------------------------- */

const chipBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: C.t2,
  background: C.surface,
  border: `1px solid ${wash(C.ink, 12)}`,
  borderRadius: 99,
  padding: "3px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const chipSelected: React.CSSProperties = {
  ...chipBase,
  color: C.blueS,
  background: wash(C.blue, 10),
  border: `1px solid ${wash(C.blue, 25)}`,
};

const chipNew: React.CSSProperties = {
  ...chipBase,
  color: C.blue,
  background: "transparent",
  border: `1px dashed ${wash(C.blue, 45)}`,
};

const chipUnfiled: React.CSSProperties = {
  ...chipBase,
  color: C.t3,
  fontStyle: "italic",
  background: "transparent",
  border: `1px solid ${wash(C.ink, 10)}`,
};

/* ------------------------------ assignment cell --------------------------- */

function RowAssignment({
  line,
  projects,
  serverSuggestions,
  overrides,
  expanded,
  disabled,
  onExpand,
  onPick,
  onNew,
}: {
  line: string;
  projects: ProjectView[];
  /** Debounced daemon classify-preview results (heuristic fallback inside). */
  serverSuggestions: ReadonlyMap<string, ServerSuggestion>;
  overrides: ReadonlyMap<string, string | null>;
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
    () => resolveSuggestionFor(line, projects, serverSuggestions),
    [line, projects, serverSuggestions],
  );
  const override = overrides.get(line);
  const touched = overrides.has(line);

  const cell: React.CSSProperties = {
    display: "flex",
    gap: 5,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    opacity: disabled ? 0.6 : 1,
    pointerEvents: disabled ? "none" : "auto",
  };

  if (expanded) {
    return (
      <span style={cell} role="radiogroup" aria-label={`File "${line}" into`}>
        {projects.map((p) => {
          const selected = touched
            ? override === p.id
            : suggestion.kind === "confident" && suggestion.projectId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onPick(p.id)}
              style={selected ? chipSelected : chipBase}
            >
              {p.title}
              {selected ? " ✓" : ""}
            </button>
          );
        })}
        <button type="button" onClick={onNew} style={chipNew}>
          ＋ New
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={touched && override === null}
          onClick={() => onPick(null)}
          style={chipUnfiled}
        >
          Leave unfiled — Cue will sort it
        </button>
      </span>
    );
  }

  if (touched && override != null) {
    const p = byId.get(override);
    return (
      <span style={cell}>
        <button
          type="button"
          title="Tap to change"
          onClick={onExpand}
          style={chipSelected}
        >
          {p?.title ?? "Project"} ✓
        </button>
      </span>
    );
  }

  if (!touched && suggestion.kind === "confident") {
    const p = byId.get(suggestion.projectId);
    return (
      <span style={cell}>
        <button
          type="button"
          title="Suggested — tap to change"
          aria-label={`Suggested: ${p?.title ?? "project"} — tap to change`}
          onClick={onExpand}
          style={chipSelected}
        >
          {p?.title ?? "Project"} ✓
        </button>
      </span>
    );
  }

  if (!touched && suggestion.kind === "ambiguous") {
    return (
      <span style={cell}>
        {suggestion.candidateIds.map((id) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              style={chipBase}
            >
              {p.title}
            </button>
          );
        })}
        <button type="button" onClick={onNew} style={chipNew}>
          ＋ New
        </button>
      </span>
    );
  }

  return (
    <span style={cell}>
      <button
        type="button"
        aria-label={`"${line}" stays unfiled — click to file it`}
        onClick={onExpand}
        style={chipUnfiled}
      >
        Leave unfiled — Cue will sort it
      </button>
    </span>
  );
}

/* --------------------------------- modal ---------------------------------- */

export function AddTasksModal() {
  const isOpen = useAddTasksStore.use.isOpen();
  const close = useAddTasksStore.use.close();
  if (!isOpen) return null;
  return <AddTasksModalBody onClose={close} />;
}

function AddTasksModalBody({ onClose }: { onClose: () => void }) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const { projects } = useProjects(assistantId);
  const create = useMutation({ ...workitemsPostMutation() });

  // Seeded from the store so a deferred draft ("Keep in draft", D4) survives
  // the modal unmounting; every edit writes back for the lossless close.
  const storedDraft = useAddTasksStore.use.draft();
  const setStoredDraft = useAddTasksStore.use.setDraft();
  const [draft, setDraftState] = useState(storedDraft);
  const setDraft = (next: string) => {
    setDraftState(next);
    setStoredDraft(next);
  };
  const [overrides, setOverrides] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [newProjFor, setNewProjFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rowStates, setRowStates] = useState<RowState[]>([]);
  /** Non-null = frame D4's partial-failure state (modal stays open). */
  const [result, setResult] = useState<SubmitResult | null>(null);

  const lines = useMemo(() => parseTaskLines(draft), [draft]);
  const activeProjects = projects.filter((p) => p.status === "active");
  const canSubmit = lines.length > 0 && !submitting;

  // Daemon classify-preview (debounced 600ms, 404-feature-detected); the
  // client heuristic stays the instant first paint + offline fallback.
  const serverSuggestions = useServerSuggestions(
    assistantId,
    lines,
    activeProjects,
  );

  const assignmentFor = (line: string): string | null => {
    if (overrides.has(line)) return overrides.get(line) ?? null;
    const s = resolveSuggestionFor(line, activeProjects, serverSuggestions);
    return s.kind === "confident" ? s.projectId : null;
  };

  const setOverride = (line: string, projectId: string | null) => {
    setOverrides((prev) => new Map(prev).set(line, projectId));
    setExpandedLine((v) => (v === line ? null : v));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    setExpandedLine(null);
    const states: RowState[] = lines.map(() => "idle");
    const reasons: string[] = lines.map(() => "");
    setRowStates([...states]);

    for (let i = 0; i < lines.length; i++) {
      states[i] = "pending";
      setRowStates([...states]);
      const projectId = assignmentFor(lines[i]);
      try {
        await create.mutateAsync({
          path: { assistant_id: assistantId },
          body: { title: lines[i], ...(projectId ? { projectId } : {}) },
        });
        states[i] = "done";
      } catch (err) {
        states[i] = "failed";
        reasons[i] = describeSubmitError(err);
      }
      setRowStates([...states]);
    }

    setSubmitting(false);
    const added = lines.filter((_, i) => states[i] === "done");
    const failed: FailedRow[] = lines
      .map((line, i) => ({ line, reason: reasons[i] }))
      .filter((_, i) => states[i] === "failed");
    void queryClient.invalidateQueries();

    if (failed.length === 0) {
      toast.success(
        `${added.length} ${added.length === 1 ? "task" : "tasks"} added — parked until you say go`,
      );
      setDraft("");
      onClose();
    } else {
      // Frame D4: the modal NEVER closes on partial failure — failed rows
      // stay in the (editable) draft with the reason inline.
      setDraft(failed.map((f) => f.line).join("\n"));
      setRowStates([]);
      setResult({ added, failed });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add tasks"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb, #000 32%, transparent)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "52px 16px 16px",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(820px, 100%)",
          background: C.surface,
          borderRadius: 20,
          boxShadow: "0 40px 90px -30px rgba(11,23,54,0.45)",
          border: `1px solid ${wash(C.ink, 8)}`,
          animation: "cueFilingRise .4s ease both",
        }}
      >
        {/* Header — serif title · ⌘⇧A kbd · ✕ */}
        <div style={{ display: "flex", alignItems: "center", padding: "20px 24px 0" }}>
          <div style={{ fontFamily: serif, fontSize: 26, color: C.t1, flex: 1 }}>
            Add tasks
          </div>
          <span
            aria-hidden
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
              background: C.bg,
              borderRadius: 6,
              padding: "4px 9px",
              marginRight: 10,
            }}
          >
            ⌘⇧A
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              fontSize: 14,
              color: C.t3,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              fontFamily: "inherit",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", padding: "16px 24px 20px" }}>
          {/* Left pane — raw entry. */}
          <div
            style={{
              width: 340,
              flexShrink: 0,
              paddingRight: 20,
              borderRight: `1px solid ${C.line}`,
            }}
          >
            <textarea
              // The modal exists to type into; ⌘⇧A lands here.
              autoFocus
              aria-label="Tasks, one per line"
              placeholder={"One task per line…"}
              value={draft}
              onChange={(e) => {
                // Editing the draft steps back out of the failure summary —
                // D4's failed rows stay editable.
                setDraft(e.target.value);
                if (result) setResult(null);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              disabled={submitting}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: C.sunken,
                border: `1.5px solid ${C.blue}`,
                borderRadius: 14,
                padding: "14px 16px",
                minHeight: 220,
                boxShadow: `0 0 0 3px ${wash(C.blue, 10)}`,
                fontSize: 14,
                lineHeight: 1.9,
                color: C.t1,
                outline: "none",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: C.t3,
                marginTop: 9,
                lineHeight: 1.5,
              }}
            >
              One per line — or paste from Notes, email, anywhere.
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginTop: 16,
              }}
            >
              <svg
                aria-hidden
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke={C.green}
                strokeWidth="2"
              >
                <path d="M12 2l7 4v6c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z" />
              </svg>
              <span style={{ fontSize: 11.5, color: C.t2 }}>
                Added parked — nothing runs or spends until you say so
              </span>
            </div>
          </div>

          {/* Right pane — parsed rows + per-row filing, or the D4 partial-
              failure summary (the modal never closes on partial failure). */}
          <div style={{ flex: 1, minWidth: 0, paddingLeft: 20 }}>
            {result !== null ? (
              <>
                {/* ✓ serif summary line. */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      background: wash(C.green, 16),
                      color: C.green,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{ fontFamily: serif, fontSize: 22, color: C.t1 }}
                    >
                      {result.added.length} added · {result.failed.length}{" "}
                      didn&rsquo;t make it
                    </div>
                    <div
                      style={{ fontSize: 12, color: C.t3, marginTop: 1 }}
                    >
                      {result.added.length > 0
                        ? "Added tasks are parked in the queue · your text is kept"
                        : "Nothing saved yet — your text is kept"}
                    </div>
                  </div>
                </div>

                {/* N STILL IN YOUR DRAFT — mono red label + hairline. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    margin: "18px 0 10px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      color: RED,
                    }}
                  >
                    {result.failed.length} STILL IN YOUR DRAFT
                  </span>
                  <span
                    aria-hidden
                    style={{ flex: 1, height: 1, background: wash(C.ink, 7) }}
                  />
                </div>

                {/* Failed rows — red on cream, the reason inline right. The
                    text stays editable in the left pane. */}
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {result.failed.map((f, i) => (
                    <div
                      key={`${i}-${f.line}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: RED_WASH,
                        border: `1px solid ${wash(RED, 35)}`,
                        borderRadius: 11,
                        padding: "10px 13px",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 6,
                          background: wash(RED, 12),
                          color: RED,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          flexShrink: 0,
                        }}
                      >
                        ✕
                      </span>
                      <span
                        style={{
                          fontSize: 13.5,
                          color: C.t1,
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {f.line}
                      </span>
                      <span
                        style={{
                          fontSize: 11.5,
                          color: RED,
                          flexShrink: 0,
                        }}
                      >
                        {f.reason}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Succeeded rows collapse to one quiet ✓ line. */}
                {result.added.length > 0 ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 12.5,
                      color: C.t3,
                      padding: "12px 2px 0",
                    }}
                  >
                    <span aria-hidden>✓</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {result.added.slice(0, 2).join(" · ")}
                      {result.added.length > 2
                        ? ` · +${result.added.length - 2}`
                        : ""}{" "}
                      — added
                    </span>
                  </div>
                ) : null}

                {/* Footer — Keep in draft (lossless defer) · Retry failures
                    only. */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                    marginTop: 20,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      // The draft already holds the failed lines and is
                      // persisted in the store — nothing is lost.
                      setResult(null);
                      onClose();
                    }}
                    style={{
                      background: C.surface,
                      color: C.t2,
                      border: `1px solid ${wash(C.ink, 12)}`,
                      borderRadius: 11,
                      padding: "10px 18px",
                      fontSize: 13,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    Keep in draft
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      setResult(null);
                      void submit();
                    }}
                    style={{
                      background: C.blue,
                      color: "#fff",
                      border: "none",
                      borderRadius: 11,
                      padding: "10px 22px",
                      fontSize: 13.5,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      boxShadow: `0 10px 24px -10px ${wash(C.blue, 50)}`,
                    }}
                  >
                    Retry {result.failed.length} failed
                  </button>
                </div>
              </>
            ) : (
              <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  color: C.blue,
                }}
              >
                {lines.length} {lines.length === 1 ? "TASK" : "TASKS"} PARSED
              </span>
              <span
                aria-hidden
                style={{ flex: 1, height: 1, background: wash(C.ink, 7) }}
              />
            </div>

            {lines.length === 0 ? (
              <div style={{ fontSize: 12.5, color: C.t3, padding: "8px 2px" }}>
                Rows appear here as you type — each with its own filing.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {lines.map((line, i) => {
                  const state = rowStates[i] ?? "idle";
                  return (
                    <div
                      key={`${i}-${line}`}
                      className="cue-filing-rise"
                      style={{
                        background: C.sunken,
                        border: `1px solid ${wash(C.ink, 7)}`,
                        borderRadius: 12,
                        padding: "10px 13px",
                        animation: `cueFilingRise .35s ease ${Math.min(i, 6) * 0.08}s both`,
                      }}
                    >
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 9 }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: 4,
                            border: `1.5px solid ${wash(C.ink, 20)}`,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 9,
                            color:
                              state === "done"
                                ? C.green
                                : state === "failed"
                                  ? C.amber
                                  : C.t3,
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
                            fontSize: 13.5,
                            color: C.t1,
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
                        <RowAssignment
                          line={line}
                          projects={activeProjects}
                          serverSuggestions={serverSuggestions}
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
                    </div>
                  );
                })}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                marginTop: 16,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: C.surface,
                  color: C.t2,
                  border: `1px solid ${wash(C.ink, 12)}`,
                  borderRadius: 11,
                  padding: "10px 18px",
                  fontSize: 13,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void submit()}
                style={{
                  background: C.blue,
                  color: "#fff",
                  border: "none",
                  borderRadius: 11,
                  padding: "10px 22px",
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: canSubmit ? "pointer" : "default",
                  opacity: canSubmit ? 1 : 0.55,
                  boxShadow: `0 10px 24px -10px ${wash(C.blue, 50)}`,
                }}
              >
                {submitting
                  ? "Adding…"
                  : `Add ${lines.length > 0 ? `${lines.length} ` : ""}${lines.length === 1 ? "task" : "tasks"}`}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Local keyframes (the modal can mount outside any filing surface). */}
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes cueFilingRise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
        }}
      />

      {/* ＋ New — the EXISTING desktop new-project flow; the fresh project is
          assigned to the row that asked for it. */}
      {newProjFor !== null ? (
        <span onClick={(e) => e.stopPropagation()}>
          <NewProjectModal
            assistantId={assistantId}
            onClose={() => setNewProjFor(null)}
            onCreated={(projectId) => {
              if (newProjFor !== null) setOverride(newProjFor, projectId);
              setNewProjFor(null);
            }}
          />
        </span>
      ) : null}
    </div>
  );
}
