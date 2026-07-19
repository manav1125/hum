/**
 * Pure decision logic for the iOS Live Activity (Dynamic Island) bridge —
 * mobile-v3 spec frame 4 (docs/design/mobile-v3/cue-mobile-v3.html).
 *
 * Given the previously-tracked activity and the latest work-item snapshot,
 * decide which native call (if any) keeps the Island honest:
 *
 *   · a running item appears (or a different run takes the top slot)
 *     → `start` (the native side is single-slot, latest-run-wins — it
 *       retires the previous activity itself)
 *   · the tracked run's progress note changes → `update`
 *   · the tracked run leaves the running set → `end`, with the final v3
 *     taxonomy state derived from where the item landed
 *     (awaiting_review → review, failed → failed, otherwise done)
 *
 * Kept free of React/query imports so it can be unit-tested directly
 * (`live-activity-plan.test.ts`); the effectful half lives in
 * `live-activity-bridge.tsx`.
 */

/** The slice of a daemon work item the planner reads. */
export interface RunActivityItem {
  id: string;
  title: string;
  status: string;
  lastProgressNote: string | null;
}

/** What the bridge remembers about the activity it last started. */
export interface TrackedActivity {
  runId: string;
  title: string;
  statusLine: string;
}

/**
 * v3 state-taxonomy keys accepted by the native plugin
 * (`CueRunState` in apps/ios/App/Shared/CueRunActivityAttributes.swift).
 */
export type RunActivityState =
  | "picked_up"
  | "running"
  | "needs_you"
  | "review"
  | "done"
  | "failed";

export type RunActivityCommand =
  | {
      kind: "start";
      runId: string;
      title: string;
      status: string;
      state: RunActivityState;
    }
  | { kind: "update"; status: string; state: RunActivityState }
  | { kind: "end"; status: string; state: RunActivityState }
  | { kind: "none" };

/** Status line shown while a run has no progress note yet. */
const DEFAULT_RUNNING_LINE = "Working…";

/** Final frames per landing status (spec: red strictly for failure). */
const END_FRAMES: Record<string, { state: RunActivityState; status: string }> =
  {
    awaiting_review: { state: "review", status: "Ready for your review" },
    failed: { state: "failed", status: "Stopped — needs your attention" },
  };

const DEFAULT_END_FRAME: { state: RunActivityState; status: string } = {
  state: "done",
  status: "Done",
};

/**
 * Plan the next native call from the latest snapshot. Returns the command to
 * dispatch plus the tracked-activity record to carry forward.
 */
export function planRunActivity(
  tracked: TrackedActivity | null,
  items: readonly RunActivityItem[],
): { command: RunActivityCommand; tracked: TrackedActivity | null } {
  const running = items.filter((i) => i.status === "running");
  const top = running[0] ?? null;

  if (top) {
    const statusLine = top.lastProgressNote?.trim() || DEFAULT_RUNNING_LINE;
    if (!tracked || tracked.runId !== top.id) {
      // New run in the slot (native retires any previous activity itself).
      return {
        command: {
          kind: "start",
          runId: top.id,
          title: top.title,
          status: statusLine,
          state: "running",
        },
        tracked: { runId: top.id, title: top.title, statusLine },
      };
    }
    if (tracked.statusLine !== statusLine) {
      return {
        command: { kind: "update", status: statusLine, state: "running" },
        tracked: { ...tracked, statusLine },
      };
    }
    return { command: { kind: "none" }, tracked };
  }

  if (!tracked) {
    return { command: { kind: "none" }, tracked: null };
  }

  // The tracked run left the running set — end with the taxonomy state of
  // wherever it landed (absent from the snapshot reads as done).
  const landed = items.find((i) => i.id === tracked.runId);
  const { state, status } =
    (landed ? END_FRAMES[landed.status] : undefined) ?? DEFAULT_END_FRAME;
  return { command: { kind: "end", status, state }, tracked: null };
}
