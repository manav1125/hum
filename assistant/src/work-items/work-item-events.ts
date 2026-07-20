/**
 * Work-item audit trail: one row per lifecycle transition, written from the
 * store's single status choke point plus the runner/routes. Powers per-item
 * history and cycle-time metrics. Writes are best-effort by design — a broken
 * audit insert must never break the runner or a route.
 */

import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { workItemEvents } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("work-item-events");

export type WorkItemEventKind =
  | "created"
  | "status_changed"
  | "run_started"
  | "run_finished"
  | "approved"
  // WS1: a run was blocked at run-start because an agent/task budget was
  // exhausted (hard-stop). The item is set `failed` with a budget reason on
  // `lastProgressNote`; this event marks it a resolvable budget incident.
  | "budget_stop"
  // WS3: the startup watchdog found this item stranded `running` (its run died
  // with a previous daemon process). Requeued (toStatus=queued) up to the
  // retry cap, or failed as a recovery incident (toStatus=failed) past it.
  | "run_recovered"
  // A permission prompt raised during this item's headless run expired without
  // an answer and auto-resolved DENY — the step was silently skipped. Durable
  // marker so review surfaces can flag "finished, but with skipped steps".
  | "approval_timeout"
  // The owner marked the item done as "completed elsewhere" — the work
  // happened outside Cue. Distinct from "approved" (which signs off on a run
  // Cue performed) so the act/ledger never credits Cue with the outcome.
  | "completed_elsewhere";

export interface WorkItemEvent {
  id: string;
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  at: number;
}

/** Best-effort insert — logs and swallows failures. */
export function recordWorkItemEvent(opts: {
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus?: string;
  toStatus?: string;
  actor?: string;
}): void {
  try {
    const db = getDb();
    db.insert(workItemEvents)
      .values({
        id: randomUUID(),
        workItemId: opts.workItemId,
        kind: opts.kind,
        fromStatus: opts.fromStatus ?? null,
        toStatus: opts.toStatus ?? null,
        actor: opts.actor ?? null,
        at: Date.now(),
      })
      .run();
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: opts.workItemId, kind: opts.kind },
      "work-item event write failed (ignored)",
    );
  }
}

export function listWorkItemEvents(workItemId: string): WorkItemEvent[] {
  const db = getDb();
  return db
    .select()
    .from(workItemEvents)
    .where(eq(workItemEvents.workItemId, workItemId))
    .orderBy(asc(workItemEvents.at))
    .all() as WorkItemEvent[];
}

/**
 * Wall-clock time from creation to the first terminal completion event
 * (run_finished or approved), or null when either endpoint is missing.
 */
export function cycleTimeMs(events: WorkItemEvent[]): number | null {
  const created = events.find((e) => e.kind === "created");
  const finished = events.find(
    (e) => e.kind === "run_finished" || e.kind === "approved",
  );
  if (!created || !finished || finished.at < created.at) return null;
  return finished.at - created.at;
}
