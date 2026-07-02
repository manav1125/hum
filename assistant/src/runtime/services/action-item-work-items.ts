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
import { createTask } from "../../tasks/task-store.js";
import { getLogger } from "../../util/logger.js";
import {
  createWorkItemWithPermissions,
  findActiveWorkItemBySource,
} from "../../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../../work-items/work-item-triage.js";
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
 */
export function actionItemsToWorkItems(
  actionItems: ActionItemInput[],
  sourceType: string,
  conversationId: string,
): ActionItemWorkItemRef[] {
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
        refs.push({ id: existing.id, title: existing.title, created: false });
        continue;
      }

      // The executor runs against a task template, so mint a lightweight one.
      const task = createTask({
        title,
        template: title,
        createdFromConversationId: conversationId,
      });
      const workItem = createWorkItemWithPermissions({
        taskId: task.id,
        title,
        notes: item.owner ? `Owner: ${item.owner}` : undefined,
        priorityTier: 1, // medium default — background triage refines it
        sourceType,
        sourceId: conversationId,
      });
      // Rank the fresh capture and, when the autonomy policy allows, hand it
      // straight to the background runner instead of parking it in the queue.
      triageAndMaybeAutoRunWorkItem(workItem.id);
      refs.push({ id: workItem.id, title: workItem.title, created: true });
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
