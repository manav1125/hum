import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db-connection.js";
import { rawChanges } from "../memory/raw-query.js";
import { watcherEvents, watchers } from "../memory/schema.js";
import { truncate } from "../util/truncate.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./constants.js";

// ── Interfaces ──────────────────────────────────────────────────────

export interface Watcher {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  pollIntervalMs: number;
  actionPrompt: string;
  watermark: string | null;
  conversationId: string | null;
  status: string;
  consecutiveErrors: number;
  lastError: string | null;
  lastPollAt: number | null;
  nextPollAt: number;
  configJson: string | null;
  credentialService: string;
  /** 'came_in' — file events into the Came-in lane + run playbooks;
   *  'agent' — legacy background-LLM processing of action_prompt;
   *  'record_only' — keep the change stream in `watcher_events` and mint
   *  nothing (see `WatcherIntakeMode` in provider-types.ts). A provider may
   *  pin the effective mode, in which case the pin wins over this column. */
  intakeMode: string;
  createdAt: number;
  updatedAt: number;
}

export interface WatcherEvent {
  id: string;
  watcherId: string;
  externalId: string;
  eventType: string;
  summary: string;
  payloadJson: string;
  disposition: string;
  llmAction: string | null;
  processedAt: number | null;
  /**
   * Epoch ms the event happened at the SOURCE, from the provider's own clock
   * ({@link WatcherItem.timestamp}). Null when the provider gave no time, and
   * on every row recorded before migration 320.
   *
   * `createdAt` below is when this row was written, which is a fact about the
   * poll, not about the event. Anything measuring elapsed time for a human to
   * read must use this field.
   */
  occurredAt: number | null;
  createdAt: number;
}

// ── Watcher CRUD ────────────────────────────────────────────────────

export function createWatcher(params: {
  name: string;
  providerId: string;
  actionPrompt: string;
  credentialService: string;
  pollIntervalMs?: number;
  enabled?: boolean;
  configJson?: string | null;
  /** Defaults to 'came_in' — new watchers feed the Came-in lane + playbooks. */
  intakeMode?: string;
}): Watcher {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const enabled = params.enabled ?? true;
  const intakeMode = params.intakeMode ?? "came_in";

  const row = {
    id,
    name: params.name,
    providerId: params.providerId,
    enabled,
    pollIntervalMs,
    actionPrompt: params.actionPrompt,
    watermark: null as string | null,
    conversationId: null as string | null,
    status: "idle",
    consecutiveErrors: 0,
    lastError: null as string | null,
    lastPollAt: null as number | null,
    nextPollAt: enabled ? now : 0,
    configJson: params.configJson ?? null,
    credentialService: params.credentialService,
    intakeMode,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(watchers).values(row).run();
  return row;
}

export function getWatcher(id: string): Watcher | null {
  const db = getDb();
  const row = db.select().from(watchers).where(eq(watchers.id, id)).get();
  if (!row) return null;
  return parseWatcherRow(row);
}

export function listWatchers(options?: { enabledOnly?: boolean }): Watcher[] {
  const db = getDb();
  const conditions = options?.enabledOnly
    ? eq(watchers.enabled, true)
    : undefined;
  const rows = db
    .select()
    .from(watchers)
    .where(conditions)
    .orderBy(asc(watchers.createdAt))
    .all();
  return rows.map(parseWatcherRow);
}

export function updateWatcher(
  id: string,
  updates: {
    name?: string;
    actionPrompt?: string;
    pollIntervalMs?: number;
    enabled?: boolean;
    configJson?: string | null;
    intakeMode?: string;
  },
): Watcher | null {
  const db = getDb();
  const existing = db.select().from(watchers).where(eq(watchers.id, id)).get();
  if (!existing) return null;

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };

  if (updates.name !== undefined) set.name = updates.name;
  if (updates.actionPrompt !== undefined)
    set.actionPrompt = updates.actionPrompt;
  if (updates.pollIntervalMs !== undefined)
    set.pollIntervalMs = updates.pollIntervalMs;
  if (updates.configJson !== undefined) set.configJson = updates.configJson;
  if (updates.intakeMode !== undefined) set.intakeMode = updates.intakeMode;

  if (updates.enabled !== undefined) {
    set.enabled = updates.enabled;
    if (updates.enabled && !existing.enabled) {
      // Re-enabling: schedule next poll now, reset errors
      set.status = "idle";
      set.nextPollAt = now;
      set.consecutiveErrors = 0;
      set.lastError = null;
    } else if (!updates.enabled) {
      set.status = "disabled";
    }
  }

  db.update(watchers).set(set).where(eq(watchers.id, id)).run();
  return getWatcher(id);
}

export function deleteWatcher(id: string): boolean {
  const db = getDb();
  db.delete(watchers).where(eq(watchers.id, id)).run();
  return rawChanges() > 0;
}

// ── Claim / Complete ────────────────────────────────────────────────

/**
 * Atomically claim watchers that are due for polling. Sets their status
 * to 'polling' using optimistic locking on the current nextPollAt.
 */
export function claimDueWatchers(now: number): Watcher[] {
  const db = getDb();
  const candidates = db
    .select()
    .from(watchers)
    .where(
      and(
        eq(watchers.enabled, true),
        eq(watchers.status, "idle"),
        lte(watchers.nextPollAt, now),
      ),
    )
    .orderBy(asc(watchers.nextPollAt))
    .all();

  const claimed: Watcher[] = [];
  for (const row of candidates) {
    db.update(watchers)
      .set({ status: "polling", updatedAt: now })
      .where(
        and(
          eq(watchers.id, row.id),
          eq(watchers.nextPollAt, row.nextPollAt),
          eq(watchers.status, "idle"),
        ),
      )
      .run();

    if (rawChanges() === 0) continue;
    claimed.push(
      parseWatcherRow({ ...row, status: "polling", updatedAt: now }),
    );
  }
  return claimed;
}

/**
 * Complete a watcher poll: update watermark, advance nextPollAt, reset errors.
 */
export function completeWatcherPoll(
  id: string,
  result: { watermark: string; conversationId?: string },
): void {
  const db = getDb();
  const watcher = db.select().from(watchers).where(eq(watchers.id, id)).get();
  if (!watcher) return;

  const now = Date.now();
  const set: Record<string, unknown> = {
    status: "idle",
    watermark: result.watermark,
    lastPollAt: now,
    nextPollAt: now + watcher.pollIntervalMs,
    consecutiveErrors: 0,
    lastError: null,
    updatedAt: now,
  };

  if (result.conversationId) {
    set.conversationId = result.conversationId;
  }

  db.update(watchers).set(set).where(eq(watchers.id, id)).run();
}

/**
 * Skip a watcher poll: apply backoff to nextPollAt without incrementing
 * consecutiveErrors. Used when a poll is skipped for a recoverable reason
 * (e.g. credential health gate) that should NOT count toward the circuit
 * breaker threshold.
 */
export function skipWatcherPoll(id: string, reason: string): void {
  const db = getDb();
  const watcher = db.select().from(watchers).where(eq(watchers.id, id)).get();
  if (!watcher) return;

  const now = Date.now();
  // Use the same backoff formula but based on existing consecutiveErrors
  // (which stays unchanged). Minimum backoff of 30s.
  const backoff = Math.min(
    30_000 * Math.pow(2, watcher.consecutiveErrors),
    60 * 60 * 1000,
  );

  db.update(watchers)
    .set({
      status: "idle",
      lastError: truncate(reason, 2000, ""),
      lastPollAt: now,
      nextPollAt: now + backoff,
      updatedAt: now,
    })
    .where(eq(watchers.id, id))
    .run();
}

/**
 * Record a poll error: increment consecutive errors, apply backoff.
 */
export function failWatcherPoll(id: string, error: string): void {
  const db = getDb();
  const watcher = db.select().from(watchers).where(eq(watchers.id, id)).get();
  if (!watcher) return;

  const now = Date.now();
  const errors = watcher.consecutiveErrors + 1;
  // Exponential backoff: base * 2^(errors-1), capped at 1 hour
  const backoff = Math.min(30_000 * Math.pow(2, errors - 1), 60 * 60 * 1000);

  db.update(watchers)
    .set({
      status: "idle",
      consecutiveErrors: errors,
      lastError: truncate(error, 2000, ""),
      lastPollAt: now,
      nextPollAt: now + backoff,
      updatedAt: now,
    })
    .where(eq(watchers.id, id))
    .run();
}

/**
 * Disable a watcher (circuit breaker tripped).
 */
export function disableWatcher(id: string, reason: string): void {
  const db = getDb();
  db.update(watchers)
    .set({
      status: "disabled",
      enabled: false,
      lastError: truncate(reason, 2000, ""),
      updatedAt: Date.now(),
    })
    .where(eq(watchers.id, id))
    .run();
}

/**
 * Persist a background conversation ID for a watcher.
 * Called after creating the conversation in Phase 2 of the engine tick.
 */
export function setWatcherConversationId(
  id: string,
  conversationId: string,
): void {
  const db = getDb();
  db.update(watchers)
    .set({ conversationId, updatedAt: Date.now() })
    .where(eq(watchers.id, id))
    .run();
}

/**
 * Reset watchers stuck in 'polling' back to 'idle' (daemon restart recovery).
 */
export function resetStuckWatchers(): number {
  const db = getDb();
  db.update(watchers)
    .set({ status: "idle", updatedAt: Date.now() })
    .where(eq(watchers.status, "polling"))
    .run();
  return rawChanges();
}

// ── Watcher Events ──────────────────────────────────────────────────

/**
 * Accept a provider's event time only if it could actually be one.
 *
 * Providers reach this value through `new Date(someHeader).getTime()`, which
 * yields NaN for anything it cannot parse, and `parseInt`, which does the
 * same. NaN reaching SQLite would land as a real-looking, number-shaped column
 * value that every later comparison silently answers false to, so it is
 * rejected here — at the one boundary every provider crosses — rather than in
 * seven call sites that each have to remember.
 *
 * Zero and negatives are rejected for the same reason: they are what a failed
 * parse or an unset field degrades into, and 1970 is not a time anybody is
 * going to receive mail from.
 */
function sourceEventTime(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Insert a watcher event with dedup on (watcher_id, external_id).
 * Returns true if the event was inserted (new), false if it already existed.
 */
export function insertWatcherEvent(params: {
  watcherId: string;
  externalId: string;
  eventType: string;
  summary: string;
  payloadJson: string;
  /**
   * The provider's own event time (epoch ms). Omit only when the provider
   * genuinely has none — it is stored as null rather than defaulted to `now`,
   * because a fabricated event time is worse than a missing one: readers can
   * skip a null, but they cannot detect a plausible lie.
   */
  occurredAt?: number | null;
}): boolean {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  try {
    db.insert(watcherEvents)
      .values({
        id,
        watcherId: params.watcherId,
        externalId: params.externalId,
        eventType: params.eventType,
        summary: params.summary,
        payloadJson: params.payloadJson,
        disposition: "pending",
        llmAction: null,
        processedAt: null,
        occurredAt: sourceEventTime(params.occurredAt),
        createdAt: now,
      })
      .run();
    return true;
  } catch (err: unknown) {
    // UNIQUE constraint violation — event already exists
    if (
      err instanceof Error &&
      err.message.includes("UNIQUE constraint failed")
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Update the disposition and LLM action for a watcher event.
 */
export function updateEventDisposition(
  eventId: string,
  disposition: string,
  llmAction?: string,
): void {
  const db = getDb();
  db.update(watcherEvents)
    .set({
      disposition,
      llmAction: llmAction?.slice(0, 5000) ?? null,
      processedAt: Date.now(),
    })
    .where(eq(watcherEvents.id, eventId))
    .run();
}

/**
 * Get pending events for a watcher.
 */
export function getPendingEvents(watcherId: string): WatcherEvent[] {
  const db = getDb();
  return db
    .select()
    .from(watcherEvents)
    .where(
      and(
        eq(watcherEvents.watcherId, watcherId),
        eq(watcherEvents.disposition, "pending"),
      ),
    )
    .orderBy(asc(watcherEvents.createdAt))
    .all()
    .map(parseEventRow);
}

/**
 * List watcher events for digest queries.
 */
export function listWatcherEvents(options?: {
  watcherId?: string;
  limit?: number;
  since?: number;
}): WatcherEvent[] {
  const db = getDb();
  const conditions = [];
  if (options?.watcherId)
    conditions.push(eq(watcherEvents.watcherId, options.watcherId));
  if (options?.since)
    conditions.push(gte(watcherEvents.createdAt, options.since));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return db
    .select()
    .from(watcherEvents)
    .where(where)
    .orderBy(desc(watcherEvents.createdAt))
    .limit(options?.limit ?? 50)
    .all()
    .map(parseEventRow);
}

/**
 * How much each watcher has actually produced: one row per watcher that has
 * ever recorded an event.
 *
 * The surface used to answer "is this thing working?" with `last_poll_at`,
 * labelled "Last hit" — so a watcher that had polled 320 times and recorded
 * nothing read as "hit 2m ago". A poll is not a hit. This is the number that
 * makes the two distinguishable, and it is the one query shape that catches
 * this whole class of bug: work done versus rows produced.
 *
 * Watchers with zero events are absent from the map; the caller reads a missing
 * key as zero rather than as unknown, because "no rows" IS the answer.
 */
export function getWatcherHitStats(): Map<
  string,
  { hitCount: number; lastHitAt: number | null }
> {
  const db = getDb();
  const rows = db
    .select({
      watcherId: watcherEvents.watcherId,
      hitCount: sql<number>`count(*)`,
      // The source's own clock when it gave one — this is read as "how long
      // since something arrived", and `created_at` answers a question about
      // our poll, not about the event. Rows written before migration 320 have
      // no `occurred_at`, so they fall back rather than vanishing.
      lastHitAt: sql<
        number | null
      >`max(coalesce(${watcherEvents.occurredAt}, ${watcherEvents.createdAt}))`,
    })
    .from(watcherEvents)
    .groupBy(watcherEvents.watcherId)
    .all();

  const out = new Map<string, { hitCount: number; lastHitAt: number | null }>();
  for (const row of rows) {
    out.set(row.watcherId, {
      hitCount: Number(row.hitCount),
      lastHitAt: row.lastHitAt === null ? null : Number(row.lastHitAt),
    });
  }
  return out;
}

// ── Row parsers ─────────────────────────────────────────────────────

function parseWatcherRow(row: typeof watchers.$inferSelect): Watcher {
  return {
    id: row.id,
    name: row.name,
    providerId: row.providerId,
    enabled: row.enabled,
    pollIntervalMs: row.pollIntervalMs,
    actionPrompt: row.actionPrompt,
    watermark: row.watermark,
    conversationId: row.conversationId,
    status: row.status,
    consecutiveErrors: row.consecutiveErrors,
    lastError: row.lastError,
    lastPollAt: row.lastPollAt,
    nextPollAt: row.nextPollAt,
    configJson: row.configJson,
    credentialService: row.credentialService,
    intakeMode: row.intakeMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseEventRow(row: typeof watcherEvents.$inferSelect): WatcherEvent {
  return {
    id: row.id,
    watcherId: row.watcherId,
    externalId: row.externalId,
    eventType: row.eventType,
    summary: row.summary,
    payloadJson: row.payloadJson,
    disposition: row.disposition,
    llmAction: row.llmAction,
    processedAt: row.processedAt,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}
