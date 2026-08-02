/**
 * Store for `work_item_comprehension` — what Cue understood a work item to be.
 *
 * The rule this module keeps: **a row is written for every item the extractor
 * looked at, including the ones it failed on.** The auto-file sweep spent
 * twelve hours filing nothing and the only symptom was the owner staring at
 * 103 unfiled items; a comprehension pass that quietly comprehends nothing
 * would read exactly the same way. Here it cannot, because "I could not do
 * better than the subject line" is a persisted row with a status and a reason,
 * not an absent one.
 *
 * Nothing here deletes. `originalTitle` is kept verbatim so a rewrite can
 * always be read back to what arrived, and the raw message stays reachable
 * through the work item's `sourceContext` and its `arrivals` row.
 */

import { desc, eq, gte, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { workItemComprehension } from "../memory/schema.js";

/**
 * What happened to one item.
 *
 *  · `comprehended`   — a verb-phrase title was accepted and applied.
 *  · `low_confidence` — the model answered but the answer was not trustworthy
 *                       enough to put in front of the owner; the ORIGINAL
 *                       title stands and `note` says why.
 *  · `failed`         — no usable answer (timeout, parse failure, the model
 *                       skipped this item). Original title stands.
 *  · `skipped`        — comprehension was off or the arrival is not a message
 *                       shape this extractor understands.
 */
export type ComprehensionStatus =
  | "comprehended"
  | "low_confidence"
  | "failed"
  | "skipped";

export interface WorkItemComprehension {
  workItemId: string;
  arrivalId: string | null;
  status: ComprehensionStatus;
  originalTitle: string;
  actionTitle: string | null;
  dueAt: number | null;
  dueQuote: string | null;
  amountText: string | null;
  askedBy: string | null;
  decisionNeeded: string | null;
  confidence: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordComprehensionInput {
  workItemId: string;
  arrivalId?: string | null;
  status: ComprehensionStatus;
  originalTitle: string;
  actionTitle?: string | null;
  dueAt?: number | null;
  dueQuote?: string | null;
  amountText?: string | null;
  askedBy?: string | null;
  decisionNeeded?: string | null;
  confidence?: number | null;
  note?: string | null;
}

/**
 * Write (or overwrite) the comprehension record for one work item.
 *
 * `originalTitle` is sticky on purpose: a second pass over an item whose title
 * a previous pass already rewrote must not record the rewritten title as "what
 * it was originally called". The first row wins that field forever, so the
 * chain back to the message the owner actually received is never broken by a
 * retry.
 */
export function recordComprehension(
  input: RecordComprehensionInput,
): WorkItemComprehension {
  const db = getDb();
  const now = Date.now();
  const existing = getComprehension(input.workItemId);
  const row: WorkItemComprehension = {
    workItemId: input.workItemId,
    arrivalId: input.arrivalId ?? existing?.arrivalId ?? null,
    status: input.status,
    originalTitle: existing?.originalTitle ?? input.originalTitle,
    actionTitle: input.actionTitle ?? null,
    dueAt: input.dueAt ?? null,
    dueQuote: input.dueQuote ?? null,
    amountText: input.amountText ?? null,
    askedBy: input.askedBy ?? null,
    decisionNeeded: input.decisionNeeded ?? null,
    confidence: input.confidence ?? null,
    note: input.note ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) {
    db.update(workItemComprehension)
      .set(row)
      .where(eq(workItemComprehension.workItemId, input.workItemId))
      .run();
  } else {
    db.insert(workItemComprehension).values(row).run();
  }
  return row;
}

export function getComprehension(
  workItemId: string,
): WorkItemComprehension | undefined {
  const db = getDb();
  return db
    .select()
    .from(workItemComprehension)
    .where(eq(workItemComprehension.workItemId, workItemId))
    .get() as WorkItemComprehension | undefined;
}

/** Newest-first comprehension rows, for diagnostics and the health read. */
export function listComprehensions(limit = 50): WorkItemComprehension[] {
  const db = getDb();
  return db
    .select()
    .from(workItemComprehension)
    .orderBy(desc(workItemComprehension.updatedAt))
    .limit(Math.min(200, Math.max(1, limit)))
    .all() as WorkItemComprehension[];
}

export interface ComprehensionCensus {
  /** Inclusive lower bound of the window, epoch ms. */
  since: number;
  /** Rows written in the window, by status. Always sums to `total`. */
  byStatus: Record<ComprehensionStatus, number>;
  total: number;
  /** Rows in the window that carry an extracted deadline. */
  withDeadline: number;
}

/**
 * The comprehended / low-confidence / failed census over a trailing window.
 *
 * This is the number that makes a silent no-op impossible to mistake for
 * success: a window where `total` is healthy and `comprehended` is zero is a
 * broken pass, and it says so out loud rather than looking like an idle one.
 */
export function getComprehensionCensus(windowHours = 24): ComprehensionCensus {
  const db = getDb();
  const since = Date.now() - Math.max(1, windowHours) * 3_600_000;
  const rows = db
    .select({
      status: workItemComprehension.status,
      count: sql<number>`count(*)`,
    })
    .from(workItemComprehension)
    .where(gte(workItemComprehension.updatedAt, since))
    .groupBy(workItemComprehension.status)
    .all() as Array<{ status: string; count: number }>;

  const byStatus: Record<ComprehensionStatus, number> = {
    comprehended: 0,
    low_confidence: 0,
    failed: 0,
    skipped: 0,
  };
  let total = 0;
  for (const row of rows) {
    const n = Number(row.count);
    total += n;
    if (row.status in byStatus) {
      byStatus[row.status as ComprehensionStatus] += n;
    }
  }

  const deadlineRow = db
    .select({ count: sql<number>`count(*)` })
    .from(workItemComprehension)
    .where(
      sql`${workItemComprehension.updatedAt} >= ${since} AND ${workItemComprehension.dueAt} IS NOT NULL`,
    )
    .get() as { count: number } | undefined;

  return {
    since,
    byStatus,
    total,
    withDeadline: Number(deadlineRow?.count ?? 0),
  };
}
