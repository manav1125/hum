// ---------------------------------------------------------------------------
// Work — the `work` recall source
// ---------------------------------------------------------------------------
//
// What Cue is doing, or has done, about the thing being asked.
//
// This is the source that lets an answer end with something actionable:
// "$47 a seat, the SOC 2 report — asked for twice, still not sent" is only
// possible if the answer can see the work items alongside the notes and the
// mail. It is also what makes "2 of these aren't in HQ as tasks → Add them"
// truthful rather than a guess: the answer knows which commitments already
// have work behind them because it looked.
//
// Terminal items are included on purpose. "Did we ever send that?" is
// answered by a `done` item as surely as by an open one, and a source that
// only sees the queue would answer "no" to a question whose real answer is
// "yes, last Tuesday" — which is worse than not answering.

import { desc, like, or, sql } from "drizzle-orm";

import { getLogger } from "../../../util/logger.js";
import { getDb } from "../../db-connection.js";
import { workItems } from "../../schema.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";
import { queryTerms, scoreNote } from "./notes.js";

const log = getLogger("recall-work");

const EXCERPT_MAX_CHARS = 400;

/**
 * What a work item's state means to someone reading an answer, in their
 * words rather than the column's. `awaiting_review` is the one worth spelling
 * out: "waiting for you" is a fact about their day, "awaiting_review" is a
 * fact about our schema.
 */
const STATUS_PHRASE: Record<string, string> = {
  queued: "not started yet",
  running: "Cue is doing it now",
  awaiting_review: "waiting for you to look at it",
  failed: "it failed",
  cancelled: "cancelled",
  done: "done",
  archived: "archived",
};

export async function searchWorkSource(
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
    const clauses = terms.flatMap((term) => [
      like(sql`lower(${workItems.title})`, `%${term}%`),
      like(sql`lower(coalesce(${workItems.notes}, ''))`, `%${term}%`),
    ]);

    const rows = db
      .select()
      .from(workItems)
      .where(or(...clauses))
      .orderBy(desc(workItems.updatedAt))
      .limit(normalizedLimit * 4)
      .all();

    const evidence: RecallEvidence[] = rows
      .map((row) => {
        const haystack = `${row.title}\n${row.notes ?? ""}`;
        const phrase = STATUS_PHRASE[row.status] ?? row.status;
        return {
          id: `work:${row.id}`,
          source: "work" as const,
          title: row.title,
          locator: `work/${row.id}`,
          // The status is part of the excerpt, not metadata, because it is
          // the part that answers the question. A citation that says only
          // what the task is called does not tell you whether it happened.
          excerpt: clip(
            `${phrase}. ${row.notes ?? ""}`.trim(),
            EXCERPT_MAX_CHARS,
          ),
          timestampMs: row.updatedAt,
          score: scoreNote(haystack, terms),
          metadata: {
            status: row.status,
            projectId: row.projectId,
            dueAt: row.dueAt,
            // Set when this task came out of a note, so an answer can say
            // "you already made this a task, from your note on the 14th".
            noteId: row.noteId,
          },
        };
      })
      .filter((item) => (item.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, normalizedLimit);

    return { evidence };
  } catch (err) {
    log.warn({ err }, "work recall failed; degrading to other sources");
    return { evidence: [] };
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
