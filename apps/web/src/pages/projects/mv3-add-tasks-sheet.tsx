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
 * Suggestions come from the shared kit in `filing-kit.ts`: the client-side
 * heuristic paints instantly, and the daemon's `classify-preview` scorer
 * (debounced, feature-detected — see `useServerSuggestions`) overrides it a
 * beat later. "＋ New" reuses the EXISTING Mv3NewProjectSheet flow, returning
 * here with the new project assigned to that row.
 *
 * ENDPOINT — one `POST /work-items { title, projectId? }` per line (the same
 * quick-add write the project board uses). The daemon creates each item
 * PARKED and triages without auto-running — deliberate trust semantics, said
 * out loud in the shield footnote. Per-row progress on slow networks; failed
 * lines stay in the draft for a retry; success = haptic.success + the shared
 * v3 toast ("N tasks added").
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import {
  isMicPermissionError,
  isMicPermissionPermanentError,
} from "@/domains/chat/utils/chat";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { workitemsPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { SheetShell, mv3Mono, primaryBtn } from "@/mobile-v3";
import { UndoToast, type Mv3Toast } from "@/mobile-v3/undo-toast";
import { haptic } from "@/utils/haptics";
import { rateLimitRetry } from "@/utils/rate-limit-retry";

import {
  parseTaskLines,
  resolveSuggestionFor,
  type ServerSuggestion,
  useServerSuggestions,
} from "./filing-kit";
import { Mv3NewProjectSheet } from "./mv3-new-project-sheet";
import { useProjects, type ProjectView } from "./use-projects";

type RowState = "idle" | "pending" | "done" | "failed";

/** One line that failed to POST, with its human reason (frame 46). */
interface FailedRow {
  line: string;
  reason: string;
}

/** The post-submit partial-failure snapshot (frame 46 — sheet stays open). */
interface SubmitResult {
  added: string[];
  failed: FailedRow[];
}

/** Short human reason for a failed work-item POST (frame 46's inline line). */
function describeSubmitError(err: unknown): string {
  if (err instanceof TypeError) return "connection dropped";
  if (err instanceof Error && err.message && err.message.length <= 80) {
    return err.message.replace(/\.$/, "");
  }
  return "it didn’t go through";
}

/** >1.2s of unchanged interim transcript commits the utterance (frame 50). */
const DICTATION_PAUSE_MS = 1_200;

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
    () => resolveSuggestionFor(line, projects, serverSuggestions),
    [line, projects, serverSuggestions],
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
        <span style={{ fontSize: 9.5, color: "var(--mv3-muted)" }}>
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
  const create = useMutation({ ...workitemsPostMutation(), ...rateLimitRetry });

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
  /** Non-null = the frame-46 partial-failure state (sheet stays open). */
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [toast, setToast] = useState<Mv3Toast | null>(null);

  /* ------------------------- dictation (frame 50) ------------------------- */
  const voiceRef = useRef<VoiceInputButtonHandle | null>(null);
  /** User is in the continuous listen loop (survives per-utterance stops). */
  const [dictating, setDictating] = useState(false);
  /** Mic permission denied / no capture device — the graceful hidden state. */
  const [micBlocked, setMicBlocked] = useState(false);
  /** True while an auto pause-commit is in flight (restart after it lands). */
  const keepListening = useRef(false);
  /** The just-committed line, for the spring pop (frame 50). */
  const [popped, setPopped] = useState<{ line: string; key: number } | null>(
    null,
  );
  const phase = useVoiceRecordingStore.use.phase();
  const interim = useVoiceRecordingStore.use.interimTranscript();
  const recording = phase === "recording";
  const transcribing = phase === "processing";
  // Base capability gate — VoiceInputButton needs getUserMedia to record.
  const [dictationSupported] = useState(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function",
  );

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

  /** The projectId a line will POST with (override else confident suggestion). */
  const assignmentFor = (line: string): string | null => {
    if (overrides.has(line)) return overrides.get(line) ?? null;
    const s = resolveSuggestionFor(line, activeProjects, serverSuggestions);
    return s.kind === "confident" ? s.projectId : null;
  };

  const setOverride = (line: string, projectId: string | null) => {
    setOverrides((prev) => new Map(prev).set(line, projectId));
    setExpandedLine((v) => (v === line ? null : v));
  };

  const stopDictation = () => {
    keepListening.current = false;
    setDictating(false);
    if (recording) voiceRef.current?.stop();
  };

  const close = () => {
    // Frame 46: the draft (and any failed lines inside it) survives a close —
    // "Keep in draft" defers losslessly while this surface stays mounted.
    stopDictation();
    setRowStates([]);
    setExpandedLine(null);
    onClose();
  };

  // Frame 50's pause-commit: while listening, an interim transcript that goes
  // UNCHANGED for >1.2s commits the utterance — stop the recorder (the batch
  // STT finalises it in onTranscript) and re-arm the mic for the next one.
  useEffect(() => {
    if (!dictating || !recording) return;
    if (!interim.trim()) return;
    const t = window.setTimeout(() => {
      keepListening.current = true;
      voiceRef.current?.stop();
    }, DICTATION_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [dictating, recording, interim]);

  /** A finalised utterance lands as a parsed row with a spring pop. */
  const handleDictated = (text: string) => {
    const line = text.trim().replace(/\n+/g, " ");
    if (line) {
      haptic.light();
      setDraft((d) => (d ? `${d}\n${line}` : line));
      setPopped({ line, key: Date.now() });
    }
    if (keepListening.current) {
      // Pause-committed mid-session → keep listening for the next utterance.
      keepListening.current = false;
      if (dictating && !micBlocked) voiceRef.current?.start();
    } else {
      setDictating(false);
    }
  };

  const handleVoiceError = (code: string | null) => {
    if (!code) return;
    keepListening.current = false;
    setDictating(false);
    if (
      isMicPermissionError(code) ||
      isMicPermissionPermanentError(code) ||
      code === "audio-capture"
    ) {
      // Graceful mic-denied state: the ◎ affordance dims with an honest line.
      setMicBlocked(true);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    haptic.medium();
    stopDictation();
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
          body: {
            title: lines[i],
            ...(projectId ? { projectId } : {}),
          },
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
      haptic.success();
      setDraft("");
      setRowStates([]);
      setOverrides(new Map());
      setToast({
        key: Date.now(),
        message: `${added.length} ${added.length === 1 ? "task" : "tasks"} added`,
      });
      close();
    } else {
      // Frame 46: the sheet NEVER closes on partial failure. Failed lines
      // stay in the draft (text kept, overrides intact) behind the summary.
      haptic.error();
      setDraft(failed.map((f) => f.line).join("\n"));
      setRowStates([]);
      setResult({ added, failed });
    }
  };

  return (
    <>
      <SheetShell open={open} onClose={close} label="Add tasks">
        {/* The EXISTING dictation engine (MediaRecorder → sttTranscribePost),
            driven imperatively — its own button stays hidden (frame 50). */}
        {dictationSupported ? (
          <VoiceInputButton
            ref={voiceRef}
            assistantId={assistantId}
            onTranscript={handleDictated}
            onError={handleVoiceError}
            renderButton={false}
          />
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--mv3-text)",
              flex: 1,
            }}
          >
            Add tasks
          </div>
          {/* ◎ Speak — dictate straight into the batch (frame 50). Hidden
              when recording is unsupported; dimmed + honest when denied. */}
          {dictationSupported && result === null ? (
            micBlocked ? (
              <span style={{ fontSize: 10.5, color: "var(--mv3-muted)" }}>
                Mic unavailable — type instead
              </span>
            ) : !dictating && !recording && !transcribing ? (
              <button
                type="button"
                className="cue-pressable"
                disabled={submitting}
                onClick={() => {
                  haptic.light();
                  setDictating(true);
                  voiceRef.current?.start();
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: 34,
                  padding: "6px 13px",
                  borderRadius: 99,
                  background: "var(--mv3-btn2-bg)",
                  border: "1px solid var(--mv3-btn2-border)",
                  color: "var(--mv3-micro)",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span aria-hidden style={{ fontSize: 13 }}>
                  ◎
                </span>
                Speak
              </button>
            ) : null
          ) : null}
        </div>

        {result === null && (dictating || recording || transcribing) ? (
          /* Frame 50: the entry area becomes waveform + live italic
             transcript. Tapping the card stops the session. */
          <button
            type="button"
            aria-label="Stop dictating"
            onClick={() => {
              haptic.light();
              stopDictation();
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              textAlign: "left",
              marginTop: 11,
              minHeight: 96,
              background: "var(--mv3-btn2-bg)",
              border: "1.5px solid var(--mv3-accent)",
              boxShadow:
                "0 0 0 3px color-mix(in srgb, var(--mv3-accent) 14%, transparent)",
              borderRadius: 15,
              padding: "12px 14px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: "var(--mv3-accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  color: "#fff",
                  fontSize: 13,
                }}
              >
                ◎
              </span>
              {/* 3-bar waveform (mv3Bar scaleY pulse; frozen reduced-motion). */}
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2.5,
                  height: 14,
                }}
              >
                {[0, 0.18, 0.36].map((d) => (
                  <span
                    key={d}
                    style={{
                      width: 3,
                      height: 14,
                      borderRadius: 2,
                      background: "var(--mv3-micro)",
                      transformOrigin: "center",
                      animation: recording
                        ? `mv3Bar 1s ${d}s ease-in-out infinite`
                        : "none",
                      transform: recording ? undefined : "scaleY(0.3)",
                    }}
                  />
                ))}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--mv3-muted)",
                }}
              >
                {transcribing ? "transcribing…" : "tap to stop"}
              </span>
            </span>
            <span
              style={{
                display: "block",
                marginTop: 9,
                fontSize: 13.5,
                lineHeight: 1.45,
                fontStyle: "italic",
                color: interim ? "var(--mv3-text)" : "var(--mv3-muted)",
              }}
            >
              {interim
                ? `“…${interim}”`
                : transcribing
                  ? "committing that line…"
                  : "Listening — pause a beat to commit a task."}
            </span>
          </button>
        ) : result === null ? (
          /* The draft — one task per line, live-parsed below. */
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
        ) : null}

        {/* Parsed preview — each row with its own filing (frame 43). */}
        {result === null && lines.length > 0 ? (
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
                      // Frame 50: a freshly dictated line lands with a
                      // spring pop.
                      ...(popped && popped.line === line
                        ? {
                            animation:
                              "mv3RowPop .35s cubic-bezier(.2,.8,.2,1) both",
                          }
                        : {}),
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
                          style={{ fontSize: 10.5, color: "var(--mv3-muted)" }}
                        >
                          adding…
                        </span>
                      ) : null}
                    </div>
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
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Frame 50: the in-progress utterance rides a dashed, pulsing row
            until the pause commits it. */}
        {result === null && (recording || transcribing) ? (
          <div
            aria-hidden
            style={{
              marginTop: lines.length > 0 ? 7 : 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1.5px dashed rgba(127,163,242,.4)",
              borderRadius: 14,
              padding: "10px 12px",
              animation: "mv3DashPulse 1.6s ease-in-out infinite",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--mv3-accent)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 12.5,
                fontStyle: "italic",
                color: "var(--mv3-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {interim ? `${interim}…` : "…"}
            </span>
          </div>
        ) : null}

        {/* ------------------- frame 46: partial failure ------------------- */}
        {result !== null ? (
          <div style={{ marginTop: 11 }}>
            {/* ✓ summary — the sheet never closes on partial failure. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 15,
                padding: "12px 14px",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 7,
                  background:
                    "color-mix(in srgb, var(--mv3-green) 18%, transparent)",
                  color: "var(--mv3-green)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                ✓
              </span>
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--mv3-text)",
                  }}
                >
                  {result.added.length} added · {result.failed.length} didn’t
                  make it
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: "var(--mv3-muted)",
                    marginTop: 1,
                  }}
                >
                  {result.added.length > 0
                    ? "Added tasks are parked in the queue"
                    : "Nothing saved yet — your text is kept"}
                </span>
              </span>
            </div>

            {/* N STILL IN YOUR DRAFT — mono label + hairline. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                margin: "14px 0 8px",
              }}
            >
              <span
                style={{
                  fontFamily: mv3Mono,
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  color: "var(--mv3-fail-text)",
                }}
              >
                {result.failed.length} STILL IN YOUR DRAFT
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

            {/* Failed rows — red, reason inline, text preserved. Tapping a
                row returns to the editable draft. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {result.failed.map((f, i) => (
                <button
                  key={`${i}-${f.line}`}
                  type="button"
                  className="cue-pressable"
                  aria-label={`Edit failed task: ${f.line}`}
                  onClick={() => {
                    haptic.light();
                    setResult(null);
                  }}
                  style={{
                    textAlign: "left",
                    background: "var(--mv3-fail-card-bg)",
                    border: "1px solid var(--mv3-fail-card-border)",
                    borderRadius: 15,
                    padding: "11px 13px",
                    fontFamily: "inherit",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: 5,
                        border: "1.5px solid var(--mv3-fail-card-border)",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9,
                        color: "var(--mv3-fail)",
                      }}
                    >
                      ✕
                    </span>
                    <span
                      style={{
                        fontSize: 13.5,
                        color: "var(--mv3-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {f.line}
                    </span>
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--mv3-fail-text)",
                      paddingLeft: 25,
                      marginTop: 3,
                    }}
                  >
                    Couldn’t save — {f.reason}. Your text is kept.
                  </span>
                </button>
              ))}
            </div>

            {/* The succeeded rows collapse to one quiet ✓ line. */}
            {result.added.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 12,
                  color: "var(--mv3-muted)",
                  padding: "10px 2px 0",
                }}
              >
                <span aria-hidden style={{ color: "var(--mv3-green)" }}>
                  ✓
                </span>
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

            {/* Retry N failed — retries ONLY the failures (they ARE the
                draft now). */}
            <button
              type="button"
              className="cue-pressable"
              disabled={submitting}
              onClick={() => {
                setResult(null);
                void submit();
              }}
              style={{
                ...primaryBtn,
                flex: "initial",
                width: "100%",
                borderRadius: 14,
                padding: 13,
                minHeight: 44,
                marginTop: 16,
                cursor: "pointer",
              }}
            >
              Retry {result.failed.length} failed
            </button>

            {/* Keep in draft — defers losslessly (the lines stay in the
                draft; the sheet closes without clearing anything). */}
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setResult(null);
                close();
              }}
              style={{
                width: "100%",
                minHeight: 40,
                marginTop: 4,
                background: "none",
                border: "none",
                color: "var(--mv3-muted)",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Keep in draft for later
            </button>
          </div>
        ) : null}

        {/* Shield footnote — the trust boundary, said at the moment of entry
            (frame 43: above the button, centered). */}
        {result !== null ? null : (
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
          <span style={{ fontSize: 10, color: "var(--mv3-muted)" }}>
            Added parked — nothing runs or spends until you say so
          </span>
        </div>
        )}

        {result !== null ? null : (
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
        )}
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
