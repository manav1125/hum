/**
 * Cue Live remote-viewer session state.
 *
 * Screen capture and the overlay live entirely in the macOS app — the daemon
 * never holds frames and has no control channel into the native engine. What
 * the daemon *genuinely* sees is the stream of guidance / look / act calls the
 * Mac makes while a Cue Live session runs. This module records that stream
 * (metadata only — never screenshot bytes) so other clients (the phone) can
 * watch a session remotely, and exposes the two remote controls the daemon can
 * honestly provide:
 *
 * - **Pause**: while held, the daemon answers the Mac's guidance/look/act
 *   calls inertly (overlay falls back to its local heuristics; an in-flight
 *   auto-run ends). This is a real hold — the daemon is the brain behind
 *   those calls — but it does not switch off capture on the Mac.
 * - **Stop**: a one-shot abort of the auto-run in flight. The act loop asks
 *   the daemon for every next step, so answering `done` genuinely ends the
 *   run. Expires unconsumed after a short TTL so a stale tap can't kill a
 *   run started hours later.
 *
 * All state is in-memory: a daemon restart forgets the session, which is
 * honest — after a restart the daemon really doesn't know what the Mac is
 * doing until the next call arrives.
 */

/** An observation newer than this marks the session as live. */
const ACTIVE_WINDOW_MS = 2 * 60_000;
/** A gap longer than this starts a new session (resets the duration clock). */
const SESSION_GAP_MS = 5 * 60_000;
/** Ring-buffer cap for the extraction stream. */
const MAX_OBSERVATIONS = 30;
/** How long an unconsumed remote-stop request stays armed. */
const STOP_REQUEST_TTL_MS = 60_000;
/** Longest detail line kept per observation. */
const MAX_DETAIL_CHARS = 240;

export type CueLiveObservationKind = "guidance" | "look" | "act";

export interface CueLiveObservation {
  id: number;
  kind: CueLiveObservationKind;
  /** ISO timestamp of when the daemon saw the call. */
  at: string;
  /** One-line description of what happened (question / goal / summon). */
  summary: string;
  /** What Cue said back (answer / spoken update), truncated. */
  detail?: string;
  /**
   * `active` while an act run is still stepping; `done` once finished;
   * `held` when the daemon answered inertly because of a remote pause.
   */
  status: "active" | "done" | "held";
}

export interface CueLiveWatching {
  /** Frontmost app the Mac last reported (guidance calls carry it). */
  appName: string | null;
  /** Pixel size of the last screenshot the Mac sent (look/act calls). */
  screen: { width: number; height: number } | null;
  at: string;
}

export interface CueLiveGoalState {
  text: string;
  step: number;
  done: boolean;
  startedAt: string;
  /** Set when the run was ended by a remote stop rather than completing. */
  stoppedRemotely?: boolean;
}

export interface CueLiveSessionView {
  /** True when the Mac has called in within the active window. */
  active: boolean;
  paused: boolean;
  /** True while an unconsumed remote-stop request is armed. */
  stopPending: boolean;
  lastSeenAt: string | null;
  /** Start of the current activity burst (duration display). */
  sessionStartedAt: string | null;
  /** Metadata about what the Mac is looking at. Never image bytes. */
  watching: CueLiveWatching | null;
  /** The auto-run goal most recently in flight, if any. */
  goal: CueLiveGoalState | null;
  /** Newest first. */
  observations: CueLiveObservation[];
}

interface SessionState {
  paused: boolean;
  stopRequestedAt: number | null;
  lastSeenMs: number | null;
  sessionStartedMs: number | null;
  watching: CueLiveWatching | null;
  goal: CueLiveGoalState | null;
  observations: CueLiveObservation[];
  nextObservationId: number;
}

function freshState(): SessionState {
  return {
    paused: false,
    stopRequestedAt: null,
    lastSeenMs: null,
    sessionStartedMs: null,
    watching: null,
    goal: null,
    observations: [],
    nextObservationId: 1,
  };
}

let state: SessionState = freshState();

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Mark activity: roll the session clock and update last-seen. */
function touch(now: number): void {
  if (
    state.lastSeenMs === null ||
    now - state.lastSeenMs > SESSION_GAP_MS ||
    state.sessionStartedMs === null
  ) {
    state.sessionStartedMs = now;
  }
  state.lastSeenMs = now;
}

function pushObservation(
  entry: Omit<CueLiveObservation, "id" | "at">,
  now: number,
): void {
  state.observations.unshift({
    id: state.nextObservationId++,
    at: new Date(now).toISOString(),
    ...entry,
  });
  if (state.observations.length > MAX_OBSERVATIONS) {
    state.observations.length = MAX_OBSERVATIONS;
  }
}

/** A summon/guidance call — carries the frontmost app name. */
export function recordGuidance(
  input: { appName?: string; label?: string },
  now: number = Date.now(),
): void {
  touch(now);
  const app = input.appName?.trim() || null;
  if (app) {
    state.watching = {
      appName: app,
      screen: state.watching?.screen ?? null,
      at: new Date(now).toISOString(),
    };
  }
  pushObservation(
    {
      kind: "guidance",
      summary: app ? `Summoned over ${app}` : "Summoned",
      detail: input.label ? truncate(input.label, 80) : undefined,
      status: state.paused ? "held" : "done",
    },
    now,
  );
}

/** A vision look — question in, spoken answer out. Never keeps the frame. */
export function recordLook(
  input: {
    question: string;
    answer?: string;
    error?: string;
    imageWidth?: number;
    imageHeight?: number;
    held?: boolean;
  },
  now: number = Date.now(),
): void {
  touch(now);
  if (input.imageWidth && input.imageHeight) {
    state.watching = {
      appName: state.watching?.appName ?? null,
      screen: { width: input.imageWidth, height: input.imageHeight },
      at: new Date(now).toISOString(),
    };
  }
  const detail = input.held
    ? "Held — paused from your phone"
    : input.error
      ? truncate(input.error, MAX_DETAIL_CHARS)
      : input.answer
        ? truncate(input.answer, MAX_DETAIL_CHARS)
        : undefined;
  pushObservation(
    {
      kind: "look",
      summary: truncate(input.question || "Looked at the screen", 120),
      detail,
      status: input.held ? "held" : "done",
    },
    now,
  );
}

/** An act step — goal + step counter + what Cue said, and whether it ended. */
export function recordActStep(
  input: {
    goal: string;
    step: number;
    say?: string | null;
    done: boolean;
    imageWidth?: number;
    imageHeight?: number;
    held?: boolean;
    stoppedRemotely?: boolean;
  },
  now: number = Date.now(),
): void {
  touch(now);
  if (input.imageWidth && input.imageHeight) {
    state.watching = {
      appName: state.watching?.appName ?? null,
      screen: { width: input.imageWidth, height: input.imageHeight },
      at: new Date(now).toISOString(),
    };
  }
  const goalText = truncate(input.goal, 160);
  if (
    !state.goal ||
    state.goal.text !== goalText ||
    (state.goal.done && !input.done)
  ) {
    state.goal = {
      text: goalText,
      step: input.step,
      done: false,
      startedAt: new Date(now).toISOString(),
    };
  }
  state.goal.step = Math.max(state.goal.step, input.step);
  if (input.done) {
    state.goal.done = true;
    if (input.stoppedRemotely) state.goal.stoppedRemotely = true;
  }
  pushObservation(
    {
      kind: "act",
      summary: input.done
        ? input.stoppedRemotely
          ? `Run stopped — ${goalText}`
          : `Run finished — ${goalText}`
        : `Step ${input.step} — ${goalText}`,
      detail: input.held
        ? "Held — paused from your phone"
        : input.say
          ? truncate(input.say, MAX_DETAIL_CHARS)
          : undefined,
      status: input.held ? "held" : input.done ? "done" : "active",
    },
    now,
  );
}

/** Whether remote pause is holding the daemon's Cue Live answers. */
export function isRemotePaused(): boolean {
  return state.paused;
}

export function setRemotePaused(paused: boolean): void {
  state.paused = paused;
}

/** Arm a one-shot stop for the auto-run in flight. Returns whether one was. */
export function requestRemoteStop(now: number = Date.now()): {
  runInFlight: boolean;
} {
  const runInFlight = Boolean(state.goal && !state.goal.done);
  state.stopRequestedAt = now;
  return { runInFlight };
}

/**
 * Consume the armed stop request (called from the act handler before asking
 * the model for a next step). Returns true when the run should end now.
 */
export function consumeRemoteStop(now: number = Date.now()): boolean {
  if (state.stopRequestedAt === null) return false;
  const fresh = now - state.stopRequestedAt <= STOP_REQUEST_TTL_MS;
  state.stopRequestedAt = null;
  return fresh;
}

export function getSessionView(now: number = Date.now()): CueLiveSessionView {
  const active =
    state.lastSeenMs !== null && now - state.lastSeenMs <= ACTIVE_WINDOW_MS;
  const stopPending =
    state.stopRequestedAt !== null &&
    now - state.stopRequestedAt <= STOP_REQUEST_TTL_MS;
  return {
    active,
    paused: state.paused,
    stopPending,
    lastSeenAt:
      state.lastSeenMs !== null
        ? new Date(state.lastSeenMs).toISOString()
        : null,
    sessionStartedAt:
      active && state.sessionStartedMs !== null
        ? new Date(state.sessionStartedMs).toISOString()
        : null,
    watching: active ? state.watching : null,
    goal: state.goal,
    observations: state.observations,
  };
}

/** Test-only: wipe the module-level session state. */
export function resetCueLiveSessionForTest(): void {
  state = freshState();
}
