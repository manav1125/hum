/**
 * Teach: the owner demonstrates a task on their screen, and Cue turns the
 * demonstration into a skill.
 *
 * ## Why this is its own session, not a mode on the ambient one
 *
 * `cue-live/observation-capture.ts` owns the ambient screen→work-item
 * pipeline: it has extraction and item budgets, dedupe by digest, and a
 * sensitivity gate, all tuned for watching a working day and filing the few
 * things worth filing. A demonstration wants the opposite of most of that. It
 * wants EVERY step in order, including the repetitive ones, because the order
 * is the procedure. Running it through the ambient budgets would dedupe away
 * the repetition that makes a workflow a workflow, and filing a todo per step
 * would bury the user in noise for something they are doing on purpose.
 *
 * So this keeps its own state and drives the same loop with its own sink. The
 * two never share counters, and starting one does not arm the other.
 *
 * ## The bounds are the product, not a safety afterthought
 *
 * A demonstration has an owner who starts it, an owner who stops it, and an
 * expiry that stops it regardless. Those three are what make the signal good:
 * the start and stop label where the workflow begins and ends, so Cue is not
 * guessing boundaries out of a day. They are also what make it something a
 * person can reason about — "it is watching until I stop it, and at most N
 * minutes" is a sentence an owner can hold.
 *
 * Nothing here captures anything on its own. It records what the driver hands
 * it, and the driver only looks while {@link isTeachSessionArmed} says so.
 */

import type { ScreenObservationInput } from "../cue-live/observation-capture.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("teach-session");

/**
 * Hard ceiling on a demonstration, regardless of what the caller asks for.
 *
 * A demonstration is something a person performs while present. Beyond about
 * half an hour it is no longer a demonstration, it is ambient watching under
 * another name, and ambient watching is a different product with a different
 * consent conversation. Callers may ask for less; they cannot ask for more,
 * and omitting the duration means this, never "forever".
 */
export const TEACH_SESSION_MAX_MINUTES = 30;

/** Default when the caller does not state a duration. */
export const TEACH_SESSION_DEFAULT_MINUTES = 10;

/**
 * Cap on retained steps.
 *
 * A demonstration that produced more than this is either much longer than
 * intended or is looping, and in both cases the tail is what matters least:
 * the synthesis reads the procedure from the beginning. Dropping the OLDEST
 * would lose the setup steps that make the rest legible, so the cap drops the
 * newest and says so, rather than silently sliding a window.
 */
const MAX_TEACH_STEPS = 240;

export interface TeachStep {
  /** Ordinal within the demonstration, from 1. The procedure is the order. */
  index: number;
  /** Epoch ms when the host answered. */
  at: number;
  /** Seconds since the demonstration started, for pacing in the transcript. */
  offsetSeconds: number;
  /** Foreground application, when the host could name it. */
  appName?: string;
  /** What the host read off the screen. */
  description: string;
}

interface TeachSessionState {
  id: string;
  /** What the owner said they were about to demonstrate. */
  goal: string;
  startedMs: number;
  expiresMs: number;
  steps: TeachStep[];
  /** Steps refused by the cap, so the transcript can admit the truncation. */
  dropped: number;
}

export interface TeachSessionView {
  armed: boolean;
  sessionId: string | null;
  goal: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  secondsRemaining: number;
  stepCount: number;
  /** Steps refused by the retention cap. */
  droppedSteps: number;
  /** Newest last, so a reader sees the procedure in the order it happened. */
  steps: TeachStep[];
}

let session: TeachSessionState | null = null;

/**
 * The last finished demonstration, kept so `stop` and the synthesis step do
 * not have to happen in the same call. Cleared when a new one starts: two
 * demonstrations must never blend into one skill.
 */
let lastCompleted: TeachSessionState | null = null;

function expired(now: number): boolean {
  return session !== null && now >= session.expiresMs;
}

/**
 * Retire an expired session into `lastCompleted` rather than discarding it.
 *
 * An owner who demonstrates for the full duration and then asks Cue to write
 * the skill has done nothing wrong, and losing their work because a timer
 * fired first would be the worst possible reading of a safety bound. The
 * bound stops the WATCHING; it does not throw away what was already seen.
 */
function retireIfExpired(now: number): void {
  if (!expired(now)) return;
  log.info(
    { sessionId: session!.id, steps: session!.steps.length },
    "Teach session expired; retaining the demonstration for synthesis",
  );
  lastCompleted = session;
  session = null;
}

/** True while a demonstration is running and unexpired. */
export function isTeachSessionArmed(now: number = Date.now()): boolean {
  retireIfExpired(now);
  return session !== null;
}

/**
 * Begin a demonstration.
 *
 * The duration is clamped to {@link TEACH_SESSION_MAX_MINUTES}. Starting a new
 * demonstration discards any previous one, completed or not: a skill is built
 * from exactly one demonstration, and silently appending to an older timeline
 * would produce a procedure nobody performed.
 */
export function startTeachSession(opts: {
  goal: string;
  durationMinutes?: number;
  now?: number;
}): TeachSessionView {
  const now = opts.now ?? Date.now();
  const requested =
    opts.durationMinutes != null && Number.isFinite(opts.durationMinutes)
      ? Math.max(1, Math.floor(opts.durationMinutes))
      : TEACH_SESSION_DEFAULT_MINUTES;
  const minutes = Math.min(requested, TEACH_SESSION_MAX_MINUTES);

  lastCompleted = null;
  session = {
    id: crypto.randomUUID(),
    goal: opts.goal.trim(),
    startedMs: now,
    expiresMs: now + minutes * 60_000,
    steps: [],
    dropped: 0,
  };
  log.info(
    { sessionId: session.id, minutes, goal: session.goal },
    "Teach session started",
  );
  return buildView(now);
}

/**
 * Record one observed step.
 *
 * Called by the driver's sink. Observations that arrive after the session
 * ended are dropped rather than appended: a step the owner performed after
 * saying "stop" is not part of what they chose to teach.
 */
export function recordTeachStep(
  observation: ScreenObservationInput,
  now: number = Date.now(),
): void {
  retireIfExpired(now);
  if (!session) return;

  const description = (observation.description ?? "").trim();
  // An observation with no readable text tells us nothing about the
  // procedure. The image alone is not retained: a skill is written from what
  // was understood, and keeping frames would make this a screen recorder.
  if (!description) return;

  if (session.steps.length >= MAX_TEACH_STEPS) {
    session.dropped += 1;
    return;
  }

  // `at` is optional on the wire. Falling back to now keeps the ordering and
  // the pacing honest for a host that did not stamp its reply, rather than
  // dropping a step that was genuinely observed over a missing field.
  const at = observation.at ?? now;
  session.steps.push({
    index: session.steps.length + 1,
    at,
    offsetSeconds: Math.max(0, Math.round((at - session.startedMs) / 1000)),
    ...(observation.appName ? { appName: observation.appName } : {}),
    description,
  });
}

/**
 * End the demonstration and keep it for synthesis. Idempotent.
 *
 * Returns the view of what was captured so the caller can tell the owner what
 * it saw before writing anything.
 */
export function stopTeachSession(now: number = Date.now()): TeachSessionView {
  if (session) {
    log.info(
      { sessionId: session.id, steps: session.steps.length },
      "Teach session stopped",
    );
    lastCompleted = session;
    session = null;
  }
  return buildView(now);
}

/** Current demonstration if one is running, else the last finished one. */
export function getTeachSessionView(
  now: number = Date.now(),
): TeachSessionView {
  retireIfExpired(now);
  return buildView(now);
}

/**
 * The demonstration synthesis should read: the live one if it is still
 * running, otherwise the last finished one. `null` when nothing has been
 * demonstrated, which is distinct from a demonstration that saw nothing.
 */
export function getTeachTimeline(now: number = Date.now()): {
  sessionId: string;
  goal: string;
  startedAt: string;
  steps: TeachStep[];
  droppedSteps: number;
} | null {
  retireIfExpired(now);
  const source = session ?? lastCompleted;
  if (!source) return null;
  return {
    sessionId: source.id,
    goal: source.goal,
    startedAt: new Date(source.startedMs).toISOString(),
    steps: source.steps,
    droppedSteps: source.dropped,
  };
}

function buildView(now: number): TeachSessionView {
  const source = session ?? lastCompleted;
  if (!source) {
    return {
      armed: false,
      sessionId: null,
      goal: null,
      startedAt: null,
      expiresAt: null,
      secondsRemaining: 0,
      stepCount: 0,
      droppedSteps: 0,
      steps: [],
    };
  }
  const live = session !== null;
  return {
    armed: live,
    sessionId: source.id,
    goal: source.goal,
    startedAt: new Date(source.startedMs).toISOString(),
    expiresAt: new Date(source.expiresMs).toISOString(),
    secondsRemaining: live
      ? Math.max(0, Math.round((source.expiresMs - now) / 1000))
      : 0,
    stepCount: source.steps.length,
    droppedSteps: source.dropped,
    steps: source.steps,
  };
}

/** Test seam: drop all teach state. */
export function _resetTeachSessionForTests(): void {
  session = null;
  lastCompleted = null;
}
