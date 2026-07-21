/**
 * Desktop-organizer remote-view session state.
 *
 * The desktop-organizer skill runs entirely on the paired Mac: it is a shell
 * script (`scripts/cue-organize.sh`) executed through the `host_bash` proxy.
 * It plans a move (read-only inventory) and then applies it, moving — never
 * deleting — Desktop clutter into `Cue Archive/<date>/<Category>/` with a
 * generated `cue-undo.sh`. The phone / web is the REMOTE: it approves the plan
 * and mirrors progress. Execution stays on the Mac.
 *
 * This module holds what the daemon can honestly report about an organize run
 * so a remote client can watch it:
 *
 * - **plan**: the categorized inventory (category → count → destination) the
 *   user approves, whole or per-category.
 * - **progress**: how many items have moved, and which category is in flight.
 * - **done**: the final tally + archive path + whether an undo script exists.
 *
 * IMPORTANT — emission gap (honest): the shell script does NOT yet report the
 * plan or per-item progress back into the daemon. Nothing calls the recorders
 * below today, so `getOrganizerView()` returns `active: false` in practice and
 * a remote sees the honest "no organize run" state. Wiring the live mirror to
 * real data needs one of:
 *   (a) the skill's `apply` loop POSTing plan/progress to an ingest route, or
 *   (b) a tool-side-effects hook parsing `cue-organize.sh` stdout (the plan
 *       TSV and the "moved N item(s)" summary) into these recorders.
 * The recorders + view are built and unit-tested so that wire-in is a small,
 * localized step — the remote views render correctly the moment either lands.
 *
 * All state is in-memory: a daemon restart honestly forgets the run.
 */

/** A plan/progress update newer than this marks the run as active. */
const ACTIVE_WINDOW_MS = 3 * 60_000;
/** A gap longer than this starts a fresh run (resets the duration clock). */
const SESSION_GAP_MS = 10 * 60_000;

export interface OrganizerCategory {
  /** Stable key, e.g. "screenshots". */
  key: string;
  /** Display label, e.g. "Screenshots". */
  label: string;
  /** Emoji glyph shown in the plan card. */
  icon: string;
  /** Number of items in this category. */
  count: number;
  /** Where they move to, e.g. "Cue Archive". */
  destination: string;
  /** Whether the category is included by default (per-category approve). */
  included: boolean;
}

export interface OrganizerPlan {
  /** The folder being organized, e.g. "~/Desktop". */
  root: string;
  /** Total items scanned. */
  scannedCount: number;
  /** Archive folder items move into, e.g. "Cue Archive/2026-07-21". */
  archiveBase: string;
  categories: OrganizerCategory[];
  /** Honest exclusion note, e.g. "dotfiles & ~/Library excluded". */
  protectedNote: string;
}

export interface OrganizerCategoryProgress {
  key: string;
  label: string;
  moved: number;
  total: number;
  done: boolean;
}

export interface OrganizerProgress {
  movedCount: number;
  totalCount: number;
  /** Category currently being moved, or null between categories. */
  currentCategory: string | null;
  perCategory: OrganizerCategoryProgress[];
}

export interface OrganizerDone {
  movedTotal: number;
  /** e.g. "Cue Archive/Jul-21". */
  archivePath: string;
  /** True when a `cue-undo.sh` was generated on the Mac. */
  undoAvailable: boolean;
}

export interface OrganizerSessionView {
  /** True when a plan/progress update landed within the active window. */
  active: boolean;
  /** Name of the Mac the run is on, if known. */
  machineName: string | null;
  lastSeenAt: string | null;
  sessionStartedAt: string | null;
  plan: OrganizerPlan | null;
  progress: OrganizerProgress | null;
  done: OrganizerDone | null;
}

interface SessionState {
  lastSeenMs: number | null;
  sessionStartedMs: number | null;
  machineName: string | null;
  plan: OrganizerPlan | null;
  progress: OrganizerProgress | null;
  done: OrganizerDone | null;
}

function freshState(): SessionState {
  return {
    lastSeenMs: null,
    sessionStartedMs: null,
    machineName: null,
    plan: null,
    progress: null,
    done: null,
  };
}

let state: SessionState = freshState();

/** Mark activity: roll the session clock and update last-seen. */
function touch(now: number): void {
  if (
    state.lastSeenMs === null ||
    now - state.lastSeenMs > SESSION_GAP_MS ||
    state.sessionStartedMs === null
  ) {
    // A new burst of activity — reset the run, clearing any prior done state.
    state.sessionStartedMs = now;
    state.progress = null;
    state.done = null;
  }
  state.lastSeenMs = now;
}

/** Record the categorized plan the remote approves. */
export function recordOrganizerPlan(
  input: { machineName?: string | null; plan: OrganizerPlan },
  now: number = Date.now(),
): void {
  touch(now);
  if (input.machineName) state.machineName = input.machineName;
  state.plan = input.plan;
}

/** Record how far the apply loop has moved. */
export function recordOrganizerProgress(
  input: { machineName?: string | null; progress: OrganizerProgress },
  now: number = Date.now(),
): void {
  touch(now);
  if (input.machineName) state.machineName = input.machineName;
  state.progress = input.progress;
}

/** Record the final tally when the run completes. */
export function recordOrganizerDone(
  input: { machineName?: string | null; done: OrganizerDone },
  now: number = Date.now(),
): void {
  touch(now);
  if (input.machineName) state.machineName = input.machineName;
  state.done = input.done;
}

export function getOrganizerView(
  now: number = Date.now(),
): OrganizerSessionView {
  const active =
    state.lastSeenMs !== null && now - state.lastSeenMs <= ACTIVE_WINDOW_MS;
  return {
    active,
    machineName: state.machineName,
    lastSeenAt:
      state.lastSeenMs !== null
        ? new Date(state.lastSeenMs).toISOString()
        : null,
    sessionStartedAt:
      active && state.sessionStartedMs !== null
        ? new Date(state.sessionStartedMs).toISOString()
        : null,
    plan: active ? state.plan : null,
    progress: active ? state.progress : null,
    // The completion card lingers briefly after the run so the remote can show
    // "Tidied N · Undo" even once activity has gone quiet.
    done: state.done,
  };
}

/** Test-only: wipe the module-level session state. */
export function resetOrganizerSessionForTest(): void {
  state = freshState();
}
