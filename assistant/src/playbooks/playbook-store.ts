/**
 * Playbook store — CRUD for the first-class `playbooks` table (WS-F).
 *
 * A playbook is a trigger→action rule: when an item on a matching channel (or
 * from a matching watcher) contains the trigger text, the runtime produces a
 * work item whose autonomy is capped by the global trust dial
 * (see autonomy-cap.ts + playbook-runtime.ts).
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { rawChanges } from "../memory/raw-query.js";
import { playbooks } from "../memory/schema.js";
import type { PlaybookAutonomyLevel } from "./types.js";

export interface PlaybookRecord {
  id: string;
  name: string;
  /** Case-insensitive substring matched against an item's title + summary. */
  triggerText: string;
  /** Channel this rule applies to, or '*' for any channel. */
  channel: string;
  /** Bind the rule to one watcher, or null to apply across watchers/channels. */
  watcherId: string | null;
  /** Natural-language description of what to do when the trigger matches. */
  action: string;
  /** Requested autonomy — the effective value is capped at fire/read time. */
  autonomyLevel: PlaybookAutonomyLevel;
  /** Higher wins when multiple playbooks match one event. */
  priority: number;
  enabled: boolean;
  lastFiredAt: number | null;
  scopeId: string;
  createdAt: number;
  updatedAt: number;
}

const VALID_AUTONOMY = new Set<string>(["auto", "draft", "notify"]);

function normalizeAutonomy(value: unknown): PlaybookAutonomyLevel {
  return typeof value === "string" && VALID_AUTONOMY.has(value)
    ? (value as PlaybookAutonomyLevel)
    : "draft";
}

export function createPlaybook(params: {
  name: string;
  triggerText: string;
  action: string;
  channel?: string;
  watcherId?: string | null;
  autonomyLevel?: PlaybookAutonomyLevel;
  priority?: number;
  enabled?: boolean;
  scopeId?: string;
}): PlaybookRecord {
  const db = getDb();
  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    name: params.name,
    triggerText: params.triggerText,
    channel: params.channel ?? "*",
    watcherId: params.watcherId ?? null,
    action: params.action,
    autonomyLevel: normalizeAutonomy(params.autonomyLevel),
    priority: params.priority ?? 0,
    enabled: params.enabled ?? true,
    lastFiredAt: null as number | null,
    scopeId: params.scopeId ?? "default",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(playbooks).values(row).run();
  return row;
}

export function getPlaybook(id: string): PlaybookRecord | null {
  const db = getDb();
  const row = db.select().from(playbooks).where(eq(playbooks.id, id)).get();
  return row ? parseRow(row) : null;
}

export function listPlaybooks(options?: {
  enabledOnly?: boolean;
  watcherId?: string;
  scopeId?: string;
}): PlaybookRecord[] {
  const db = getDb();
  const conditions = [];
  if (options?.enabledOnly) conditions.push(eq(playbooks.enabled, true));
  if (options?.watcherId !== undefined) {
    conditions.push(eq(playbooks.watcherId, options.watcherId));
  }
  if (options?.scopeId !== undefined) {
    conditions.push(eq(playbooks.scopeId, options.scopeId));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select()
    .from(playbooks)
    .where(where)
    .orderBy(desc(playbooks.priority), asc(playbooks.createdAt))
    .all()
    .map(parseRow);
}

/**
 * Playbooks that could fire for an event on `channel` from `watcherId`,
 * highest priority first. A rule matches when its channel is '*' or equals the
 * event's channel, AND its watcherId is null (channel-wide) or equals the
 * event's watcher.
 */
export function listMatchablePlaybooks(params: {
  channel: string;
  watcherId?: string | null;
  scopeId?: string;
}): PlaybookRecord[] {
  const db = getDb();
  const scopeId = params.scopeId ?? "default";
  const rows = db
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.enabled, true), eq(playbooks.scopeId, scopeId)))
    .orderBy(desc(playbooks.priority), asc(playbooks.createdAt))
    .all()
    .map(parseRow);
  return rows.filter((p) => {
    const channelOk = p.channel === "*" || p.channel === params.channel;
    const watcherOk =
      p.watcherId === null ||
      (params.watcherId != null && p.watcherId === params.watcherId);
    return channelOk && watcherOk;
  });
}

export function updatePlaybook(
  id: string,
  updates: {
    name?: string;
    triggerText?: string;
    channel?: string;
    watcherId?: string | null;
    action?: string;
    autonomyLevel?: PlaybookAutonomyLevel;
    priority?: number;
    enabled?: boolean;
  },
): PlaybookRecord | null {
  const db = getDb();
  const existing = getPlaybook(id);
  if (!existing) return null;

  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.triggerText !== undefined) set.triggerText = updates.triggerText;
  if (updates.channel !== undefined) set.channel = updates.channel;
  if (updates.watcherId !== undefined) set.watcherId = updates.watcherId;
  if (updates.action !== undefined) set.action = updates.action;
  if (updates.autonomyLevel !== undefined) {
    set.autonomyLevel = normalizeAutonomy(updates.autonomyLevel);
  }
  if (updates.priority !== undefined) set.priority = updates.priority;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  db.update(playbooks).set(set).where(eq(playbooks.id, id)).run();
  return getPlaybook(id);
}

export function deletePlaybook(id: string): boolean {
  const db = getDb();
  db.delete(playbooks).where(eq(playbooks.id, id)).run();
  return rawChanges() > 0;
}

/** Stamp the last-fired timestamp (drives the W3 "last-fired" column). */
export function markPlaybookFired(id: string, at: number = Date.now()): void {
  const db = getDb();
  db.update(playbooks)
    .set({ lastFiredAt: at, updatedAt: at })
    .where(eq(playbooks.id, id))
    .run();
}

/**
 * When a watcher is deleted, orphan any playbooks bound to it back to
 * channel-wide (watcherId = null) so they aren't silently stranded.
 */
export function unbindPlaybooksFromWatcher(watcherId: string): number {
  const db = getDb();
  db.update(playbooks)
    .set({ watcherId: null, updatedAt: Date.now() })
    .where(and(eq(playbooks.watcherId, watcherId)))
    .run();
  return rawChanges();
}

function parseRow(row: typeof playbooks.$inferSelect): PlaybookRecord {
  return {
    id: row.id,
    name: row.name,
    triggerText: row.triggerText,
    channel: row.channel,
    watcherId: row.watcherId,
    action: row.action,
    autonomyLevel: normalizeAutonomy(row.autonomyLevel),
    priority: row.priority,
    enabled: row.enabled,
    lastFiredAt: row.lastFiredAt,
    scopeId: row.scopeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
