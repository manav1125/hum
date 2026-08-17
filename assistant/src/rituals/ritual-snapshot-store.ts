/**
 * The ritual snapshot store — what the Morning Brief and the Weekly review
 * said, kept.
 *
 * Two rules this module exists to hold:
 *
 *   1. **Nothing is invented.** There is no backfill entry point, by design.
 *      Every row was written by a compose that actually ran, and
 *      {@link getRitualSnapshotStoreStartedAt} exists so the archive can say
 *      out loud how far back the log goes rather than letting two rows imply
 *      that two rows is all there has ever been.
 *   2. **The first compose of a period wins.** {@link recordRitualSnapshot}
 *      is INSERT-OR-IGNORE against the `(ritual, period_key)` unique index.
 *      The brief that went out in the morning is the brief for that day; a
 *      re-compose at 11pm returns the existing row untouched. That is what
 *      makes the write safe to call from anywhere and often.
 *
 * Read-state lives here too (design N1: it rides on the snapshot store, and
 * no separate read-receipt store gets built), keyed by device so R4's
 * device-local reading survives — see `memory/schema/rituals.ts`.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { ritualSnapshotReads, ritualSnapshots } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ritual-snapshots");

/** The two rituals that have a face, a push and a page. */
export type RitualKind = "brief" | "weekly";

export const RITUAL_KINDS: readonly RitualKind[] = ["brief", "weekly"];

export function isRitualKind(value: string): value is RitualKind {
  return (RITUAL_KINDS as readonly string[]).includes(value);
}

/**
 * The figures a brief was composed from. Deliberately the same three numbers
 * the push and the ritual slot compose their sentences from — one door means
 * one set of figures.
 */
export interface BriefSnapshotFacts {
  /** Work finished quietly inside the lookback window. */
  done: number;
  /** Items that completed into `awaiting_review` inside the window. */
  review: number;
  /** Review items + a pending approval — what actually needs the owner. */
  needsYou: number;
  /** Entries on the day (calendar + due work items) at compose time. */
  dayEntries: number;
  /** False when no calendar was reachable, so `dayEntries` is work items only. */
  calendarAvailable: boolean;
}

/** The two numbers the Weekly's sentence is made of. */
export interface WeeklySnapshotFacts {
  /** Acts in the week + work items the owner cleared themselves. */
  moved: number;
  /** Overdue, going cold, or untouched for five days. Uncapped. */
  slipped: number;
}

export type RitualSnapshotFacts = BriefSnapshotFacts | WeeklySnapshotFacts;

export interface RitualSnapshot {
  id: string;
  ritual: RitualKind;
  /** `2026-08-17` for a brief, `2026-W33` for a weekly. */
  periodKey: string;
  periodStart: number;
  periodEnd: number;
  composedAt: number;
  /** The sentence, as composed from the figures at the time. */
  headline: string;
  /** The figures the headline was composed from. */
  facts: RitualSnapshotFacts;
}

export interface RecordRitualSnapshotInput {
  ritual: RitualKind;
  periodKey: string;
  periodStart: number;
  periodEnd: number;
  composedAt?: number;
  headline: string;
  facts: RitualSnapshotFacts;
}

interface SnapshotRow {
  id: string;
  ritual: string;
  periodKey: string;
  periodStart: number;
  periodEnd: number;
  composedAt: number;
  headline: string;
  facts: string;
}

/**
 * Facts are stored as JSON, so a row written by an older daemon can carry a
 * shape this one does not know. Never throw on the way out — an archive that
 * 500s because one historical row is odd is worse than one row rendering thin.
 */
function parseFacts(raw: string): RitualSnapshotFacts {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RitualSnapshotFacts;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "ritual snapshot facts unparseable");
  }
  return {} as RitualSnapshotFacts;
}

function toSnapshot(row: SnapshotRow): RitualSnapshot {
  return {
    id: row.id,
    ritual: row.ritual as RitualKind,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    composedAt: row.composedAt,
    headline: row.headline,
    facts: parseFacts(row.facts),
  };
}

/**
 * Write the snapshot for one ritual-period, or return the one already there.
 *
 * Idempotent by `(ritual, periodKey)` — the first compose of a period is the
 * record of it. Returns the stored row either way (`written` says which), so
 * a caller can tell "I recorded today's brief" from "today's brief was
 * already recorded" without a second query.
 */
export function recordRitualSnapshot(input: RecordRitualSnapshotInput): {
  snapshot: RitualSnapshot;
  written: boolean;
} {
  const db = getDb();
  const composedAt = input.composedAt ?? Date.now();
  const id = `${input.ritual}:${input.periodKey}`;

  const inserted = db
    .insert(ritualSnapshots)
    .values({
      id,
      ritual: input.ritual,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      composedAt,
      headline: input.headline,
      facts: JSON.stringify(input.facts),
    })
    .onConflictDoNothing()
    .returning()
    .all() as SnapshotRow[];

  if (inserted.length > 0) {
    return { snapshot: toSnapshot(inserted[0]!), written: true };
  }

  const existing = getRitualSnapshotByPeriod(input.ritual, input.periodKey);
  if (existing) return { snapshot: existing, written: false };

  // Unreachable in practice (the conflict means a row exists). Returning the
  // input as composed keeps this total rather than throwing on a read race.
  return {
    snapshot: {
      id,
      ritual: input.ritual,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      composedAt,
      headline: input.headline,
      facts: input.facts,
    },
    written: false,
  };
}

/** Newest first. `ritual` filters to one kind; `limit` caps the page. */
export function listRitualSnapshots(opts?: {
  ritual?: RitualKind;
  limit?: number;
}): RitualSnapshot[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts?.limit ?? 60, 1), 200);
  const query = db.select().from(ritualSnapshots).$dynamic();
  if (opts?.ritual) {
    query.where(eq(ritualSnapshots.ritual, opts.ritual));
  }
  const rows = query
    .orderBy(desc(ritualSnapshots.composedAt))
    .limit(limit)
    .all() as SnapshotRow[];
  return rows.map(toSnapshot);
}

export function getRitualSnapshot(id: string): RitualSnapshot | null {
  const rows = getDb()
    .select()
    .from(ritualSnapshots)
    .where(eq(ritualSnapshots.id, id))
    .limit(1)
    .all() as SnapshotRow[];
  return rows[0] ? toSnapshot(rows[0]) : null;
}

export function getRitualSnapshotByPeriod(
  ritual: RitualKind,
  periodKey: string,
): RitualSnapshot | null {
  const rows = getDb()
    .select()
    .from(ritualSnapshots)
    .where(
      and(
        eq(ritualSnapshots.ritual, ritual),
        eq(ritualSnapshots.periodKey, periodKey),
      ),
    )
    .limit(1)
    .all() as SnapshotRow[];
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/**
 * The snapshot of the same ritual immediately before `composedAt`.
 *
 * This is the third thing riding on the store: the Weekly's *"two slipped"*
 * only becomes a comparison — better or worse than last week — when last
 * week's row exists. Null means there is no previous week, and a caller that
 * gets null must state the number plainly rather than invent a direction.
 */
export function getPreviousRitualSnapshot(
  ritual: RitualKind,
  composedAt: number,
): RitualSnapshot | null {
  const rows = getDb()
    .select()
    .from(ritualSnapshots)
    .where(
      and(
        eq(ritualSnapshots.ritual, ritual),
        sql`${ritualSnapshots.composedAt} < ${composedAt}`,
      ),
    )
    .orderBy(desc(ritualSnapshots.composedAt))
    .limit(1)
    .all() as SnapshotRow[];
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/**
 * Epoch ms of the oldest snapshot, or null when the log is empty.
 *
 * The archive's honest line is a function of this and nothing else: while the
 * store is younger than the history it is meant to hold, the page says so.
 * There is no configuration and no backfill flag — the absence is measured.
 */
export function getRitualSnapshotStoreStartedAt(): number | null {
  const rows = getDb()
    .select({ composedAt: ritualSnapshots.composedAt })
    .from(ritualSnapshots)
    .orderBy(asc(ritualSnapshots.composedAt))
    .limit(1)
    .all() as Array<{ composedAt: number }>;
  return rows[0]?.composedAt ?? null;
}

// ---------------------------------------------------------------------------
// Read-state — rides on the snapshot, keyed by device (design N1 + R4)
// ---------------------------------------------------------------------------

/**
 * Mark one snapshot read on one device. Idempotent: the first read is the one
 * that counts, so re-opening does not move the timestamp.
 *
 * Not yet wired to a route or to the mobile client — read-state is still
 * device-local in `apps/web/src/mobile-v3/today/ritual-progress.ts`, and that
 * switchover is a separate change. What this gives it is somewhere to land
 * that needs no second migration.
 */
export function markRitualSnapshotRead(
  snapshotId: string,
  deviceId: string,
  readAt: number = Date.now(),
): void {
  getDb()
    .insert(ritualSnapshotReads)
    .values({ snapshotId, deviceId, readAt })
    .onConflictDoNothing()
    .run();
}

/** Epoch ms this device read this snapshot, or null if it has not. */
export function getRitualSnapshotReadAt(
  snapshotId: string,
  deviceId: string,
): number | null {
  const rows = getDb()
    .select({ readAt: ritualSnapshotReads.readAt })
    .from(ritualSnapshotReads)
    .where(
      and(
        eq(ritualSnapshotReads.snapshotId, snapshotId),
        eq(ritualSnapshotReads.deviceId, deviceId),
      ),
    )
    .limit(1)
    .all() as Array<{ readAt: number }>;
  return rows[0]?.readAt ?? null;
}

/** Snapshot ids this device has read, for annotating a listing in one query. */
export function listReadSnapshotIdsForDevice(deviceId: string): Set<string> {
  const rows = getDb()
    .select({ snapshotId: ritualSnapshotReads.snapshotId })
    .from(ritualSnapshotReads)
    .where(eq(ritualSnapshotReads.deviceId, deviceId))
    .all() as Array<{ snapshotId: string }>;
  return new Set(rows.map((r) => r.snapshotId));
}
