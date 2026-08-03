/**
 * contact_memory store — the "WHAT CUE REMEMBERS" backend.
 *
 * CRUD over durable facts Cue knows about a person, plus the persistence entry
 * point the auto-extraction pass writes through. Facts enter through:
 *   - the manual/told path (rememberFact / the POST dossier route), and
 *   - from_conversation (extractContactMemoryFromConversation), called by
 *     contact-memory-extract-job.ts with facts a flash pass pulled from a
 *     bound conversation or from the person's correspondence.
 *
 * Referential integrity to contacts is a real FK (ON DELETE CASCADE) — see
 * migration 294 — so forgetting a contact forgets its memory.
 */

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { contactMemory, contacts } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import type {
  ContactMemory,
  ContactMemoryKind,
  ContactMemorySource,
} from "./memory-types.js";

const log = getLogger("contact-memory-store");

const VALID_KINDS: readonly ContactMemoryKind[] = [
  "fact",
  "preference",
  "relationship",
  "context",
];
const VALID_SOURCES: readonly ContactMemorySource[] = [
  "told",
  "inferred",
  "from_conversation",
];

export function isContactMemoryKind(v: string): v is ContactMemoryKind {
  return (VALID_KINDS as readonly string[]).includes(v);
}
export function isContactMemorySource(v: string): v is ContactMemorySource {
  return (VALID_SOURCES as readonly string[]).includes(v);
}

function parse(row: typeof contactMemory.$inferSelect): ContactMemory {
  return {
    id: row.id,
    contactId: row.contactId,
    statement: row.statement,
    kind: row.kind as ContactMemoryKind,
    source: row.source as ContactMemorySource,
    sourceRef: row.sourceRef,
    confidence: row.confidence,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/** Clamp confidence into [0, 1]; default 1.0 for out-of-range/undefined. */
function clampConfidence(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(1, value));
}

// ── Reads ────────────────────────────────────────────────────────────

/** All remembered facts for a contact, newest-seen first. */
export function listContactMemory(contactId: string): ContactMemory[] {
  const db = getDb();
  return db
    .select()
    .from(contactMemory)
    .where(eq(contactMemory.contactId, contactId))
    .orderBy(desc(contactMemory.lastSeenAt), desc(contactMemory.createdAt))
    .all()
    .map(parse);
}

// ── Bulk read (the People list's one call per page) ──────────────────

/**
 * Ids a single bulk read will accept. A list surface renders a page, so the
 * bound is a page's worth of people with room to spare — the whole production
 * roster (87 contacts) fits in one call, and a caller that wants more is
 * asking for a scan, not a screen. Over the cap the route rejects rather than
 * truncates: a silently shortened answer is indistinguishable from a set of
 * contacts with nothing learned, which is the exact confusion this endpoint
 * exists to end.
 */
export const CONTACT_MEMORY_BULK_MAX_CONTACTS = 100;

/**
 * Rows returned per contact. The card shows a three-line clamp and the busiest
 * contact in production has 4 facts, so 12 is well past what any card renders;
 * `total` carries the real count so a trimmed list is never mistaken for the
 * whole of what Cue knows.
 */
export const CONTACT_MEMORY_BULK_MAX_ROWS_PER_CONTACT = 12;

/**
 * What happened for one contact in a bulk read. Three outcomes, never two:
 *
 *   `learned`      rows exist, and here they are.
 *   `empty`        we looked, the contact is real, and there is nothing yet.
 *   `unavailable`  we could NOT look — the read failed, or no such contact.
 *
 * Collapsing `unavailable` into `empty` is the bug that let a 697-job pipeline
 * write nothing while every surface said "no memories yet". Callers must
 * render the third case as a failure, not as an absence.
 */
export type ContactMemoryReadStatus = "learned" | "empty" | "unavailable";

export interface ContactMemoryRead {
  contactId: string;
  status: ContactMemoryReadStatus;
  /** Newest-seen first, at most `rowsPerContact`. Empty unless `learned`. */
  memory: ContactMemory[];
  /** Rows this contact actually has — `memory` may be a capped prefix. */
  total: number;
  /** Why we could not look, in plain language. Only set for `unavailable`. */
  reason: string | null;
}

function unavailable(contactId: string, reason: string): ContactMemoryRead {
  return { contactId, status: "unavailable", memory: [], total: 0, reason };
}

/**
 * Memory for many contacts in one pass: one existence query and one memory
 * query, regardless of how many ids are asked for.
 *
 * Ids are de-duplicated; the result carries one entry per distinct id, in the
 * order given. A read that throws does not become an empty answer — every
 * requested contact comes back `unavailable` with the reason, because "the
 * query failed" and "this person has nothing" are different sentences.
 */
export function readContactMemoryForContacts(
  contactIds: string[],
  opts: { rowsPerContact?: number } = {},
): ContactMemoryRead[] {
  const rowsPerContact = Math.max(
    1,
    opts.rowsPerContact ?? CONTACT_MEMORY_BULK_MAX_ROWS_PER_CONTACT,
  );
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return [];
  if (ids.length > CONTACT_MEMORY_BULK_MAX_CONTACTS) {
    // Callers validate first and reject; this guards the data layer against a
    // caller that forgot, so the bound can't be lost by a new call site.
    throw new Error(
      `readContactMemoryForContacts: ${ids.length} ids exceeds the ${CONTACT_MEMORY_BULK_MAX_CONTACTS} cap`,
    );
  }

  const db = getDb();
  let known: Set<string>;
  const byContact = new Map<string, ContactMemory[]>();
  try {
    known = new Set(
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(inArray(contacts.id, ids))
        .all()
        .map((row) => row.id),
    );
    const rows = db
      .select()
      .from(contactMemory)
      .where(inArray(contactMemory.contactId, ids))
      .orderBy(desc(contactMemory.lastSeenAt), desc(contactMemory.createdAt))
      .all();
    // A global sort by (lastSeenAt, createdAt) is also a valid per-contact
    // sort, so grouping preserves newest-seen-first within each contact.
    for (const row of rows) {
      const parsed = parse(row);
      const bucket = byContact.get(parsed.contactId);
      if (bucket) bucket.push(parsed);
      else byContact.set(parsed.contactId, [parsed]);
    }
  } catch (err) {
    log.warn(
      { err: String(err), contacts: ids.length },
      "bulk contact-memory read failed; reporting every contact as unavailable",
    );
    return ids.map((id) =>
      unavailable(id, "Cue couldn't read what it remembers"),
    );
  }

  return ids.map((id) => {
    if (!known.has(id)) {
      return unavailable(id, "Cue has no contact with this id");
    }
    const rows = byContact.get(id) ?? [];
    if (rows.length === 0) {
      return {
        contactId: id,
        status: "empty",
        memory: [],
        total: 0,
        reason: null,
      };
    }
    return {
      contactId: id,
      status: "learned",
      memory: rows.slice(0, rowsPerContact),
      total: rows.length,
      reason: null,
    };
  });
}

export function getContactMemory(id: string): ContactMemory | null {
  const db = getDb();
  const row = db
    .select()
    .from(contactMemory)
    .where(eq(contactMemory.id, id))
    .get();
  return row ? parse(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────

/**
 * Add a fact Cue remembers about a contact. The manual "remember about X" path
 * defaults to source=told, confidence 1.0. De-dupes on an exact
 * (contactId, statement) match — a repeat "told" just bumps last_seen_at and
 * upgrades provenance/confidence rather than inserting a duplicate row.
 */
export function rememberFact(params: {
  contactId: string;
  statement: string;
  kind?: ContactMemoryKind;
  source?: ContactMemorySource;
  sourceRef?: string | null;
  confidence?: number;
}): ContactMemory {
  const db = getDb();
  const now = Date.now();
  const statement = params.statement.trim();
  if (!statement) throw new Error("statement is required");

  const existing = db
    .select()
    .from(contactMemory)
    .where(
      and(
        eq(contactMemory.contactId, params.contactId),
        eq(contactMemory.statement, statement),
      ),
    )
    .get();

  if (existing) {
    const nextConfidence = Math.max(
      existing.confidence,
      clampConfidence(params.confidence),
    );
    db.update(contactMemory)
      .set({
        lastSeenAt: now,
        kind: params.kind ?? existing.kind,
        source: params.source ?? existing.source,
        sourceRef: params.sourceRef ?? existing.sourceRef,
        confidence: nextConfidence,
      })
      .where(eq(contactMemory.id, existing.id))
      .run();
    return getContactMemory(existing.id)!;
  }

  const row: typeof contactMemory.$inferInsert = {
    id: randomUUID(),
    contactId: params.contactId,
    statement,
    kind: params.kind ?? "fact",
    source: params.source ?? "told",
    sourceRef: params.sourceRef ?? null,
    confidence: clampConfidence(params.confidence),
    createdAt: now,
    lastSeenAt: now,
  };
  db.insert(contactMemory).values(row).run();
  return parse(row as typeof contactMemory.$inferSelect);
}

/** Correct/patch a remembered fact. Returns the updated fact, or null. */
export function updateContactMemory(
  id: string,
  patch: {
    statement?: string;
    kind?: ContactMemoryKind;
    confidence?: number;
  },
): ContactMemory | null {
  const db = getDb();
  const existing = getContactMemory(id);
  if (!existing) return null;

  const set: Record<string, unknown> = { lastSeenAt: Date.now() };
  if (patch.statement !== undefined) {
    const trimmed = patch.statement.trim();
    if (!trimmed) throw new Error("statement cannot be empty");
    set.statement = trimmed;
  }
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.confidence !== undefined)
    set.confidence = clampConfidence(patch.confidence);

  db.update(contactMemory).set(set).where(eq(contactMemory.id, id)).run();
  return getContactMemory(id);
}

/** Forget a fact. Returns whether a row was deleted. */
export function forgetFact(id: string): boolean {
  const raw = getSqliteFrom(getDb());
  const result = raw
    .prepare(/*sql*/ `DELETE FROM contact_memory WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

// ── Auto-extraction persistence ──────────────────────────────────────

/**
 * Persist 0-3 durable facts about a contact with source=from_conversation and
 * source_ref set to where they came from.
 *
 * The caller resolves the person first — this function is handed a contactId
 * that was established through a channel identity, never guessed from message
 * content. Returns the rows actually WRITTEN, which is the number the callers
 * report on: "the model answered" and "Cue learned something" are different
 * claims, and only the second one is worth counting.
 */
export function extractContactMemoryFromConversation(params: {
  contactId: string;
  /** Conversation id, or another provenance ref for the source_ref column. */
  conversationId: string;
  /**
   * The facts to persist. An empty/omitted list is a legitimate outcome (the
   * extractor found nothing durable) and writes nothing.
   */
  facts?: Array<{
    statement: string;
    kind?: ContactMemoryKind;
    confidence?: number;
  }>;
}): ContactMemory[] {
  const facts = params.facts ?? [];
  if (facts.length === 0) return [];

  const persisted: ContactMemory[] = [];
  for (const fact of facts.slice(0, 3)) {
    try {
      persisted.push(
        rememberFact({
          contactId: params.contactId,
          statement: fact.statement,
          kind: fact.kind ?? "context",
          source: "from_conversation",
          sourceRef: params.conversationId,
          confidence: fact.confidence ?? 0.6,
        }),
      );
    } catch (err) {
      log.warn(
        { err: String(err), contactId: params.contactId },
        "failed to persist extracted contact memory (ignored)",
      );
    }
  }
  return persisted;
}
