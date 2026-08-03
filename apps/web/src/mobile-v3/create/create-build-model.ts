/**
 * Mobile v3 Create — the build state (J4 → J5).
 *
 * Design's rule 2: "Building is narrated and non-blocking — real thumbnails as
 * they render, a current-step line, a live composer for mid-build redirects, and
 * *You can leave — I'll put it in this thread*. Anything over 30s must survive
 * backgrounding."
 *
 * Three of those four are buildable today. One is not, and this module is
 * explicit about which:
 *
 * - **Narrated current step — REAL.** The chat turn emits tool-call steps over
 *   SSE and the app already derives a human label for each
 *   (`domains/chat/components/tool-progress-card/derive-step-label.ts`). That is
 *   a true "now: …" line.
 * - **Non-blocking + survives backgrounding — REAL.** The build IS a chat turn
 *   against a conversation id minted before navigation. The turn runs
 *   server-side; the client re-attaches by loading that conversation, and the
 *   SSE transport has a resume cursor. `conversationId` here is that handle.
 * - **Live composer for redirects — REAL.** It is the thread's own composer.
 * - **Real thumbnails as they render — NOT AVAILABLE.** There is no partial
 *   artefact stream. Nothing in the daemon emits a per-slide image mid-build,
 *   and the client renders nothing until the run completes. So this module
 *   exposes `skeleton`, never `thumbnails`, and the UI labels it as the template
 *   skeleton (see `create-skeleton.ts`). Showing invented thumbnails that
 *   "fill in" on a timer would be a fabricated generation.
 *
 * Equally deliberate: **there is no total and no percentage.** The step stream is
 * tool-call granularity — it cannot say "slide 7 of 12", and the daemon emits no
 * artefact-count event. `stepsSeen` is a real observed count; there is no
 * denominator, so none is rendered. ("Never a fake number.")
 */

/** Where a build is. `failed` is terminal and never renders as an artefact. */
export type BuildPhase = "queued" | "building" | "delivered" | "failed";

/** A delivered artefact, as the card renders it. */
export interface BuildArtefact {
  /** Display name — the real document/app title from the run. */
  name: string;
  /** The Create type that produced it (drives the remix chips). */
  typeId: string;
  /** The template used, when one was chosen. */
  templateId?: string;
  /**
   * A one-line factual summary of what was produced ("12 slides"). Must be
   * derived from the real artefact; omit rather than estimate.
   */
  measure?: string;
  /** Opens the artefact. Absent means the card shows no Open action. */
  openHref?: string;
}

/** Why a build failed — Cue's own error, first person, verbatim. */
export interface BuildFailure {
  /** The message shown to the user. Never a generic "something went wrong". */
  message: string;
  /** Whether a retry is meaningful. */
  retryable: boolean;
}

export interface BuildState {
  phase: BuildPhase;
  /**
   * The conversation this build runs in. THIS is what makes the build survive
   * backgrounding: the turn executes server-side against this id, and reopening
   * the conversation re-attaches to it. It is also literally where the artefact
   * lands, which is why "I'll put it in this thread" is a true promise.
   */
  conversationId: string;
  typeId: string;
  templateId?: string;
  /** Epoch ms the run started — drives a real elapsed reading. */
  startedAt: number;
  /**
   * The narrated line: what Cue is doing right now, from the real step stream.
   * `null` before the first step arrives — the UI then says "Starting…", never
   * a fabricated step.
   */
  currentStep: string | null;
  /** How many steps we have genuinely observed. No denominator exists. */
  stepsSeen: number;
  artefact: BuildArtefact | null;
  failure: BuildFailure | null;
}

/** A fresh build, queued against a conversation. */
export function startBuild(params: {
  conversationId: string;
  typeId: string;
  templateId?: string;
  now?: number;
}): BuildState {
  return {
    phase: "queued",
    conversationId: params.conversationId,
    typeId: params.typeId,
    templateId: params.templateId,
    startedAt: params.now ?? Date.now(),
    currentStep: null,
    stepsSeen: 0,
    artefact: null,
    failure: null,
  };
}

/** A real step arrived from the turn's tool stream. */
export function observeStep(state: BuildState, label: string): BuildState {
  if (state.phase === "delivered" || state.phase === "failed") return state;
  return {
    ...state,
    phase: "building",
    currentStep: label.trim() || state.currentStep,
    stepsSeen: state.stepsSeen + 1,
  };
}

/**
 * The run finished and produced something.
 *
 * Requires a real artefact. Calling this with nothing is a no-op-as-success,
 * which the invariants forbid — so it routes to `failBuild` instead. A run that
 * ends with no artefact is a failure the user must see, not a silent success.
 */
export function deliverBuild(
  state: BuildState,
  artefact: BuildArtefact | null,
): BuildState {
  if (state.phase === "failed") return state;
  if (!artefact || !artefact.name.trim()) {
    return failBuild(state, {
      message:
        "I finished the run but didn't produce a file. Nothing was filed — I haven't left a half-made thing anywhere.",
      retryable: true,
    });
  }
  return { ...state, phase: "delivered", artefact, failure: null };
}

/** The run failed. Terminal, and never carries an artefact. */
export function failBuild(
  state: BuildState,
  failure: BuildFailure,
): BuildState {
  return { ...state, phase: "failed", failure, artefact: null };
}

/** True when the card may present this as a finished thing. */
export function isDelivered(state: BuildState): boolean {
  return state.phase === "delivered" && state.artefact !== null;
}

/**
 * Elapsed seconds, for the "~50s" reading. Real clock time — this is a
 * measurement, not an estimate, so it is safe to show where a percentage
 * would not be.
 */
export function elapsedSeconds(state: BuildState, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - state.startedAt) / 1000));
}

/** "1m 20s" / "48s". */
export function elapsedLabel(state: BuildState, now: number = Date.now()): string {
  const s = elapsedSeconds(state, now);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * The narrated line. Falls back to an honest "starting" rather than inventing a
 * step, and never renders an ordinal.
 */
export function narrationLine(state: BuildState): string {
  if (state.phase === "queued") return "Starting…";
  if (state.currentStep) return `Now: ${state.currentStep}`;
  return "Working…";
}

/**
 * The status eyebrow. Deliberately carries NO "n of m" — the pipeline emits no
 * artefact count, so any denominator would be invented.
 */
export function statusEyebrow(state: BuildState): string {
  switch (state.phase) {
    case "queued":
      return "QUEUED";
    case "building":
      return "BUILDING";
    case "delivered":
      return "DONE";
    case "failed":
      return "FAILED";
  }
}

/** Design's promise, and it is true: the turn runs server-side. */
export const LEAVE_PROMISE =
  "You can leave — I'll put it in this thread and ping you.";
