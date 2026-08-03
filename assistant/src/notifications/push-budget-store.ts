/**
 * Durable side of the push interruption budget — the day's counts, and the
 * record of every decision that produced them.
 *
 * Kept apart from `push-budget.ts` so the rule (tiers, ceiling, quiet-hours
 * exemption) stays pure and testable without a database, and so the only thing
 * that can fail here is arithmetic over rows.
 *
 * Failure posture, per the ledger's two obligations:
 *   - A read failure returns `unavailable`, which holds AMBIENT pushes only.
 *     Corrections and time-critical approvals never consult the count, so a
 *     database wobble can never silence them.
 *   - A write failure is logged and swallowed. The decision was already made
 *     from a count that read cleanly; losing the record of it costs at most one
 *     extra notification later, which is the cheaper of the two mistakes.
 */

import { and, desc, eq, lt } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import { getDb } from "../memory/db-connection.js";
import { pushBudgetLedger } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import { localClock } from "./local-clock.js";
import type { PushDecision, PushLedger, PushTier } from "./push-budget.js";

const log = getLogger("push-budget");

/** How long decision rows are kept. Long enough to answer "this week". */
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Prune at most once per process-hour; the write path is not a cleanup job. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * The timezone the user's *day* is measured in.
 *
 * `notifications.push.quietHours.timezone` first, because a ceiling and a quiet
 * window that disagree about when midnight is would be indefensible. Then
 * `notifications.morningBrief.timezone`, which cloud deployments do set (a
 * daemon running UTC otherwise splits the day at breakfast and hands the 07:30
 * brief to the previous day's budget). Null = daemon-local.
 */
export function pushDayTimezone(): string | null {
  try {
    const notifications = getConfig().notifications;
    return (
      notifications.push.quietHours.timezone ??
      notifications.morningBrief.timezone ??
      null
    );
  } catch {
    return null;
  }
}

/** Local calendar day key for the push budget, `YYYY-MM-DD`. */
export function pushDayKey(now: Date = new Date()): string {
  return localClock(now, pushDayTimezone()).dateKey;
}

/**
 * Read the day so far. Never throws — a failed read is reported as
 * `unavailable` rather than as a convenient zero.
 */
export function readPushLedger(now: Date = new Date()): PushLedger {
  const dayKey = pushDayKey(now);
  try {
    const rows = getDb()
      .select({ delivered: pushBudgetLedger.delivered })
      .from(pushBudgetLedger)
      .where(eq(pushBudgetLedger.dayKey, dayKey))
      .all();
    let delivered = 0;
    let suppressed = 0;
    for (const row of rows) {
      if (row.delivered === 1) delivered += 1;
      else suppressed += 1;
    }
    return { dayKey, delivered, suppressed };
  } catch (err) {
    log.warn(
      { err: String(err), dayKey },
      "push budget ledger unreadable — ambient pushes held until it recovers",
    );
    return { dayKey, delivered: 0, suppressed: 0, unavailable: true };
  }
}

/**
 * Record a decision. Called for suppressions too — that is what makes a
 * suppressed push acknowledged rather than dropped, and what keeps any count
 * shown to the user a real one. Never throws.
 */
export function recordPushDecision(input: {
  dayKey: string;
  decision: PushDecision;
  sourceEventName: string;
  /** Throttle/collapse key, e.g. `wi:<id>`. Never message content. */
  subjectKey?: string | null;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  try {
    getDb()
      .insert(pushBudgetLedger)
      .values({
        id: crypto.randomUUID(),
        dayKey: input.dayKey,
        tier: input.decision.tier,
        sourceEventName: input.sourceEventName,
        subjectKey: input.subjectKey ?? null,
        delivered: input.decision.deliver ? 1 : 0,
        reason: input.decision.reason,
        brokeQuietHours: input.decision.breaksQuietHours ? 1 : 0,
        createdAt: now.getTime(),
      })
      .run();
    pruneOldRows(now);
  } catch (err) {
    // The decision stands; only its record was lost.
    log.warn({ err: String(err) }, "failed to record push budget decision");
  }
}

function pruneOldRows(now: Date): void {
  if (now.getTime() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now.getTime();
  try {
    getDb()
      .delete(pushBudgetLedger)
      .where(lt(pushBudgetLedger.createdAt, now.getTime() - RETENTION_MS))
      .run();
  } catch (err) {
    log.debug({ err: String(err) }, "push budget ledger prune failed");
  }
}

export interface PushLedgerEntry {
  tier: PushTier;
  sourceEventName: string;
  delivered: boolean;
  reason: string;
  brokeQuietHours: boolean;
  createdAt: number;
}

/**
 * The day's decisions, newest first — the audit behind the counts. Returns an
 * empty list on failure rather than throwing; callers must not present an
 * empty list as "nothing happened" without also checking `readPushLedger`.
 */
export function listPushDecisions(
  now: Date = new Date(),
  opts: { deliveredOnly?: boolean } = {},
): PushLedgerEntry[] {
  const dayKey = pushDayKey(now);
  try {
    const where = opts.deliveredOnly
      ? and(
          eq(pushBudgetLedger.dayKey, dayKey),
          eq(pushBudgetLedger.delivered, 1),
        )
      : eq(pushBudgetLedger.dayKey, dayKey);
    return getDb()
      .select()
      .from(pushBudgetLedger)
      .where(where)
      .orderBy(desc(pushBudgetLedger.createdAt))
      .all()
      .map((row) => ({
        tier: row.tier as PushTier,
        sourceEventName: row.sourceEventName,
        delivered: row.delivered === 1,
        reason: row.reason,
        brokeQuietHours: row.brokeQuietHours === 1,
        createdAt: row.createdAt,
      }));
  } catch (err) {
    log.warn({ err: String(err) }, "failed to list push budget decisions");
    return [];
  }
}
