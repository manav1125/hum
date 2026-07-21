/**
 * Watcher intake — file a watcher's newly-detected events into the Came-in
 * lane (WS-F).
 *
 * This is the event-driven ingress the cadence-based missions lack. For each
 * new event we first give the playbook layer a chance to handle it (a matching
 * playbook produces an autonomy-capped work item); if no playbook matches, the
 * raw hit still lands in the Came-in lane as a parked work item so nothing a
 * watcher saw is silently dropped.
 *
 * Dedupe is already handled upstream: `watcher_events` has a UNIQUE
 * (watcher_id, external_id) constraint, so `insertWatcherEvent` only surfaces
 * genuinely new events — each hit reaches this function exactly once.
 */

import {
  evaluatePlaybooksForEvent,
  type PlaybookEvent,
} from "../playbooks/playbook-runtime.js";
import { createTask } from "../tasks/task-store.js";
import { getLogger } from "../util/logger.js";
import { createWorkItem } from "../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import type { Watcher, WatcherEvent } from "./watcher-store.js";

const log = getLogger("watcher-intake");

export interface IntakeResult {
  /** Events that a playbook handled. */
  playbookFired: number;
  /** Events filed straight into the Came-in lane (no playbook matched). */
  cameInFiled: number;
}

/** The channel key a watcher's events carry (e.g. 'watcher:gmail'). */
export function watcherChannel(watcher: Watcher): string {
  return `watcher:${watcher.providerId}`;
}

function toPlaybookEvent(watcher: Watcher, event: WatcherEvent): PlaybookEvent {
  return {
    channel: watcherChannel(watcher),
    watcherId: watcher.id,
    title: event.summary || `${watcher.name}: ${event.eventType}`,
    summary: event.payloadJson,
    sourceType: watcherChannel(watcher),
    sourceId: event.externalId,
    sourceContext: JSON.stringify({
      origin: watcherChannel(watcher),
      watcherId: watcher.id,
      watcherName: watcher.name,
      eventType: event.eventType,
      sourceId: event.externalId,
      snippet: event.summary.slice(0, 500),
      capturedAt: event.createdAt,
    }),
  };
}

/**
 * File a batch of new watcher events into Came-in (via playbooks, or as raw
 * parked work items). Best-effort per event: one failure never blocks the rest.
 * Returns per-event dispositions so the engine can stamp them.
 */
export async function fileWatcherEventsToCameIn(
  watcher: Watcher,
  events: WatcherEvent[],
): Promise<Map<string, "playbook" | "came_in" | "error">> {
  const dispositions = new Map<string, "playbook" | "came_in" | "error">();

  for (const event of events) {
    try {
      const pbEvent = toPlaybookEvent(watcher, event);
      const fired = await evaluatePlaybooksForEvent(pbEvent);
      if (fired) {
        dispositions.set(event.id, "playbook");
        continue;
      }

      // No playbook matched — file the raw hit into Came-in as a parked item.
      const task = createTask({
        title: pbEvent.title,
        template: pbEvent.title,
      });
      const workItem = createWorkItem({
        taskId: task.id,
        title: pbEvent.title,
        notes: `From ${watcher.name} · ${event.eventType}`,
        priorityTier: 1,
        sourceType: pbEvent.sourceType,
        sourceId: pbEvent.sourceId,
        sourceContext: pbEvent.sourceContext,
        // A bare watcher hit surfaces for the user; it must not auto-run.
        autoRunEligibility: "parked",
        actor: "watcher",
      });
      await triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun: true });
      dispositions.set(event.id, "came_in");
    } catch (err) {
      log.warn(
        { err: String(err), watcherId: watcher.id, eventId: event.id },
        "failed to file watcher event (others unaffected)",
      );
      dispositions.set(event.id, "error");
    }
  }

  return dispositions;
}
