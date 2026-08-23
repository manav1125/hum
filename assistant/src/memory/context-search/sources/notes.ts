// ---------------------------------------------------------------------------
// Notes — the `notes` recall source
// ---------------------------------------------------------------------------
//
// What a person wrote down, searchable alongside everything else Cue knows.
//
// This adapter is what makes a pile of notes compound. Without it Notes is a
// folder: things go in, and finding one again means remembering you wrote it.
// The demo that matters is a five-month-old note nobody would have gone
// looking for, surfaced because it answers the question being asked — which
// is why `timestampMs` carries the note's `occurredAt` rather than its row
// creation time, and why age is never a filter here. An old note is not a
// worse note; it is a note the answer should flag as old and let the reader
// judge.
//
// Deliberately lexical rather than embedded. Notes are short, written in the
// owner's own vocabulary, and usually searched with the words they used —
// which is the case term matching is good at. It also costs nothing per
// query, and the recall path already pays for embeddings on the `memory`
// source; charging a second time to find your own sentence is hard to
// justify.

import { and, desc, eq, isNotNull, like, or, sql } from "drizzle-orm";

import { getLogger } from "../../../util/logger.js";
import { getDb } from "../../db-connection.js";
import { notes } from "../../schema.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";

const log = getLogger("recall-notes");

/** Enough of a note to judge it by; the locator opens the whole thing. */
const EXCERPT_MAX_CHARS = 600;

/** Terms shorter than this match everything and rank nothing. */
const MIN_TERM_LENGTH = 3;

/** Cap on how many terms one query contributes, so a paragraph is not a scan. */
const MAX_TERMS = 8;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "and",
  "any",
  "are",
  "because",
  "been",
  "before",
  "but",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "its",
  "just",
  "not",
  "our",
  "out",
  "over",
  "own",
  "said",
  "same",
  "she",
  "should",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** The words worth matching on, lowercased and de-duplicated. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9'$%.-]+/)) {
    const term = raw.replace(/^['.-]+|['.-]+$/g, "");
    if (term.length < MIN_TERM_LENGTH) continue;
    if (STOP_WORDS.has(term)) continue;
    seen.add(term);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** A window of the note around the first term that matched. */
export function excerptAround(body: string, terms: readonly string[]): string {
  const haystack = body.toLowerCase();
  const at = terms
    .map((term) => haystack.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (at === undefined) return clip(body, EXCERPT_MAX_CHARS);

  const start = Math.max(0, at - Math.floor(EXCERPT_MAX_CHARS / 3));
  const slice = body.slice(start, start + EXCERPT_MAX_CHARS).trim();
  return `${start > 0 ? "…" : ""}${slice}${
    start + EXCERPT_MAX_CHARS < body.length ? "…" : ""
  }`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * How well a note answers the query: how many distinct terms it contains,
 * normalised. Deliberately not tf-idf — with a corpus this small and this
 * personal, "contains more of what you asked about" is both the honest
 * ranking and the one whose behaviour a person can predict.
 */
export function scoreNote(haystack: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = haystack.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term)).length;
  return hits / terms.length;
}

export async function searchNotesSource(
  query: string,
  _context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) return { evidence: [] };

  const terms = queryTerms(query);
  if (terms.length === 0) return { evidence: [] };

  try {
    const db = getDb();
    // Pull candidates with SQL, rank in memory. The `LIKE` set is deliberately
    // generous (any term) because the ranking below rewards notes carrying
    // more of them — a narrow AND would drop the five-month-old note that
    // uses one of the words and answers the question.
    const clauses = terms.flatMap((term) => [
      like(sql`lower(${notes.body})`, `%${term}%`),
      like(sql`lower(${notes.title})`, `%${term}%`),
    ]);

    const rows = db
      .select()
      .from(notes)
      .where(or(...clauses))
      .orderBy(desc(notes.occurredAt))
      .limit(normalizedLimit * 4)
      .all();

    const evidence: RecallEvidence[] = rows
      .map((row) => {
        const haystack = `${row.title}\n${row.body}`;
        return {
          id: `note:${row.id}`,
          source: "notes" as const,
          title: row.title,
          // Resolvable by the client into the note itself, so a citation is
          // something you can open rather than a claim you must believe.
          locator: `notes/${row.id}`,
          excerpt: excerptAround(row.body || row.title, terms),
          // When the THOUGHT happened. A note written up later about an older
          // conversation should date from the conversation.
          timestampMs: row.occurredAt,
          score: scoreNote(haystack, terms),
          metadata: {
            source: row.source,
            projectId: row.projectId,
            recorded: row.audioPath != null,
          },
        };
      })
      .filter((item) => (item.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, normalizedLimit);

    return { evidence };
  } catch (err) {
    // A missing table (a daemon that predates migration 332) or a locked DB.
    // Recall degrades to its other sources rather than failing the answer.
    log.warn({ err }, "notes recall failed; degrading to other sources");
    return { evidence: [] };
  }
}

/**
 * Notes filed to a project, for the project room's own recall. Exported
 * separately because it is a browse, not a search — no query, no ranking.
 */
export function listNotesForProject(
  projectId: string,
  limit = 20,
): RecallEvidence[] {
  try {
    const db = getDb();
    return db
      .select()
      .from(notes)
      .where(and(eq(notes.projectId, projectId), isNotNull(notes.projectId)))
      .orderBy(desc(notes.occurredAt))
      .limit(limit)
      .all()
      .map((row) => ({
        id: `note:${row.id}`,
        source: "notes" as const,
        title: row.title,
        locator: `notes/${row.id}`,
        excerpt: clip(row.body || row.title, EXCERPT_MAX_CHARS),
        timestampMs: row.occurredAt,
      }));
  } catch {
    return [];
  }
}
