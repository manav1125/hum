// ---------------------------------------------------------------------------
// Email — the `email` recall source
// ---------------------------------------------------------------------------
//
// What actually arrived, and who sent it.
//
// This reads the `arrivals` ledger rather than calling a mail provider, and
// the difference is worth stating because it decides what the source can
// honestly claim. Arrivals are everything Cue has *seen* — every watcher hit,
// whether it was surfaced into the lane or filed away as noise. So this
// answers "what did Dana say" for anything that came past Cue, and cannot
// answer it for mail that never did.
//
// **Filed arrivals are searched too, deliberately.** "Filed" means Cue judged
// it not worth interrupting you over; it never meant deleted, and a search
// that skipped filed mail would answer "nothing from Stripe" about an inbox
// full of Stripe. The disposition rides along in metadata so an answer can
// say where something was found.
//
// No network call, so recall stays cheap and works offline; the cost is that
// this is a record of what Cue saw, not a live mailbox. An answer built on it
// should say "from Dana's email" — which is true — and never imply it just
// checked your inbox.

import { desc, like, or, sql } from "drizzle-orm";

import { getLogger } from "../../../util/logger.js";
import { getDb } from "../../db-connection.js";
import { arrivals } from "../../schema.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";
import { queryTerms, scoreNote } from "./notes.js";

const log = getLogger("recall-email");

const EXCERPT_MAX_CHARS = 600;

export async function searchEmailSource(
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
      like(sql`lower(${arrivals.title})`, `%${term}%`),
      like(sql`lower(coalesce(${arrivals.snippet}, ''))`, `%${term}%`),
      // Searching the sender matters as much as the subject: "what did Dana
      // say about the renewal" is a question about a person first.
      like(sql`lower(coalesce(${arrivals.senderName}, ''))`, `%${term}%`),
      like(sql`lower(coalesce(${arrivals.senderAddress}, ''))`, `%${term}%`),
    ]);

    const rows = db
      .select()
      .from(arrivals)
      .where(or(...clauses))
      .orderBy(
        desc(sql`coalesce(${arrivals.occurredAt}, ${arrivals.createdAt})`),
      )
      .limit(normalizedLimit * 4)
      .all();

    const evidence: RecallEvidence[] = rows
      .map((row) => {
        const sender = row.senderName ?? row.senderAddress ?? "unknown sender";
        const haystack = `${row.title}\n${row.snippet ?? ""}\n${sender}`;
        return {
          id: `email:${row.id}`,
          source: "email" as const,
          // The sender belongs in the title: a citation reading "Re: renewal
          // terms" tells you nothing you can weigh, and "Dana Whitman — Re:
          // renewal terms" tells you whose claim it is.
          title: `${sender} — ${row.title}`,
          locator: `arrivals/${row.id}`,
          excerpt: clip(row.snippet ?? row.title, EXCERPT_MAX_CHARS),
          // When it was SENT where the provider told us, not when Cue saw it.
          timestampMs: row.occurredAt ?? row.createdAt,
          score: scoreNote(haystack, terms),
          metadata: {
            channel: row.channel,
            senderAddress: row.senderAddress,
            // `filed` here is not a reason to distrust the evidence — it is a
            // record of what Cue decided about interrupting you, which is a
            // different question from whether the mail is relevant now.
            disposition: row.disposition,
          },
        };
      })
      .filter((item) => (item.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, normalizedLimit);

    return { evidence };
  } catch (err) {
    log.warn({ err }, "email recall failed; degrading to other sources");
    return { evidence: [] };
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
