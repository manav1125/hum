/**
 * Shared bridge: turn extracted action items into executable work items.
 *
 * Used by both the meeting-recap service (sourceType `"meeting"`) and the
 * voice-intake service (sourceType `"voice"`). Only **open** action items
 * (`done === false`) become work items — an action already completed is not
 * work to do. Creation is **idempotent** on `(sourceType, sourceId=conversationId,
 * title)` via {@link findActiveWorkItemBySource}, so re-running an extraction on
 * the same source reuses the active rows instead of minting duplicates. Two
 * extractions that produce the same action text collapse to one work item.
 *
 * Each item gets a lightweight task template (the executor needs a `taskId`);
 * the action text is both the template (the instruction the model receives at
 * run time) and the work item title. Best-effort and isolated per item: a
 * failure on one action item is logged and skipped; the others are unaffected.
 *
 * Works for the self-host **local owner**: work-item/task creation is keyed on
 * the conversation, not on a principal — there is no actor gate here.
 */

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getMission } from "../../missions/mission-store.js";
import { createTask } from "../../tasks/task-store.js";
import { getLogger } from "../../util/logger.js";
import { getProject } from "../../work-items/project-store.js";
import {
  createWorkItemWithPermissions,
  findActiveWorkItemBySource,
  getWorkItem,
} from "../../work-items/work-item-store.js";
import {
  conservativeRequiredToolsForCapture,
  triageAndMaybeAutoRunWorkItem,
} from "../../work-items/work-item-triage.js";
import { broadcastMessage } from "../assistant-event-hub.js";

const log = getLogger("action-item-work-items");

/** A single extracted action item, before it becomes a work item. */
export interface ActionItemInput {
  text: string;
  owner: string | null;
  done: boolean;
}

/** A reference to a work item created (or reused) from an action item. */
export interface ActionItemWorkItemRef {
  /** The work item id (row in the `work_items` table). */
  id: string;
  /** The action-item text that became this work item's title. */
  title: string;
  /** True when this run minted the row; false when an active match was reused. */
  created: boolean;
  /**
   * The project triage filed this item onto (its best-matching existing
   * project), or null when triage was not confident about any project. Lets a
   * client show the real "filed to <project>" target instead of a placeholder.
   */
  projectId: string | null;
  /** The filed project's title — display handle for the ⟡ tag. Null when unfiled. */
  projectTitle: string | null;
  /**
   * The mission the filed project serves (via `project.missionId`), or null
   * when the project isn't linked to a mission (or the item is unfiled).
   */
  missionId: string | null;
  /** The linked mission's title — display handle. Null when no mission. */
  missionTitle: string | null;
}

/**
 * Resolve the filing (project + mission) triage stamped onto a work item, so a
 * caller can show the real target. Reads the freshly-triaged row's `projectId`,
 * then the project's title and — via `project.missionId` — the mission title.
 * Every lookup degrades to null independently, so a missing/deleted project or
 * mission never throws.
 */
function resolveWorkItemFiling(workItemId: string): {
  projectId: string | null;
  projectTitle: string | null;
  missionId: string | null;
  missionTitle: string | null;
} {
  const none = {
    projectId: null,
    projectTitle: null,
    missionId: null,
    missionTitle: null,
  };
  try {
    const fresh = getWorkItem(workItemId);
    const projectId = fresh?.projectId ?? null;
    if (!projectId) return none;
    const project = getProject(projectId);
    if (!project) return { ...none, projectId };
    const missionId = project.missionId ?? null;
    const mission = missionId ? getMission(missionId) : undefined;
    return {
      projectId,
      projectTitle: project.title,
      missionId: mission ? missionId : null,
      missionTitle: mission?.title ?? null,
    };
  } catch (err) {
    log.warn({ err, workItemId }, "Failed to resolve work-item filing");
    return none;
  }
}

/**
 * Map a set of open action items to executable work items so the user can run
 * them from Activity → Cued (or have them auto-run per autonomy policy).
 *
 * @param actionItems   The extracted action items.
 * @param sourceType    Provenance tag (`"meeting"`, `"voice"`, …) — part of the
 *                      idempotency key and the work-item's `sourceType` column.
 * @param conversationId The source conversation; becomes each work item's
 *                      `sourceId` and the task's `createdFromConversationId`.
 * @param opts.parked   When true, mint each item as a parked reminder that never
 *                      auto-runs (no triage/auto-run pass) — used by end-of-live-
 *                      voice synthesis, where residual to-dos should surface in
 *                      the recap for the user to run, not fire in the background.
 *                      Default false preserves the triage + maybe-auto-run path
 *                      the dictation/meeting callers rely on.
 */
export async function actionItemsToWorkItems(
  actionItems: ActionItemInput[],
  sourceType: string,
  conversationId: string,
  opts?: { parked?: boolean },
): Promise<ActionItemWorkItemRef[]> {
  const parked = opts?.parked === true;
  const refs: ActionItemWorkItemRef[] = [];
  const seenTitles = new Set<string>();

  for (const item of actionItems) {
    if (item.done) continue;
    const title = item.text.trim();
    if (!title) continue;

    // Collapse intra-extraction duplicates before touching the store.
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    try {
      // Idempotency: reuse an active work item already minted for this
      // (sourceType, conversation, title) — re-running must not duplicate.
      const existing = findActiveWorkItemBySource({
        title,
        sourceType,
        sourceId: conversationId,
      });
      if (existing) {
        refs.push({
          id: existing.id,
          title: existing.title,
          created: false,
          ...resolveWorkItemFiling(existing.id),
        });
        continue;
      }

      // The executor runs against a task template, so mint a lightweight one.
      const task = createTask({
        title,
        template: title,
        createdFromConversationId: conversationId,
      });
      const notes = item.owner ? `Owner: ${item.owner}` : undefined;
      // Stamp the conservative read-only tool snapshot so triage classifies
      // the item into a real autonomy category ("research") instead of the
      // fail-closed "other" — without this, extracted action items could
      // never auto-run and parked forever. Items whose text implies a
      // side-effect deliverable ("email X", "post Y") deliberately keep an
      // empty snapshot and park for human review.
      const requiredTools = conservativeRequiredToolsForCapture(title, notes);
      const workItem = createWorkItemWithPermissions({
        taskId: task.id,
        title,
        notes,
        priorityTier: 1, // medium default — background triage refines it
        sourceType,
        sourceId: conversationId,
        // The meeting/voice conversation the action item came out of — so that
        // thread can show what it spawned and its agent never redoes it.
        originConversationId: conversationId,
        ...(requiredTools ? { requiredTools } : {}),
        // A parked item is a reminder the user should run themselves — no later
        // pass (queue drainer, re-triage) may start it.
        ...(parked ? { autoRunEligibility: "parked" as const } : {}),
      });
      if (parked) {
        // Parked reminders skip triage/auto-run entirely (mirrors the plain
        // to-do path): they surface in the recap + Activity for the user to run.
        refs.push({
          id: workItem.id,
          title: workItem.title,
          created: true,
          projectId: null,
          projectTitle: null,
          missionId: null,
          missionTitle: null,
        });
      } else {
        // Rank the fresh capture, file it onto its best-matching project (and
        // thus mission, via project.missionId), and — when the autonomy policy
        // allows — hand it straight to the background runner. Awaited (not
        // fire-and-forget) so the project the item is filed onto is stamped
        // before we read it back for the caller's response. The autonomy guard
        // inside still governs whether it auto-runs or lands for review.
        await triageAndMaybeAutoRunWorkItem(workItem.id);
        refs.push({
          id: workItem.id,
          title: workItem.title,
          created: true,
          ...resolveWorkItemFiling(workItem.id),
        });
      }
    } catch (err) {
      log.warn(
        { err, conversationId, title, sourceType },
        "Failed to create work item from action item (skipped)",
      );
    }
  }

  // If this run minted any new rows, tell Activity to refresh live.
  if (refs.some((r) => r.created)) {
    broadcastMessage({ type: "tasks_changed" } as ServerMessage);
  }

  return refs;
}
