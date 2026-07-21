/**
 * The pre-run assessment, in mobile-v3 grammar.
 *
 * The VOCABULARY is not re-invented here: verdicts, guards and the "waits on a
 * person" rule all come from `@/pages/hq/assessment-kit`
 * (`readAssessment` / `holdsForYou` / `holdReason` / `blockedFixKind`), which is
 * the same module the desktop drawer and HQ read. What this file adds is the
 * phone rendering — SF Pro, the `--mv3-*` tokens, `StateChip`, 44pt targets —
 * because the kit's own panel is drawn in the serif-HQ language and would read
 * as a foreign object inside an mv3 sheet.
 *
 * Two pieces:
 *   · `Mv3AssessmentMark` — the list badge. Renders for the TWO verdicts that
 *     wait on a human and nothing else, so a list never becomes a wall of
 *     badges. Same words as the kit's `AssessmentSignal` ("Question" /
 *     "Blocked"), in the mv3 needs-you chip.
 *   · `Mv3AssessmentPanel` — the sheet panel: what Cue understood and what it
 *     plans to do, or the one thing it needs from you first.
 *
 * An item with no verdict renders NOTHING (the kit's guards return null) — the
 * surface looks exactly as it did before assessment existed. No spinner, no
 * empty shell.
 *
 * Long text (a question, a missing thing) is daemon-supplied and can run long.
 * Every text node here wraps: no `nowrap`, no ellipsis, `minWidth: 0` on flex
 * children, and the mv3 `overflow-wrap: break-word` rule catches unbreakable
 * URLs/tokens. Verified at 390px.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

import {
  holdsForYou,
  type AssessedItem,
  type Assessment,
} from "@/pages/hq/assessment-kit";
import { haptic } from "@/utils/haptics";

import { microLabel, mv3Mono } from "./mv3-kit";
import { StateChip } from "./state-chip";

/** Below this the assessor is telling us it wasn't sure, so the copy says so. */
const UNSURE_BELOW = 0.5;

/* -------------------------------------------------------------------------- */
/* List signal                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The one-glance "this row waits on you" mark for mv3 lists. Quiet by
 * construction: `execute` and `not_ai_task` get nothing.
 */
export function Mv3AssessmentMark({
  item,
  size = "sm",
}: {
  item: AssessedItem | null | undefined;
  size?: "sm" | "md";
}) {
  const hold = holdsForYou(item);
  if (!hold) return null;
  return (
    <StateChip
      state="needs_you"
      size={size}
      label={hold === "clarify" ? "Question" : "Blocked"}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

export interface Mv3AssessmentFix {
  label: string;
  onClick: () => void;
}

export interface Mv3AssessmentPanelProps {
  assessment: Assessment;
  /** True while the item's run is actually in flight. */
  running?: boolean;
  /**
   * The inline write-back. The text lands in the task's own `context` — the
   * field the next run re-reads — so answering here is what un-sticks the item.
   * Shown for `clarify`, and for a `blocked` verdict that has no real fix
   * destination on this surface (the phone has no Context editor to send
   * someone to, so the panel carries the field itself).
   */
  onAnswer?: (answer: string) => void;
  answerPending?: boolean;
  answerFailed?: boolean;
  /** `not_ai_task` — the human-appropriate close. */
  onMarkDone?: () => void;
  markDonePending?: boolean;
  /** The override. Always available, never the loud option. */
  onRunAnyway?: () => void;
  runPending?: boolean;
  /** `blocked` — the one destination that fixes the named thing, if we have one. */
  fix?: Mv3AssessmentFix | null;
  /** "checked 4m ago" stamp, pre-formatted by the caller. */
  checked?: string | null;
}

export function Mv3AssessmentPanel({
  assessment,
  running = false,
  onAnswer,
  answerPending = false,
  answerFailed = false,
  onMarkDone,
  markDonePending = false,
  onRunAnyway,
  runPending = false,
  fix = null,
  checked = null,
}: Mv3AssessmentPanelProps) {
  const [answer, setAnswer] = useState("");
  const unsure =
    assessment.confidence != null && assessment.confidence < UNSURE_BELOW;
  const held = assessment.verdict !== "execute";

  const submit = onAnswer
    ? () => {
        const trimmed = answer.trim();
        if (!trimmed) return;
        haptic.medium();
        onAnswer(trimmed);
        setAnswer("");
      }
    : undefined;

  return (
    <div
      data-slot="mv3-assessment-panel"
      data-verdict={assessment.verdict}
      style={{
        marginTop: 14,
        boxSizing: "border-box",
        border: held
          ? "1px solid color-mix(in srgb, var(--mv3-amber) 34%, transparent)"
          : "1px solid var(--mv3-card-border)",
        borderRadius: 16,
        background: held
          ? "color-mix(in srgb, var(--mv3-amber) 7%, transparent)"
          : "var(--mv3-btn2-bg)",
        padding: "12px 13px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: held || running ? 9 : 0,
        }}
      >
        {/* `execute` is headed only while the run is live — the "checked when"
            stamp already dates it honestly, and a fixed "before it runs" would
            read as a lie on a task that has already finished. */}
        {assessment.verdict === "execute" ? (
          running ? (
            <span style={{ ...microLabel, fontSize: 9.5, color: "var(--mv3-micro)" }}>
              Cue is on it
            </span>
          ) : null
        ) : (
          <StateChip
            state="needs_you"
            size="sm"
            label={
              assessment.verdict === "clarify"
                ? "Question"
                : assessment.verdict === "blocked"
                  ? "Blocked"
                  : "Yours to do"
            }
          />
        )}
        {checked ? (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: mv3Mono,
              fontSize: 10,
              color: "var(--mv3-faint)",
            }}
          >
            checked {checked}
          </span>
        ) : null}
      </div>

      {assessment.verdict === "execute" ? (
        <ExecuteBody assessment={assessment} />
      ) : assessment.verdict === "clarify" ? (
        <Lede
          quiet="I need one thing before I can run this. It is parked until then."
          loud={assessment.question ?? ""}
        />
      ) : assessment.verdict === "not_ai_task" ? (
        <NotAiTaskBody understanding={assessment.understanding} />
      ) : (
        <BlockedBody missing={assessment.missing ?? ""} hasFix={fix != null} />
      )}

      {unsure ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--mv3-faint)",
            marginTop: 9,
            lineHeight: 1.5,
          }}
        >
          Cue was not sure about this read — check it before you run it.
        </div>
      ) : null}

      {submit ? (
        <AnswerField
          value={answer}
          onChange={setAnswer}
          onSubmit={submit}
          pending={answerPending}
          failed={answerFailed}
          label={assessment.verdict === "clarify" ? "Answer" : "Save it"}
        />
      ) : null}

      {/* A held task always keeps a door out: the human-appropriate close where
          there is one, and the override, quietly, underneath. */}
      {held ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 10,
          }}
        >
          {assessment.verdict === "not_ai_task" && onMarkDone ? (
            <PanelBtn
              disabled={markDonePending}
              onClick={() => {
                haptic.medium();
                onMarkDone();
              }}
            >
              {markDonePending ? "Marking done…" : "Mark it done"}
            </PanelBtn>
          ) : null}
          {assessment.verdict === "blocked" && fix ? (
            <PanelBtn
              onClick={() => {
                haptic.light();
                fix.onClick();
              }}
            >
              {fix.label}
            </PanelBtn>
          ) : null}
          {onRunAnyway ? (
            <QuietBtn
              disabled={runPending}
              onClick={() => {
                haptic.medium();
                onRunAnyway();
              }}
            >
              {runPending
                ? "Starting…"
                : assessment.verdict === "not_ai_task"
                  ? "Ask Cue anyway"
                  : "Run it anyway"}
            </QuietBtn>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------- bodies --------------------------------- */

function ExecuteBody({ assessment }: { assessment: Assessment }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {assessment.understanding ? (
        <Block label="Here is what I understood" strong>
          {assessment.understanding}
        </Block>
      ) : null}
      {assessment.plan ? (
        <Block label="Here is my plan">{assessment.plan}</Block>
      ) : null}
    </div>
  );
}

function NotAiTaskBody({ understanding }: { understanding: string | null }) {
  return (
    <div>
      <div style={loudLine}>This one needs a person, not Cue.</div>
      {understanding ? (
        <div style={{ ...quietLine, marginTop: 7 }}>{understanding}</div>
      ) : null}
      <div
        style={{
          fontSize: 11,
          color: "var(--mv3-faint)",
          lineHeight: 1.5,
          marginTop: 7,
        }}
      >
        Cue can be wrong about this. If it can help, ask it anyway.
      </div>
    </div>
  );
}

function BlockedBody({
  missing,
  hasFix,
}: {
  missing: string;
  hasFix: boolean;
}) {
  return (
    <div>
      <div style={quietLine}>I cannot start this yet. One thing is missing:</div>
      <div style={{ ...loudLine, marginTop: 8 }}>{missing}</div>
      {hasFix ? null : (
        <div
          style={{
            fontSize: 11,
            color: "var(--mv3-faint)",
            lineHeight: 1.5,
            marginTop: 7,
          }}
        >
          Tell Cue where to find it and it will read this before the next run.
        </div>
      )}
    </div>
  );
}

/** The parked lede: one quiet sentence, then the assessor's own words. */
function Lede({ quiet, loud }: { quiet: string; loud: string }) {
  return (
    <div>
      <div style={quietLine}>{quiet}</div>
      <div style={{ ...loudLine, marginTop: 8 }}>{loud}</div>
    </div>
  );
}

/* --------------------------------- atoms ---------------------------------- */

const loudLine: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--mv3-text)",
  lineHeight: 1.4,
};

const quietLine: CSSProperties = {
  fontSize: 12.5,
  color: "var(--mv3-muted)",
  lineHeight: 1.5,
};

function Block({
  label,
  strong = false,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{ ...microLabel, fontSize: 9.5, color: "var(--mv3-faint)" }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: strong ? "var(--mv3-text)" : "var(--mv3-muted)",
          lineHeight: 1.5,
          marginTop: 5,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The inline write-back. 16px so iOS doesn't zoom the sheet on focus; the
 * button sits under the field (not beside it) so a long label never squeezes
 * the input at 390px.
 */
function AnswerField({
  value,
  onChange,
  onSubmit,
  pending,
  failed,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  pending: boolean;
  failed: boolean;
  label: string;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <textarea
        value={value}
        aria-label="Your answer"
        onChange={(e) => onChange(e.target.value)}
        placeholder="Answer in a line or two…"
        rows={2}
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontSize: 16,
          lineHeight: 1.45,
          fontFamily: "inherit",
          color: "var(--mv3-text)",
          background: "var(--mv3-btn2-bg)",
          border: "1px solid var(--mv3-btn2-border)",
          borderRadius: 12,
          padding: "9px 11px",
          outline: "none",
          resize: "vertical",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 7,
        }}
      >
        <PanelBtn
          disabled={pending || value.trim().length === 0}
          onClick={onSubmit}
        >
          {pending ? "Saving…" : label}
        </PanelBtn>
        <span
          style={{
            flex: 1,
            minWidth: 120,
            fontSize: 11,
            color: "var(--mv3-faint)",
            lineHeight: 1.4,
          }}
        >
          Saved with the task. Cue re-reads it before the next run.
        </span>
      </div>
      {failed ? (
        <div style={{ fontSize: 11, color: "var(--mv3-amber)", marginTop: 6 }}>
          That did not save. Try again.
        </div>
      ) : null}
    </div>
  );
}

function PanelBtn({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      disabled={disabled}
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: 600,
        color: "var(--mv3-bg)",
        background: "var(--mv3-text)",
        border: "none",
        borderRadius: 11,
        padding: "11px 16px",
        minHeight: 44,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        maxWidth: "100%",
      }}
    >
      {children}
    </button>
  );
}

function QuietBtn({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cue-pressable"
      disabled={disabled}
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        color: "var(--mv3-faint)",
        background: "none",
        border: "none",
        padding: "12px 2px",
        minHeight: 44,
        cursor: disabled ? "default" : "pointer",
        textDecoration: "underline",
        textUnderlineOffset: 3,
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        maxWidth: "100%",
      }}
    >
      {children}
    </button>
  );
}
