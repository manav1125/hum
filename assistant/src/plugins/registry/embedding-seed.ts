/**
 * Plugin registry → shared embedding space.
 *
 * Upserts the curated + already-indexed plugin items into the SAME Qdrant
 * collection (`memory_v2_concept_pages`) that the skills marketplace uses, under
 * a `plugins/` slug prefix. This is what makes plugin discovery share the skill
 * embedding space: the per-turn hybrid retrieval (`hybridQueryConceptPages`)
 * scores plugin points against the same candidate ANN as skills, with the same
 * embedding model and sparse (BM25) channel.
 *
 * Design constraints:
 * - This module lives in the plugins territory and only *reads* the memory
 *   embedding backend + Qdrant helpers — it never modifies `src/memory`. Our
 *   memory subsystem stays put (we exclude upstream's memory-as-plugin move).
 * - The `plugins/` slug prefix is disjoint from the `skills/` prefix the
 *   skill-store seeds and prunes, so the two seeders never delete each other's
 *   points. Plugin points carry `kind: "plugin"` for the same reason.
 * - Best-effort: a missing/undialed embedding backend must not throw to the
 *   caller (the CLI reindex path). Returns a count so the caller can report.
 *
 * This is invoked explicitly (e.g. `plugins reindex --embed`), NOT wired into
 * daemon boot in this pass — surfacing plugin points in the injection renderer
 * (a memory-owned branch keyed on the slug prefix) is a follow-up, since we do
 * not modify `src/memory` here. Until that lands, seeded plugin points are
 * retrievable in the shared ANN but rendered generically.
 */

import { getConfig } from "../../config/loader.js";
import { applyCorrectionIfCalibrated } from "../../memory/anisotropy.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../../memory/embedding-backend.js";
import {
  pruneSlugsWithPrefixExcept,
  upsertConceptPageEmbedding,
} from "../../memory/v2/qdrant.js";
import {
  generateBm25DocEmbedding,
  getConceptPageCorpusStats,
} from "../../memory/v2/sparse-bm25.js";
import { getLogger } from "../../util/logger.js";
import { collectPluginCandidates } from "./search.js";

const log = getLogger("plugin-registry-embedding-seed");

/** Slug prefix under which plugin embeddings are indexed. */
export const PLUGIN_SLUG_PREFIX = "plugins/";

/** Payload discriminator so plugin points are prunable without touching skills. */
const PLUGIN_PAYLOAD_KIND = "plugin";

/** True iff the slug refers to a plugin registry entry in the unified collection. */
export function isPluginSlug(slug: string): boolean {
  return slug.startsWith(PLUGIN_SLUG_PREFIX);
}

/**
 * Compose a concept-page slug suffix for a plugin item id. Concept-page slugs
 * are constrained to `[a-z0-9][a-z0-9-]*(/...)*`; ids may carry uppercase, dots,
 * or `--` separators, so they are lowercased and disallowed runs collapse to
 * `-`. Returns null when nothing slug-safe remains.
 */
export function pluginSlugSuffixFor(id: string): string | null {
  const slugified = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugified || null;
}

/** The embeddable text for a plugin candidate (name + surfaces + description). */
export function buildPluginEmbeddingContent(candidate: {
  name: string;
  description: string;
  surfaces: string[];
  reviewStatus: string;
}): string {
  const surfaces =
    candidate.surfaces.length > 0
      ? ` Surfaces: ${candidate.surfaces.join(", ")}.`
      : "";
  return (
    `Plugin: ${candidate.name}. ${candidate.description}` +
    `${surfaces} (${candidate.reviewStatus} plugin — installable via \`cue plugins install ${candidate.name}\`.)`
  ).slice(0, 1500);
}

export interface PluginEmbedSeedResult {
  seeded: number;
  skipped: number;
}

/**
 * Seed plugin registry entries into the shared concept-page collection.
 * Best-effort: on an unavailable embedding backend, logs and returns
 * `{ seeded: 0, skipped: n }` rather than throwing.
 */
export async function seedPluginEmbeddings(options?: {
  includeUnreviewed?: boolean;
}): Promise<PluginEmbedSeedResult> {
  const candidates = collectPluginCandidates({
    includeUnreviewed: options?.includeUnreviewed,
  });
  if (candidates.length === 0) return { seeded: 0, skipped: 0 };

  const seeds: Array<{ suffix: string; content: string }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const suffix = pluginSlugSuffixFor(c.id);
    if (!suffix || seen.has(suffix)) continue;
    seen.add(suffix);
    seeds.push({ suffix, content: buildPluginEmbeddingContent(c) });
  }
  if (seeds.length === 0) return { seeded: 0, skipped: candidates.length };

  try {
    const config = getConfig();
    const embedded = await embedWithBackend(
      config,
      seeds.map((s) => s.content),
    );
    const denseVectors = await Promise.all(
      embedded.vectors.map((v) =>
        applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
      ),
    );

    // Use the same stemmed BM25 encoding the concept-page documents carry so
    // the sparse channel hashes to the same buckets as skill/page points.
    const corpusStats = getConceptPageCorpusStats();
    const encodeSparse = (input: string) =>
      corpusStats
        ? generateBm25DocEmbedding(input, corpusStats, {
            k1: config.memory.v2.bm25_k1,
            b: config.memory.v2.bm25_b,
          })
        : generateSparseEmbedding(input);

    const now = Date.now();
    await Promise.all(
      seeds.map((seed, i) =>
        upsertConceptPageEmbedding({
          slug: `${PLUGIN_SLUG_PREFIX}${seed.suffix}`,
          dense: denseVectors[i],
          sparse: encodeSparse(seed.content),
          updatedAt: now,
          kind: PLUGIN_PAYLOAD_KIND,
        }),
      ),
    );

    await pruneSlugsWithPrefixExcept(
      PLUGIN_SLUG_PREFIX,
      seeds.map((s) => s.suffix),
      { kind: PLUGIN_PAYLOAD_KIND },
    );

    return { seeded: seeds.length, skipped: candidates.length - seeds.length };
  } catch (err) {
    log.warn(
      { err },
      "Failed to seed plugin embeddings — embedding backend unavailable; discovery falls back to deterministic search",
    );
    return { seeded: 0, skipped: candidates.length };
  }
}
