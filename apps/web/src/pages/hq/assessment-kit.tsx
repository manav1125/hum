/**
 * Pre-run assessment kit — the visible half of "Cue understood this before it
 * ran it".
 *
 * Before a work item's agent turn, the daemon runs one cheap assessment pass
 * (assistant/src/work-items/work-item-assessment.ts) and stores a verdict on
 * the item: `execute` (with a plain-words plan), `clarify` (one question),
 * `not_ai_task` (a person's job), or `blocked` (one named missing thing). A
 * non-`execute` verdict returns the item to the queue, parked, so the run is
 * HELD rather than producing something plausible and wrong.
 *
 * This module renders that verdict in the serif-HQ language, and gives the
 * lists a one-glance signal for the two verdicts that wait on a human. Nothing
 * here invents content: every line is either fixed product copy or a string the
 * assessor actually produced. An item with no verdict renders nothing at all.
 */

import { StateBadge } from "@vellumai/design-library";
import { useState, type ReactNode } from "react";

import { C, mono, relativeTime } from "@/domains/activity/theme";

import { MicroLabel } from "./hq-kit";

export type AssessmentVerdict =
  "execute" | "clarify" | "not_ai_task" | "blocked";

/**
 * The assessment fields as they ride on a work item (the daemon's work-item
 * wire shape). Loosely typed so every caller's row type fits: the project
 * board's `BoardItem`, HQ's `HqWorkItem`, and anything narrowed in between.
 */
export interface AssessedItem {
  assessmentVerdict?: string | null;
  assessmentUnderstanding?: string | null;
  assessmentPlan?: string | null;
  assessmentQuestion?: string | null;
  assessmentMissing?: string | null;
  assessmentConfidence?: number | null;
  assessmentAt?: number | null;
}

export interface Assessment {
  verdict: AssessmentVerdict;
  understanding: string | null;
  plan: string | null;
  question: string | null;
  missing: string | null;
  confidence: number | null;
  assessedAt: number | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Read the stored verdict off an item, or null when there is nothing honest to
 * show. Null covers three cases, all rendered identically (as before this
 * feature existed): never assessed, an unknown verdict from a newer daemon, and
 * a verdict whose payload is missing the one thing it exists to say — a
 * `clarify` with no question, a `blocked` with nothing named, an `execute` that
 * produced neither an understanding nor a plan. No empty shells.
 */
export function readAssessment(
  item: AssessedItem | null | undefined,
): Assessment | null {
  if (!item) return null;
  const verdict = text(item.assessmentVerdict);
  if (
    verdict !== "execute" &&
    verdict !== "clarify" &&
    verdict !== "not_ai_task" &&
    verdict !== "blocked"
  ) {
    return null;
  }
  const assessment: Assessment = {
    verdict,
    understanding: text(item.assessmentUnderstanding),
    plan: text(item.assessmentPlan),
    question: text(item.assessmentQuestion),
    missing: text(item.assessmentMissing),
    confidence:
      typeof item.assessmentConfidence === "number" &&
      Number.isFinite(item.assessmentConfidence)
        ? item.assessmentConfidence
        : null,
    assessedAt:
      typeof item.assessmentAt === "number" && item.assessmentAt > 0
        ? item.assessmentAt
        : null,
  };
  if (verdict === "clarify" && !assessment.question) return null;
  if (verdict === "blocked" && !assessment.missing) return null;
  if (verdict === "execute" && !assessment.understanding && !assessment.plan) {
    return null;
  }
  return assessment;
}

/**
 * The two verdicts that hold a task until a person acts. Everything else
 * returns null so lists stay quiet: only rows that need you get a badge.
 */
export function holdsForYou(
  item: AssessedItem | null | undefined,
): "clarify" | "blocked" | null {
  const assessment = readAssessment(item);
  if (!assessment) return null;
  if (assessment.verdict === "clarify") return "clarify";
  if (assessment.verdict === "blocked") return "blocked";
  return null;
}

/** The held row's one-line reason, in the assessor's own words. */
export function holdReason(
  item: AssessedItem | null | undefined,
): string | null {
  const assessment = readAssessment(item);
  if (!assessment) return null;
  if (assessment.verdict === "clarify") return assessment.question;
  if (assessment.verdict === "blocked") return assessment.missing;
  return null;
}

/**
 * List-level signal — the shared work-loop "needs you" badge, labelled with
 * which kind of hold it is. Renders nothing for items that don't wait on a
 * person, so a list never turns into a wall of badges.
 */
export function AssessmentSignal({
  item,
  size = "sm",
}: {
  item: AssessedItem | null | undefined;
  size?: "sm" | "md";
}) {
  const hold = holdsForYou(item);
  if (!hold) return null;
  return (
    <StateBadge
      state="needsyou"
      size={size}
      label={hold === "clarify" ? "Question" : "Blocked"}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

/** Below this the assessor is telling us it wasn't sure, so the copy says so. */
const UNSURE_BELOW = 0.5;

export interface AssessmentFix {
  label: string;
  onClick: () => void;
}

export interface AssessmentPanelProps {
  assessment: Assessment;
  /** True while the item's run is actually in flight. */
  running?: boolean;
  /** `clarify` — the answer is written into the task's context. */
  onAnswer?: (answer: string) => void;
  answerPending?: boolean;
  answerFailed?: boolean;
  /** `not_ai_task` — the human-appropriate close. */
  onMarkDone?: () => void;
  markDonePending?: boolean;
  /** The override, always available, never the loud option. */
  onRunAnyway?: () => void;
  runPending?: boolean;
  /**
   * `blocked` — the one real destination that fixes the named thing, when this
   * surface has one. Absent means we say what's needed instead of shipping a
   * button that goes nowhere.
   */
  fix?: AssessmentFix | null;
}

/**
 * What Cue understood, and what it is going to do about it — shown above the
 * trail on a task's detail surface, before and during the run.
 */
export function AssessmentPanel({
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
}: AssessmentPanelProps) {
  const [answer, setAnswer] = useState("");
  const unsure =
    assessment.confidence != null && assessment.confidence < UNSURE_BELOW;
  const checked = relativeTime(assessment.assessedAt);

  return (
    <div
      data-slot="assessment-panel"
      data-verdict={assessment.verdict}
      style={{
        marginTop: 14,
        border: `1px solid ${
          assessment.verdict === "execute"
            ? C.line
            : `color-mix(in srgb, ${C.amber} 40%, ${C.line})`
        }`,
        borderRadius: 12,
        background: C.sunken,
        padding: "12px 13px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 9,
        }}
      >
        {/* An `execute` verdict is headed only while the run is live; the
            "checked <when>" stamp below already dates it honestly, and a fixed
            "before it runs" would read as a lie on a task that has finished. */}
        {assessment.verdict === "execute" ? (
          running ? (
            <MicroLabel style={{ fontSize: 9 }}>Cue is on it</MicroLabel>
          ) : null
        ) : (
          <StateBadge
            state="needsyou"
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
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
            }}
          >
            checked {checked}
          </span>
        ) : null}
      </div>

      {assessment.verdict === "execute" ? (
        <ExecuteBody assessment={assessment} />
      ) : assessment.verdict === "clarify" ? (
        <ClarifyBody
          question={assessment.question ?? ""}
          answer={answer}
          onAnswerChange={setAnswer}
          onSubmit={
            onAnswer
              ? () => {
                  const trimmed = answer.trim();
                  if (!trimmed) return;
                  onAnswer(trimmed);
                  setAnswer("");
                }
              : undefined
          }
          pending={answerPending}
          failed={answerFailed}
        />
      ) : assessment.verdict === "not_ai_task" ? (
        <NotAiTaskBody understanding={assessment.understanding} />
      ) : (
        <BlockedBody missing={assessment.missing ?? ""} fix={fix} />
      )}

      {unsure ? (
        <div
          style={{
            fontSize: 11,
            color: C.t3,
            marginTop: 9,
            lineHeight: 1.5,
          }}
        >
          Cue was not sure about this read. If it got the task wrong, say so in
          Context below.
        </div>
      ) : null}

      {/* Actions. A held task always keeps a door out: the human-appropriate
          close where there is one, and the override, quietly, underneath. */}
      {assessment.verdict !== "execute" ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 11,
          }}
        >
          {assessment.verdict === "not_ai_task" && onMarkDone ? (
            <PanelButton disabled={markDonePending} onClick={onMarkDone}>
              {markDonePending ? "Marking done…" : "Mark it done"}
            </PanelButton>
          ) : null}
          {assessment.verdict === "blocked" && fix ? (
            <PanelButton onClick={fix.onClick}>{fix.label}</PanelButton>
          ) : null}
          {onRunAnyway ? (
            <QuietButton disabled={runPending} onClick={onRunAnyway}>
              {runPending
                ? "Starting…"
                : assessment.verdict === "not_ai_task"
                  ? "Ask Cue anyway"
                  : "Run it anyway"}
            </QuietButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExecuteBody({ assessment }: { assessment: Assessment }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {assessment.understanding ? (
        <Block label="Here is what I understood" tone="ink">
          {assessment.understanding}
        </Block>
      ) : null}
      {assessment.plan ? (
        <Block label="Here is my plan" tone="t2">
          {assessment.plan}
        </Block>
      ) : null}
    </div>
  );
}

function ClarifyBody({
  question,
  answer,
  onAnswerChange,
  onSubmit,
  pending,
  failed,
}: {
  question: string;
  answer: string;
  onAnswerChange: (value: string) => void;
  onSubmit?: () => void;
  pending: boolean;
  failed: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
        I need one thing before I can run this. It is parked until then.
      </div>
      <div
        style={{
          fontSize: 14,
          color: C.ink,
          lineHeight: 1.45,
          marginTop: 8,
          fontWeight: 500,
        }}
      >
        {question}
      </div>
      {onSubmit ? (
        <>
          <textarea
            value={answer}
            aria-label="Your answer"
            onChange={(e) => onAnswerChange(e.target.value)}
            placeholder="Answer in a line or two…"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginTop: 9,
              fontSize: 13,
              lineHeight: 1.5,
              fontFamily: "inherit",
              color: C.ink,
              background: C.bg,
              border: `1px solid ${C.line2}`,
              borderRadius: 9,
              padding: "8px 10px",
              outline: "none",
              resize: "vertical",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 8,
            }}
          >
            <PanelButton
              disabled={pending || answer.trim().length === 0}
              onClick={onSubmit}
            >
              {pending ? "Saving…" : "Answer"}
            </PanelButton>
            <span style={{ fontSize: 11, color: C.t3, lineHeight: 1.4 }}>
              Saved with the task. Cue re-reads it before the next run.
            </span>
          </div>
          {failed ? (
            <div style={{ fontSize: 11, color: C.amber, marginTop: 6 }}>
              That did not save. Try again.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NotAiTaskBody({ understanding }: { understanding: string | null }) {
  return (
    <div>
      <div
        style={{
          fontSize: 14,
          color: C.ink,
          lineHeight: 1.45,
          fontWeight: 500,
        }}
      >
        This one needs a person, not Cue.
      </div>
      {understanding ? (
        <div
          style={{
            fontSize: 12.5,
            color: C.t2,
            lineHeight: 1.5,
            marginTop: 7,
          }}
        >
          {understanding}
        </div>
      ) : null}
      <div style={{ fontSize: 11, color: C.t3, lineHeight: 1.5, marginTop: 7 }}>
        Cue can be wrong about this. If it can help, ask it anyway.
      </div>
    </div>
  );
}

function BlockedBody({
  missing,
  fix,
}: {
  missing: string;
  fix: AssessmentFix | null;
}) {
  return (
    <div>
      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
        I cannot start this yet. One thing is missing:
      </div>
      <div
        style={{
          fontSize: 14,
          color: C.ink,
          lineHeight: 1.45,
          marginTop: 8,
          fontWeight: 500,
        }}
      >
        {missing}
      </div>
      {fix ? null : (
        <div
          style={{ fontSize: 11, color: C.t3, lineHeight: 1.5, marginTop: 7 }}
        >
          Add it in Context below, or attach it to the project, then run this
          again.
        </div>
      )}
    </div>
  );
}

function Block({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "ink" | "t2";
  children: ReactNode;
}) {
  return (
    <div>
      <MicroLabel style={{ fontSize: 9 }}>{label}</MicroLabel>
      <div
        style={{
          fontSize: 13,
          color: tone === "ink" ? C.ink : C.t2,
          lineHeight: 1.5,
          marginTop: 5,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function PanelButton({
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
      disabled={disabled}
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        color: C.bg,
        background: C.ink,
        border: "none",
        borderRadius: 8,
        padding: "6px 13px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function QuietButton({
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
      disabled={disabled}
      onClick={onClick}
      style={{
        fontFamily: "inherit",
        fontSize: 11.5,
        color: C.t3,
        background: "transparent",
        border: "none",
        padding: "6px 2px",
        cursor: disabled ? "default" : "pointer",
        textDecoration: "underline",
        textUnderlineOffset: 3,
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Blocked → the fix that actually exists                                     */
/* -------------------------------------------------------------------------- */

/**
 * Classify the assessor's `missing` line into a destination this app really
 * has. Only clear signals match; anything else returns null and the panel says
 * what is needed instead of offering a button that goes nowhere.
 */
export function blockedFixKind(
  missing: string | null | undefined,
): "connect" | "attach" | null {
  if (!missing) return null;
  const m = missing.toLowerCase();
  if (
    /\b(connect|connected|link|linked|account|oauth|integration|integrations|sign in|signed in|log in|logged in|credential|credentials|api key|access token)\b/.test(
      m,
    )
  ) {
    return "connect";
  }
  if (
    /\b(attach|attached|attachment|file|files|document|documents|doc|docs|upload|uploaded|pdf|deck|spreadsheet|transcript)\b/.test(
      m,
    )
  ) {
    return "attach";
  }
  return null;
}
