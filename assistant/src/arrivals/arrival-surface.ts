/**
 * Turning an arrival into the work item the Came-in lane shows.
 *
 * One function, two callers — the intake path (a fresh arrival the gate
 * surfaced) and the reversal path (a filed arrival the owner said mattered).
 * They MUST produce the same row: a reversal that yields a subtly different
 * work item than the one the gate would have made turns "this mattered" into
 * a second-class item, and the owner has no way to see that it happened.
 */

import { createTask } from "../tasks/task-store.js";
import { bandWorkItem } from "../valve/valve-intake.js";
import {
  createWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";
import { type Arrival, attachWorkItemToArrival } from "./arrival-store.js";

/**
 * Create the parked Came-in work item for an arrival and bind the two rows
 * together. Parked by design: surfacing means "the owner should see this", not
 * "Cue may act on it".
 */
export function createWorkItemForArrival(
  arrival: Arrival,
  opts: { notes?: string | null; actor?: string } = {},
): WorkItem {
  const task = createTask({ title: arrival.title, template: arrival.title });
  const workItem = createWorkItem({
    taskId: task.id,
    title: arrival.title,
    ...(opts.notes ? { notes: opts.notes } : {}),
    priorityTier: 1,
    sourceType: arrival.channel,
    sourceId: arrival.externalId,
    ...(arrival.sourceContext ? { sourceContext: arrival.sourceContext } : {}),
    // A bare watcher hit surfaces for the user; it must not auto-run.
    autoRunEligibility: "parked",
    arrivalId: arrival.id,
    actor: opts.actor ?? "watcher",
  });
  attachWorkItemToArrival(arrival.id, workItem.id);
  // Size it for the volume valve. Deliberately AFTER the link is made, so the
  // band is computed against an arrival that already points at its item, and
  // deliberately best-effort: `bandWorkItem` never throws, and an item it
  // fails to band has no band row, which reads as urgent. A valve failure can
  // only ever leave this item louder, never quieter — so it cannot turn the
  // one function that mints Came-in work into a way to lose work.
  bandWorkItem(workItem);
  return workItem;
}
