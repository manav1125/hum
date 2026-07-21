/**
 * Plugin registry search — the plugin analogue of `skill_search`.
 *
 * Cheap, deterministic keyword search across (a) the curated, pinned registry
 * entries in `plugins/registry.json` and (b) already-indexed manifests from the
 * allowlisted sources (on-disk cache only — never a network fetch). Ranking is
 * token-overlap against name/description/source, exactly like `skill_search`,
 * so `plugins search` behaves identically to skill discovery.
 *
 * The SAME embedding space is available too: `embedding-seed.ts` upserts these
 * items into the shared `memory_v2_concept_pages` collection under a `plugins/`
 * slug, so semantic per-turn retrieval ranks them alongside skills. This module
 * is the deterministic fallback (and the CLI backend); the embedding seed is the
 * semantic path. Both read the same `listCachedPluginItems()` source.
 */

import { listCachedPluginItems } from "./indexer.js";
import { loadRegistryPlugins } from "./registry-file.js";
import { type PluginReviewStatus, REVIEW_STATUS_RANK } from "./types.js";

export type PluginAvailability = "curated" | "indexed";

export interface PluginSearchCandidate {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: string;
  sourceLabel?: string;
  reviewStatus: PluginReviewStatus;
  availability: PluginAvailability;
  surfaces: string[];
}

const NAME_WEIGHT = 3;
const SURFACE_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

/** Prefer curated over indexed on score ties. */
const AVAILABILITY_RANK: Record<PluginAvailability, number> = {
  curated: 0,
  indexed: 1,
};

/** Function words stripped from QUERY tokens only. Mirrors skill_search. */
const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "is",
  "are",
  "was",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "how",
  "what",
  "when",
  "which",
  "who",
  "need",
  "want",
  "please",
  "use",
  "using",
  "plugin",
  "plugins",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Match strength: 1 exact, 0.5 near-prefix, 0 otherwise. Mirrors skill_search. */
function isNearPrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return (
    shorter.length >= 4 &&
    longer.length - shorter.length <= 4 &&
    longer.startsWith(shorter)
  );
}

function tokenMatchStrength(
  queryToken: string,
  fieldTokens: readonly string[],
): number {
  let best = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === queryToken) return 1;
    if (isNearPrefixMatch(queryToken, fieldToken)) best = 0.5;
  }
  return best;
}

export function scorePluginCandidate(
  candidate: PluginSearchCandidate,
  queryTokens: readonly string[],
): number {
  const nameTokens = tokenize(`${candidate.name} ${candidate.displayName}`);
  const surfaceTokens = tokenize(candidate.surfaces.join(" "));
  const descriptionTokens = tokenize(candidate.description);

  let score = 0;
  for (const queryToken of new Set(queryTokens)) {
    score += Math.max(
      NAME_WEIGHT * tokenMatchStrength(queryToken, nameTokens),
      SURFACE_WEIGHT * tokenMatchStrength(queryToken, surfaceTokens),
      DESCRIPTION_WEIGHT * tokenMatchStrength(queryToken, descriptionTokens),
    );
  }
  return score;
}

export interface RankedPluginResult {
  candidate: PluginSearchCandidate;
  score: number;
}

export function rankPluginCandidates(
  candidates: readonly PluginSearchCandidate[],
  query: string,
  limit: number,
): RankedPluginResult[] {
  const queryTokens = tokenize(query).filter((t) => !QUERY_STOPWORDS.has(t));
  if (queryTokens.length === 0) return [];

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scorePluginCandidate(candidate, queryTokens),
    }))
    .filter((result) => result.score > 0);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      REVIEW_STATUS_RANK[a.candidate.reviewStatus] -
        REVIEW_STATUS_RANK[b.candidate.reviewStatus] ||
      AVAILABILITY_RANK[a.candidate.availability] -
        AVAILABILITY_RANK[b.candidate.availability] ||
      a.candidate.name.localeCompare(b.candidate.name),
  );

  return scored.slice(0, limit);
}

/**
 * Merge curated registry entries (always available, even offline) with the
 * already-indexed manifests. Curated entries win an id collision — they carry
 * a reviewed pin and richer metadata. `includeUnreviewed` gates raw indexed
 * `unreviewed` items (curated/community indexed items always pass).
 */
export function collectPluginCandidates(options?: {
  includeUnreviewed?: boolean;
}): PluginSearchCandidate[] {
  const includeUnreviewed = options?.includeUnreviewed ?? false;
  const byKey = new Map<string, PluginSearchCandidate>();

  for (const entry of loadRegistryPlugins()) {
    byKey.set(entry.name, {
      id: entry.name,
      name: entry.name,
      displayName: entry.name,
      description: entry.description,
      source: entry.source.repo,
      reviewStatus: entry.reviewStatus,
      availability: "curated",
      surfaces: entry.surfaces ?? [],
    });
  }

  for (const item of listCachedPluginItems()) {
    if (byKey.has(item.name)) continue; // curated wins
    if (item.reviewStatus === "unreviewed" && !includeUnreviewed) continue;
    byKey.set(item.name, {
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      description: item.description,
      source: item.source,
      sourceLabel: item.sourceLabel,
      reviewStatus: item.reviewStatus,
      availability: "indexed",
      surfaces: item.surfaces,
    });
  }

  return [...byKey.values()];
}

/** Search the plugin registry. Deterministic keyword ranking. */
export function searchPluginRegistry(
  query: string,
  options?: { limit?: number; includeUnreviewed?: boolean },
): RankedPluginResult[] {
  const limit = Math.max(1, Math.min(options?.limit ?? 8, 25));
  const candidates = collectPluginCandidates({
    includeUnreviewed: options?.includeUnreviewed,
  });
  return rankPluginCandidates(candidates, query, limit);
}
