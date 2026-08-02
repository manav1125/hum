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

import { and, desc, eq } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { contactMemory } from "../memory/schema/index.js";
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
