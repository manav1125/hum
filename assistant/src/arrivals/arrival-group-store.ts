/**
 * Store for `arrival_group_members` — the messages folded into one work item.
 *
 * Two rules this module exists to keep:
 *
 *   1. **A merge is never a deletion.** There is no delete. Splitting a
 *      message back out stamps `detachedAt` / `detachedBy` and records the
 *      work item it became; the row itself stays, so "this was combined and
 *      then separated again" remains readable afterwards.
 *   2. **The count is a query, not a counter.** What a card shows ("15
 *      notifications from ZA Bank") is `countActiveMembers`, derived from the
 *      live rows. Nothing increments a stored total, so nothing can drift away
 *      from the list the owner can open and check.
 *
 * The anchor — the message that created the work item — gets a row too. Without
 * it, "what was combined" would silently omit the first message, and the count
 * would be one short of what the owner sees.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { arrivalGroupMembers } from "../memory/schema.js";

/** Which rule combined these messages. */
export type ArrivalGroupKind = "thread" | "sender";

export interface ArrivalGroupMember {
  id: string;
  workItemId: string;
  groupKey: string;
  groupKind: ArrivalGroupKind;
  channel: string;
  arrivalId: string;
  externalId: string;
  title: string;
  snippet: string | null;
  senderAddress: string | null;
  /** 1 for the message that created the work item, 0 for later updates. */
  isAnchor: number;
  receivedAt: number;
  detachedAt: number | null;
  detachedBy: string | null;
  detachedWorkItemId: string | null;
  createdAt: number;
}

export interface AddGroupMemberInput {
  workItemId: string;
  groupKey: string;
  groupKind: ArrivalGroupKind;
  channel: string;
  arrivalId: string;
  externalId: string;
  title: string;
  snippet?: string | null;
  senderAddress?: string | null;
  isAnchor: boolean;
  receivedAt?: number;
}

/**
 * Record one message as part of a group. Idempotent on `arrivalId`: a replayed
 * poll returns the existing row rather than inflating the group's count.
 */
export function addGroupMember(input: AddGroupMemberInput): ArrivalGroupMember {
  const existing = getMemberByArrival(input.arrivalId);
  if (existing) return existing;

  const db = getDb();
  const now = Date.now();
  const row: ArrivalGroupMember = {
    id: crypto.randomUUID(),
    workItemId: input.workItemId,
    groupKey: input.groupKey,
    groupKind: input.groupKind,
    channel: input.channel,
    arrivalId: input.arrivalId,
    externalId: input.externalId,
    title: input.title,
    snippet: input.snippet ?? null,
    senderAddress: input.senderAddress?.toLowerCase() ?? null,
    isAnchor: input.isAnchor ? 1 : 0,
    receivedAt: input.receivedAt ?? now,
    detachedAt: null,
    detachedBy: null,
    detachedWorkItemId: null,
    createdAt: now,
  };
  db.insert(arrivalGroupMembers).values(row).run();
  return row;
}

export function getGroupMember(id: string): ArrivalGroupMember | undefined {
  const db = getDb();
  return db
    .select()
    .from(arrivalGroupMembers)
    .where(eq(arrivalGroupMembers.id, id))
    .get() as ArrivalGroupMember | undefined;
}

export function getMemberByArrival(
  arrivalId: string,
): ArrivalGroupMember | undefined {
  const db = getDb();
  return db
    .select()
    .from(arrivalGroupMembers)
    .where(eq(arrivalGroupMembers.arrivalId, arrivalId))
    .get() as ArrivalGroupMember | undefined;
}

/**
 * Every message ever folded into a work item, oldest first — detached ones
 * included. This is the "what was combined" read, and it deliberately shows
 * the splits too: a group whose history is edited to look tidy is a group the
 * owner cannot audit.
 */
export function listGroupMembers(workItemId: string): ArrivalGroupMember[] {
  const db = getDb();
  return db
    .select()
    .from(arrivalGroupMembers)
    .where(eq(arrivalGroupMembers.workItemId, workItemId))
    .orderBy(asc(arrivalGroupMembers.receivedAt))
    .all() as ArrivalGroupMember[];
}

/** How many messages are currently folded into this item (anchor included). */
export function countActiveMembers(workItemId: string): number {
  const db = getDb();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(arrivalGroupMembers)
    .where(
      and(
        eq(arrivalGroupMembers.workItemId, workItemId),
        isNull(arrivalGroupMembers.detachedAt),
      ),
    )
    .get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * The live anchor row for a group key, if any. Oldest-first so the message
 * that opened the group is the one returned, which is the item later messages
 * should be folded into.
 */
export function findGroupAnchor(
  channel: string,
  groupKey: string,
): ArrivalGroupMember | undefined {
  const db = getDb();
  return db
    .select()
    .from(arrivalGroupMembers)
    .where(
      and(
        eq(arrivalGroupMembers.channel, channel),
        eq(arrivalGroupMembers.groupKey, groupKey),
        eq(arrivalGroupMembers.isAnchor, 1),
        isNull(arrivalGroupMembers.detachedAt),
      ),
    )
    .orderBy(asc(arrivalGroupMembers.createdAt))
    .get() as ArrivalGroupMember | undefined;
}

/**
 * Stamp a member as split back out, recording the work item it became.
 *
 * Append-only by design: the row keeps its group key, its anchor flag and its
 * original title, so the fact that Cue once combined these two messages — and
 * that the owner disagreed — survives. That disagreement is the only signal
 * available for making the grouping rules better later.
 */
export function markMemberDetached(
  memberId: string,
  detachedWorkItemId: string | null,
  actor = "user",
): ArrivalGroupMember | undefined {
  const db = getDb();
  db.update(arrivalGroupMembers)
    .set({
      detachedAt: Date.now(),
      detachedBy: actor,
      detachedWorkItemId,
    })
    .where(eq(arrivalGroupMembers.id, memberId))
    .run();
  return getGroupMember(memberId);
}
