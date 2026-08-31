/**
 * Putting a mission's own diagnosis somewhere the owner will find it.
 *
 * A mission cycle that cannot act still learns the most useful thing in the
 * system: exactly what is stopping it. Production recorded that finding 68
 * times in sentences like these, verbatim:
 *
 *   "No project is linked to the mission, so no concrete fundraising tasks
 *    can be planned or executed. Immediate action is required from the
 *    founder to create a 'Seed Fundraising' project and link it."
 *
 *   "Progress is completely stalled because two critical items require your
 *    review... Over 20 queued tasks cannot proceed until these blockers are
 *    resolved."
 *
 * Every one of them went into `mission_events` and a live client event. A row
 * in an events table is not a delivery, and a live event only reaches someone
 * already looking at that surface at that second. So the mission knew why it
 * was stuck, said so daily, was charged for the thinking, and the owner never
 * saw it. Over the same period the mission enqueued four items.
 *
 * This module turns that into a work item — the one lane the owner actually
 * reviews. The item is `parked`: it is something to READ and decide, not
 * something for an agent to run.
 *
 * ## Why dedupe is the whole design
 *
 * The blocking condition is usually the same every cycle, because nothing has
 * changed — that is what "blocked" means. Creating an item per cycle would put
 * 68 identical rows in the lane the fix exists to make useful, which is worse
 * than the silence it replaces. So there is at most ONE open item per
 * (mission, KIND): a repeat refreshes that row's wording and progress note
 * instead of adding another.
 *
 * The key deliberately ignores the reason's TEXT. Keying on the wording was
 * the obvious first design and it is wrong: the planner rephrases the same
 * obstacle every cycle, so a paraphrase would mint a fresh row daily and
 * rebuild the flood this exists to prevent. A mission is blocked in a way, not
 * in twelve ways. The cost is that two genuinely different obstacles of the
 * same kind share a row — acceptable, because the row always carries the
 * latest wording, so nothing is hidden, only merged.
 */

import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import {
  createWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";

const log = getLogger("mission-blocked-surface");

/** `sourceType` stamped on every item this module creates. */
export const MISSION_BLOCKED_SOURCE_TYPE = "mission_blocked";

/** Statuses that mean an existing surfaced item is still live. */
const OPEN_STATUSES = new Set(["queued", "awaiting_review"]);

/**
 * Stable id for one kind of block on one mission.
 *
 * Deliberately independent of the reason's wording, so a rephrased assessment
 * finds the existing row instead of creating a second one.
 */
export function blockedItemKey(
  missionId: string,
  kind: SurfaceBlockedMissionParams["kind"],
): string {
  return `mission-blocked:${missionId}:${kind}`;
}

/** An already-open surfaced item for this exact reason, if there is one. */
function findOpenSurfaced(sourceId: string): WorkItem | undefined {
  // `includeUnComprehended` is on: this is orchestration reasoning about what
  // exists, not a list being rendered, and a surfaced item must never be
  // duplicated just because it was filtered out of the default view.
  return listWorkItems({ includeUnComprehended: true }).find(
    (item) =>
      item.sourceType === MISSION_BLOCKED_SOURCE_TYPE &&
      item.sourceId === sourceId &&
      OPEN_STATUSES.has(item.status),
  );
}

export interface SurfaceBlockedMissionParams {
  missionId: string;
  missionTitle: string;
  /**
   * The planner's own words. Used verbatim — it is a better explanation than
   * anything this module could synthesize, and rewriting it would lose the
   * specificity that makes it actionable ("create a 'Seed Fundraising'
   * project and link it").
   */
  reason: string;
  /**
   * The shape of the block. This is the dedupe key alongside the mission, so
   * the set is deliberately small and coarse.
   */
  kind: "no_linked_project" | "awaiting_owner" | "planner_failing";
}

const TITLE_BY_KIND: Record<SurfaceBlockedMissionParams["kind"], string> = {
  no_linked_project: "needs a project linked before it can plan work",
  awaiting_owner: "is blocked and needs you",
  planner_failing: "could not produce a plan",
};

/**
 * Surface a blocked mission as a work item, or refresh the existing one.
 *
 * Returns the item id in both cases, and `null` when there is no reason text
 * to show or the write failed.
 *
 * Never throws. This is called from inside a mission cycle, and failing to
 * surface a block must not also fail the cycle that discovered it.
 */
export function surfaceBlockedMission(
  params: SurfaceBlockedMissionParams,
): string | null {
  const reason = params.reason.trim();
  // An obstacle nobody can describe is not worth a row — the owner would get
  // a title with no way to act on it.
  if (!reason) return null;

  const sourceId = blockedItemKey(params.missionId, params.kind);
  try {
    const existing = findOpenSurfaced(sourceId);
    if (existing) {
      // Same kind of block, still there. Refresh the wording and touch the
      // row so it reads as current rather than as something raised once and
      // left stale — but never add a second row.
      //
      // `updateWorkItem` stamps `lastActivityAt` itself on every write, so
      // the note alone is enough to make the row read as current.
      updateWorkItem(
        existing.id,
        {
          notes: reason,
          lastProgressNote: `Still blocked as of the latest cycle: ${truncate(reason, 400)}`,
        },
        { actor: "mission" },
      );
      return existing.id;
    }

    // A work item hangs off a task row by foreign key, so the task comes
    // first — same shape as the arrival surface.
    const task = createTask({
      title: `${params.missionTitle} — blocked`,
      template: `${params.missionTitle} — blocked`,
    });
    const item = createWorkItem({
      taskId: task.id,
      title: `${params.missionTitle} ${TITLE_BY_KIND[params.kind]}`,
      notes: reason,
      sourceType: MISSION_BLOCKED_SOURCE_TYPE,
      sourceId,
      // Blocked missions are the reason nothing else is moving, so this
      // belongs at the top of the lane rather than in the general pile.
      priorityTier: 0,
      // Read-and-decide, not run. An agent cannot link a project or review a
      // partnership draft on the owner's behalf.
      autoRunEligibility: "parked",
    });
    log.info(
      { missionId: params.missionId, workItemId: item.id, kind: params.kind },
      "surfaced blocked mission as a work item",
    );
    return item.id;
  } catch (err) {
    log.error(
      { err, missionId: params.missionId, kind: params.kind },
      "failed to surface a blocked mission; the cycle itself is unaffected",
    );
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
