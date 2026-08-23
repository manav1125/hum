/**
 * When a note contradicts something Cue already believes.
 *
 * This is the only place in Notes where accepting a proposal can **destroy**
 * rather than add: a memory that says "they'll approve at $47" lands on top
 * of one that says "Acme's ceiling is $52 a seat", and silently replacing the
 * old value is how an assistant becomes confidently wrong. So a contradicted
 * proposal carries the disagreement with it, the rail shows both values with
 * where each came from, and the owner gets **three** answers:
 *
 *   · replace   — the old value was wrong, or is now stale
 *   · keep both — the default. Prices and dates legitimately change; Cue
 *                 keeps the history and uses the newer one
 *   · ignore    — don't record this at all
 *
 * A two-button version forces a false choice between the old truth and the
 * new one, which is exactly the situation where a person needs a third door.
 *
 * ## Why this is deterministic
 *
 * Detection reads concept pages and compares values with no embedding call
 * and no model call. Extraction already costs a model call per changed note;
 * spending a second one to ask "do these disagree?" would double the price of
 * the feature's most frequent operation, and the disagreements worth catching
 * — a different price, a different date, a different name for the same
 * subject — are exactly the ones a comparison can see.
 *
 * The trade is stated plainly: this finds contradictions that share a
 * subject and differ in a **value**. It does not find semantic reversals
 * ("they're keen" vs "they've gone cold"). Those pass through as ordinary
 * memory proposals, which is a miss, not a wrong answer — and a miss here
 * costs an accepted duplicate rather than a destroyed fact.
 */

import {
  getConceptsDir,
  listPages,
  readPage,
} from "../memory/v2/page-store.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import type { ExtractedItem } from "./note-extraction.js";
import type { NoteConflict } from "./note-store.js";

const log = getLogger("note-conflict");

/** Never scan more than this many pages for one proposal. */
const MAX_PAGES_SCANNED = 400;

/** A subject term shorter than this carries no discriminating power. */
const MIN_TERM_LENGTH = 4;

/** How many subject terms a page must share before it is a candidate. */
const MIN_SHARED_TERMS = 2;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "against",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "could",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "from",
  "further",
  "have",
  "having",
  "here",
  "into",
  "just",
  "more",
  "most",
  "once",
  "only",
  "other",
  "over",
  "same",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
]);

/**
 * Salient words in a claim: the ones that say what it is ABOUT. Numbers and
 * dates are deliberately excluded here — they are the values being compared,
 * so counting them as subject terms would make two different prices look like
 * a stronger subject match than they are.
 */
export function subjectTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < MIN_TERM_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    terms.add(word);
  }
  return terms;
}

/**
 * The kinds of value a claim can carry. Kept apart because **a disagreement
 * requires the same kind of claim, not merely the same subject**: "Acme wants
 * a 24-month term" and "Acme has 30 people" share a subject and both carry
 * numbers, yet they contradict nothing. Comparing them raises a conflict
 * screen on two unrelated sentences — and a conflict screen people learn to
 * click through is worse than no conflict screen at all.
 */
export type ValueClass = "money" | "percent" | "duration" | "number";

/**
 * Ordered most-specific first, and each pattern consumes the text it matches
 * so "$47" is money and never also the bare number 47. Without the masking,
 * every price would be two values in two classes and the class comparison
 * below would be meaningless.
 */
const VALUE_PATTERNS: readonly (readonly [ValueClass, RegExp])[] = [
  ["money", /[$£€]\s?\d[\d,]*(?:\.\d+)?/g],
  ["percent", /\b\d+(?:\.\d+)?\s?%/g],
  ["duration", /\b\d+\s?-?\s?(?:month|week|day|year|hour)s?\b/gi],
  ["number", /\b\d[\d,]*(?:\.\d+)?\b/g],
];

/** Comparable values in a claim, grouped by what kind of value they are. */
export function classifiedValues(text: string): Map<ValueClass, Set<string>> {
  let working = text;
  const out = new Map<ValueClass, Set<string>>();
  for (const [valueClass, pattern] of VALUE_PATTERNS) {
    const found = new Set<string>();
    working = working.replace(
      new RegExp(pattern.source, pattern.flags),
      (match) => {
        found.add(match.toLowerCase().replace(/\s+/g, ""));
        return " ".repeat(match.length);
      },
    );
    if (found.size > 0) out.set(valueClass, found);
  }
  return out;
}

/** Every comparable value in a claim, flattened. */
export function claimValues(text: string): Set<string> {
  const flat = new Set<string>();
  for (const values of classifiedValues(text).values()) {
    for (const value of values) flat.add(value);
  }
  return flat;
}

/**
 * Do these two claims disagree? True only when they make the same KIND of
 * claim and give it different values — the shape of a real contradiction.
 */
function disagrees(
  incoming: Map<ValueClass, Set<string>>,
  existing: Map<ValueClass, Set<string>>,
): boolean {
  for (const [valueClass, incomingValues] of incoming) {
    const existingValues = existing.get(valueClass);
    if (!existingValues || existingValues.size === 0) continue;
    if (overlapCount(incomingValues, existingValues) === 0) return true;
  }
  return false;
}

/** Split a page body into the individual sentences a claim could live in. */
function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const term of a) if (b.has(term)) n += 1;
  return n;
}

/**
 * Find the sentence in memory that disagrees with `claim`, if there is one.
 *
 * A disagreement requires BOTH:
 *   · enough shared subject terms that the two are about the same thing, and
 *   · the same KIND of value on both sides, with different values in it.
 *
 * The second condition is what stops "Acme wants a 24-month term" from
 * "contradicting" "Acme has 30 people" — they share a subject and both carry
 * numbers, but a duration and a headcount are not the same claim. Requiring
 * the incoming claim to carry a value at all is also why a purely qualitative
 * memory ("they seem keen") never raises this screen.
 */
export async function findContradiction(
  claim: string,
): Promise<{ text: string; source: string; at: number | null } | null> {
  const incomingValues = classifiedValues(claim);
  if (incomingValues.size === 0) return null;

  const incomingTerms = subjectTerms(claim);
  if (incomingTerms.size < MIN_SHARED_TERMS) return null;

  const workspaceDir = getWorkspaceDir();
  let slugs: string[];
  try {
    slugs = await listPages(workspaceDir);
  } catch (err) {
    // No memory corpus yet, or an unreadable one. A conflict check that
    // cannot read memory reports "no conflict", never an error: failing to
    // find a contradiction must never block a proposal from being made.
    log.debug({ err: String(err) }, "conflict scan could not list pages");
    return null;
  }

  for (const slug of slugs.slice(0, MAX_PAGES_SCANNED)) {
    let page;
    try {
      page = await readPage(workspaceDir, slug);
    } catch {
      continue;
    }
    if (!page) continue;

    for (const sentence of sentences(page.body)) {
      const sharedTerms = overlapCount(incomingTerms, subjectTerms(sentence));
      if (sharedTerms < MIN_SHARED_TERMS) continue;

      if (!disagrees(incomingValues, classifiedValues(sentence))) continue;

      return {
        text: sentence,
        source: `memory · ${slug}`,
        at: await pageTimeMs(workspaceDir, slug),
      };
    }
  }
  return null;
}

/** A page's last-write time, used as "when Cue learned this". */
async function pageTimeMs(
  workspaceDir: string,
  slug: string,
): Promise<number | null> {
  try {
    const { stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const info = await stat(join(getConceptsDir(workspaceDir), `${slug}.md`));
    return Math.floor(info.mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Attach a conflict to a memory proposal, if it disagrees with what Cue
 * already believes. Returns `null` for every other kind and for the ordinary
 * case where nothing disagrees.
 *
 * Never throws: a conflict check that fails degrades to "no conflict found",
 * so the proposal is still made. The failure mode that matters is the
 * opposite one — a conflict missed means a duplicate fact, while a proposal
 * blocked by a broken check means a thought lost.
 */
export async function attachConflict(
  item: ExtractedItem,
): Promise<NoteConflict | null> {
  if (item.kind !== "memory") return null;

  const detail =
    typeof item.payload.detail === "string" ? item.payload.detail : "";
  if (!detail) return null;

  try {
    const existing = await findContradiction(detail);
    if (!existing) return null;
    return {
      existing: existing.text,
      existingSource: existing.source,
      existingAt: existing.at,
      incoming: detail,
      incomingSource: "this note",
      incomingAt: Date.now(),
    };
  } catch (err) {
    log.debug({ err: String(err) }, "conflict check failed; proposing anyway");
    return null;
  }
}
