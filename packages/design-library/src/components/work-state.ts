/**
 * Autonomy work-loop state model — the single source of truth that maps a
 * work item's backend lifecycle onto the five (+ failure) states the product
 * speaks in: Picked up → Running → Needs you → Review → Done, with Failure as
 * the one place red belongs. Design: autonomy-states v2 ("locked as tokens").
 *
 * The mapping is deliberately narrow so every surface reads the same state for
 * the same item. Each state resolves to an accent token (badge + glyph) and a
 * desaturated wash token for card fills. Colors live in `tokens.css`; this
 * module only names which token a state uses — never a raw hex.
 */

/** The canonical work-item status as the daemon reports it. */
export type WorkItemStatus =
  | "pending"
  | "queued"
  | "running"
  | "awaiting_review"
  | "done"
  | "failed"
  | "cancelled"
  | "archived";

/** The product-facing loop state. */
export type WorkLoopState =
  "capture" | "running" | "needsyou" | "review" | "done" | "failure";

export interface WorkStateMeta {
  state: WorkLoopState;
  /** Short badge label, e.g. "Needs you". */
  label: string;
  /** Longer in-card phrase, e.g. "Needs you to finish". */
  phrase: string;
  /** Single glyph used in the badge square. */
  glyph: string;
  /** CSS var for the accent (badge/glyph/border). */
  accentVar: string;
  /**
   * CSS var for the accent's TEXT leg — the darker stop small copy reads at
   * (design addendum A1). `accentVar` is tuned for fills, glyph marks, rules
   * and display type at 16px and up; below 16px it lands under 4.5:1 on the
   * light canvas, so label copy takes this instead. In dark it resolves to the
   * same value as `accentVar`, so the choice only bites in light.
   *
   * The escape: a state's `glyph` renders next to its label almost everywhere,
   * and where the glyph carries the same fact the accent may still paint the
   * label. Use `textVar` when colour alone carries the meaning.
   */
  textVar: string;
  /** CSS var for the desaturated background wash. */
  weakVar: string;
}

export const WORK_STATE_META: Record<WorkLoopState, WorkStateMeta> = {
  capture: {
    state: "capture",
    label: "Picked up",
    phrase: "Cue picked up",
    glyph: "↴",
    accentVar: "var(--state-capture)",
    textVar: "var(--state-capture-text)",
    weakVar: "var(--state-capture-weak)",
  },
  running: {
    state: "running",
    label: "Running",
    phrase: "Running · auto",
    glyph: "▮",
    accentVar: "var(--state-running)",
    textVar: "var(--state-running-text)",
    weakVar: "var(--state-running-weak)",
  },
  needsyou: {
    state: "needsyou",
    label: "Needs you",
    phrase: "Needs you to finish",
    glyph: "‖",
    accentVar: "var(--state-needsyou)",
    textVar: "var(--state-needsyou-text)",
    weakVar: "var(--state-needsyou-weak)",
  },
  review: {
    state: "review",
    label: "Review",
    phrase: "Ready for review",
    glyph: "◱",
    accentVar: "var(--state-review)",
    textVar: "var(--state-review-text)",
    weakVar: "var(--state-review-weak)",
  },
  done: {
    state: "done",
    label: "Done",
    phrase: "Done",
    glyph: "✓",
    accentVar: "var(--state-done)",
    textVar: "var(--state-done-text)",
    weakVar: "var(--state-done-weak)",
  },
  failure: {
    state: "failure",
    label: "Couldn't finish",
    phrase: "Couldn't finish",
    glyph: "✕",
    accentVar: "var(--state-failure)",
    textVar: "var(--state-failure-text)",
    weakVar: "var(--state-failure-weak)",
  },
};

/**
 * Shape needed to resolve a loop state. Accepts the fields the daemon
 * work-item carries; all optional so callers can pass a partial view.
 */
export interface WorkStateInput {
  status?: WorkItemStatus | string | null;
  /** Approval sub-state — "pending" means a run is paused waiting on you. */
  approvalStatus?: string | null;
  /** True when a headless approval prompt expired (the timeout case). */
  approvalTimedOut?: boolean | null;
}

/**
 * Resolve a work item to its product loop state. Order matters: failure and
 * needs-you win over the raw status because they are the states a person must
 * act on.
 *
 * `awaiting_review` resolves to **needsyou**, not review. Two design
 * deliverables disagreed on this — 07 (autonomy-states) called it "Review",
 * work-surfaces §3 called it "Needs you" — and it is the label on the deck's
 * primary lane and the sidebar badge. Ruled 2026-08-01 in favour of §3.
 *
 * Mapped rather than relabelled: renaming `review` to "Needs you" would leave
 * two states rendering identically. `review` (◱ violet) stays reserved for §3's
 * distinct "Ready for review", which no stored status produces yet.
 */
export function resolveWorkLoopState(input: WorkStateInput): WorkLoopState {
  const status = (input.status ?? "").toString();
  if (status === "failed") return "failure";
  if (input.approvalTimedOut === true) return "needsyou";
  if (input.approvalStatus === "pending" || status === "needs_approval") {
    return "needsyou";
  }
  if (status === "awaiting_review") return "needsyou";
  if (status === "running") return "running";
  if (status === "done") return "done";
  // pending / queued / anything not yet started
  return "capture";
}

export function workStateMeta(input: WorkStateInput): WorkStateMeta {
  return WORK_STATE_META[resolveWorkLoopState(input)];
}

/* -------------------------------------------------------------------------- */
/* Agent identity                                                             */
/* -------------------------------------------------------------------------- */

export interface AgentIdentity {
  /** CSS var for the agent's color. */
  colorVar: string;
  /** Single glyph; the agent's self-chosen emoji wins when provided. */
  glyph: string;
}

/**
 * Known agent color assignments. Names are matched case-insensitively; an
 * unknown agent falls back to the neutral builder tint so we never fake an
 * identity we don't have. Glyphs are defaults — an explicit `emoji` from the
 * roster always overrides.
 */
const AGENT_COLORS: Record<string, { colorVar: string; glyph: string }> = {
  ops: { colorVar: "var(--agent-ops)", glyph: "◆" },
  growth: { colorVar: "var(--agent-growth)", glyph: "▲" },
  inbox: { colorVar: "var(--agent-inbox)", glyph: "✉" },
  builder: { colorVar: "var(--agent-builder)", glyph: "◆" },
};

export function resolveAgentIdentity(
  name: string | null | undefined,
  emoji?: string | null,
): AgentIdentity {
  const key = (name ?? "").trim().toLowerCase();
  const known = AGENT_COLORS[key] ?? {
    colorVar: "var(--agent-builder)",
    glyph: "◆",
  };
  const glyph = emoji?.trim() ? emoji.trim() : known.glyph;
  return { colorVar: known.colorVar, glyph };
}
