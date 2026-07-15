// ---------------------------------------------------------------------------
// Memory v2 — Skill catalog → embedded skill entries
// ---------------------------------------------------------------------------
//
// Enumerate the enabled-skill catalog AND uninstalled catalog skills, render
// each skill's prose statement via `buildSkillContents` (a short injected
// form plus a rich embedded form), embed dense + sparse from the rich form,
// and upsert into `memory_v2_concept_pages` under the slug `skills/<id>`.
// Including uninstalled catalog skills ensures their activation hints are
// discoverable by intent so the model can auto-install them. Third-party
// marketplace skills already present in the local marketplace index caches
// are additionally seeded under `skills/marketplace/<id>` so they are
// discoverable in the same embedding space — labeled not-installed so the
// renderer directs the model to ask the user to install them.
//
// Skills share the concept-page collection rather than living in a dedicated
// one so the per-turn activation pipeline scores them against the same
// candidate ANN as concept pages, with the same decay and spread machinery.
// The render path branches on the `skills/` slug prefix to surface them as
// the `### Skills You Can Use` subsection.
//
// Skill entries are kept in a small in-process cache so the render path can
// fetch a `SkillEntry` synchronously by id without round-tripping to Qdrant.
// The cache is replaced atomically at the end of a successful seed run; on
// error the prior cache stays intact (skills are best-effort).

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { getCatalog } from "../../skills/catalog-cache.js";
import { isMarketplaceEnabled } from "../../skills/marketplace/flag.js";
import { listCachedMarketplaceItems } from "../../skills/marketplace/indexer.js";
import {
  fromCatalogSkill,
  fromSkillSummary,
} from "../../skills/skill-memory.js";
import { getLogger } from "../../util/logger.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import { invalidatePageIndex } from "./page-index.js";
import {
  backfillKindOnPointsWithPrefix,
  pruneSlugsWithPrefixExcept,
  upsertConceptPageEmbedding,
} from "./qdrant.js";
import {
  augmentMcpSetupDescription,
  buildMarketplaceSkillContents,
  buildSkillContents,
} from "./skill-content.js";
import {
  generateBm25DocEmbedding,
  getConceptPageCorpusStats,
} from "./sparse-bm25.js";
import type { SkillEntry } from "./types.js";

const log = getLogger("memory-v2-skill-store");

/**
 * Slug prefix under which skill embeddings are indexed in
 * `memory_v2_concept_pages`. Concept-page slugs must match
 * `[a-z0-9][a-z0-9-]*(/...)*`, and `skills` matches that pattern, so the
 * prefix coexists with hand-authored concept pages without escape work.
 */
export const SKILL_SLUG_PREFIX = "skills/";

/**
 * Payload discriminator written on every skill-seeded Qdrant point. Keeps
 * skill rows distinguishable from user-authored concept pages that happen to
 * be slugged under `skills/...`, so prefix pruning never deletes a hand-
 * authored page sitting in the same namespace.
 */
const SKILL_PAYLOAD_KIND = "skill";

/** Compose the unified-collection slug for a skill id. */
export function skillSlugFor(id: string): string {
  return `${SKILL_SLUG_PREFIX}${id}`;
}

/**
 * Slug prefix for third-party marketplace skills (not installed, discoverable
 * via the marketplace UI). Nested under `skills/` so the injection router's
 * `isSkillSlug` branch still claims them; the extra segment lets the renderer
 * (and anything reading raw slugs) tell a marketplace listing apart from a
 * loadable skill.
 */
export const MARKETPLACE_SKILL_SLUG_PREFIX = `${SKILL_SLUG_PREFIX}marketplace/`;

/** True iff the slug refers to a third-party marketplace skill entry. */
export function isMarketplaceSkillSlug(slug: string): boolean {
  return slug.startsWith(MARKETPLACE_SKILL_SLUG_PREFIX);
}

/**
 * Compose the `skills/`-relative slug suffix for a marketplace item id.
 * Marketplace ids (`{owner}--{repo}--{skillName}`) may carry uppercase, dots,
 * or underscores from repo/folder names; concept-page slugs are constrained
 * to `[a-z0-9][a-z0-9-]*(/...)*`, so the id is lowercased and disallowed
 * runs collapse to `-`. Returns `null` when nothing slug-safe remains.
 */
function marketplaceSlugSuffixFor(itemId: string): string | null {
  const slugified = itemId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slugified) return null;
  return `marketplace/${slugified}`;
}

/**
 * Module-level cache of rendered skill entries keyed by skill id. `null` until
 * the first successful seed run completes; replaced atomically on each
 * successful re-seed so callers always see a consistent snapshot.
 */
let entries: Map<string, SkillEntry> | null = null;
let requestedSeedGeneration = 0;
let processedSeedGeneration = 0;
let activeSeedDrain: Promise<void> | null = null;
let lastSeedError: unknown = null;
const seedWaiters: Array<{ generation: number; resolve: () => void }> = [];

/**
 * Seed (or re-seed) skill embeddings into the unified concept-page collection.
 * Idempotent. Defaults to best-effort (errors are logged but swallowed) for
 * background callers like daemon startup; pass `{ throwOnError: true }` from
 * synchronous CLI-driven paths that need to surface failures to the operator.
 *
 * Single-flight + coalesced: at most one seed runs at a time. Requests made
 * while a seed is in flight advance the requested generation; stale in-flight
 * snapshots are skipped before they write embeddings or replace the cache,
 * then the drain loop immediately processes the latest generation. Strict
 * callers observe the awaited generation's latest outcome via `lastSeedError`.
 */

/**
 * In-process latch for the legacy `kind` backfill (see
 * {@link backfillKindOnPointsWithPrefix}). New upserts always write `kind`,
 * so once the latch is set there is no follow-up work to do this process.
 */
let legacyKindBackfillDone = false;

/**
 * Steps (per run):
 *   1. Enumerate the local skill catalog and resolve each skill's enabled
 *      state (`resolveSkillStates`).
 *   2. Build a `SkillEntry` per enabled skill, applying the mcp-setup
 *      augmentation and the prose-style content render (`buildSkillContents`:
 *      a short injected form capped at 500 chars plus a rich embedded form
 *      capped at 1500 chars carrying the full hint lists).
 *   3. Defense-in-depth feature-flag filter: drop any skill whose declared
 *      `metadata.vellum.feature-flag` is currently disabled.
 *   3b. Fetch the full remote catalog and seed any uninstalled skills so
 *      their activation hints are discoverable by semantic search. Best-effort:
 *      if the catalog fetch fails, only installed skills are seeded.
 *   3c. Enumerate third-party skills from the on-disk marketplace index
 *      caches (no network) and seed them under `skills/marketplace/<id>`,
 *      flagged `marketplace: true` and worded as not-installed. Skipped when
 *      the marketplace is disabled or nothing has been indexed locally.
 *   4. Embed all `embeddingContent` strings in a single dense
 *      `embedWithBackend` call, and a per-skill synchronous sparse encode of
 *      the same rich form.
 *   5. Upsert one Qdrant point per skill via `upsertConceptPageEmbedding`
 *      keyed deterministically on slug `skills/<id>`.
 *   6. Call `pruneSlugsWithPrefixExcept(SKILL_SLUG_PREFIX, ...)` to drop any
 *      stale points from prior catalog state (e.g. uninstalled skills).
 *   7. Replace the module-level `entries` cache with the freshly built map.
 */
export async function seedV2SkillEntries(
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  const generation = ++requestedSeedGeneration;
  const waiter = new Promise<void>((resolve) => {
    seedWaiters.push({ generation, resolve });
  });
  startSeedDrainIfNeeded();
  await waiter;
  if (opts.throwOnError && lastSeedError) {
    throw lastSeedError;
  }
}

function startSeedDrainIfNeeded(): void {
  if (activeSeedDrain) return;
  if (processedSeedGeneration >= requestedSeedGeneration) return;

  activeSeedDrain = drainSeedQueue().finally(() => {
    activeSeedDrain = null;
    startSeedDrainIfNeeded();
  });
}

async function drainSeedQueue(): Promise<void> {
  while (processedSeedGeneration < requestedSeedGeneration) {
    const generationToProcess = requestedSeedGeneration;
    await runSeedV2SkillEntries(generationToProcess);
    processedSeedGeneration = generationToProcess;
    resolveSeedWaiters();
  }
}

function resolveSeedWaiters(): void {
  for (let i = seedWaiters.length - 1; i >= 0; i -= 1) {
    const waiter = seedWaiters[i]!;
    if (waiter.generation > processedSeedGeneration) continue;
    seedWaiters.splice(i, 1);
    waiter.resolve();
  }
}

async function runSeedV2SkillEntries(generation: number): Promise<void> {
  try {
    const config = getConfig();
    const catalog = loadSkillCatalog();
    const resolved = resolveSkillStates(catalog, config);
    const enabled = resolved.filter((r) => r.state === "enabled");

    // Track every locally-installed skill id (regardless of enabled/disabled
    // state) so the catalog-seeding loop below treats them all as "installed"
    // and never re-seeds a disabled skill from `getCatalog()` as if it were
    // uninstalled.
    const installedIds = new Set<string>(catalog.map((s) => s.id));

    // Build the input list, applying the mcp-setup description augmentation
    // and the defense-in-depth feature-flag filter.
    const seeds: SkillEntry[] = [];
    for (const { summary } of enabled) {
      const flagKey = summary.featureFlag;
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) continue;

      const augmented = augmentMcpSetupDescription(fromSkillSummary(summary));
      seeds.push({ id: summary.id, ...buildSkillContents(augmented) });
    }

    // Seed uninstalled catalog skills so their activation hints are
    // discoverable by intent. Track whether the catalog was available so we
    // can guard pruning below.
    //
    // Build the legacy-backfill allowlist in parallel: every locally
    // installed skill id (regardless of enabled state) plus every remote
    // catalog id. Restricting the backfill to this set keeps user-authored
    // concept pages that happen to live under `skills/<slug>` from being
    // mis-tagged and then pruned. See `backfillKindOnPointsWithPrefix`.
    const knownSkillIds = new Set<string>(installedIds);
    let catalogAvailable = false;
    try {
      const fullCatalog = await getCatalog();
      catalogAvailable = fullCatalog.length > 0;
      for (const entry of fullCatalog) {
        knownSkillIds.add(entry.id);
        if (installedIds.has(entry.id)) continue;
        const flagKey = entry.metadata?.vellum?.["feature-flag"];
        if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config))
          continue;
        seeds.push({
          id: entry.id,
          ...buildSkillContents(fromCatalogSkill(entry)),
        });
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to fetch catalog for uninstalled skill seeding — continuing with installed skills only",
      );
    }

    // Seed already-indexed third-party marketplace skills under
    // `skills/marketplace/<id>` so they are discoverable in the same
    // embedding space. Reads only the on-disk marketplace index caches —
    // never the network — so a machine that has never opened the marketplace
    // seeds nothing here. Items whose id matches an installed skill (a
    // marketplace install lands in the managed dir under the same namespaced
    // id) or a first-party catalog skill are skipped: those are already
    // seeded above as loadable skills. Best-effort: a failure here must not
    // block seeding of the loadable skills.
    try {
      if (isMarketplaceEnabled()) {
        const seenSuffixes = new Set(seeds.map((s) => s.id));
        for (const item of listCachedMarketplaceItems()) {
          if (knownSkillIds.has(item.id)) continue;
          const suffix = marketplaceSlugSuffixFor(item.id);
          if (!suffix || seenSuffixes.has(suffix)) continue;
          seenSuffixes.add(suffix);
          seeds.push({
            id: suffix,
            ...buildMarketplaceSkillContents({
              id: item.id,
              displayName: item.displayName,
              description: item.description,
              sourceLabel: item.sourceLabel,
            }),
            marketplace: true,
          });
        }
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to enumerate cached marketplace skills for seeding — continuing without marketplace entries",
      );
    }

    // Embed all content strings in one batched call when there is anything to
    // embed. Skipping the call when `seeds` is empty avoids throwing on an
    // unavailable embedding backend in the all-disabled case, so pruning and
    // cache replacement still run and clear stale state.
    const nextEntries = new Map<string, SkillEntry>();
    let denseVectors: number[][] = [];
    let encodeSparse: (
      input: string,
    ) => ReturnType<typeof generateSparseEmbedding> = generateSparseEmbedding;
    if (seeds.length > 0) {
      // Embed the RICH form (`embeddingContent`) so full activation-hint and
      // avoid-when lists carry semantic weight at retrieval time; the short
      // `content` form is what injection renders. See `buildSkillContents`.
      const embedded = await embedWithBackend(
        config,
        seeds.map((s) => s.embeddingContent ?? s.content),
      );
      denseVectors = await Promise.all(
        embedded.vectors.map((v) =>
          applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
        ),
      );

      // Skills share the concept-page Qdrant collection, so the sparse vector
      // must use the same stemmed BM25 encoding the concept-page documents
      // carry — otherwise the stemmed BM25 query vectors used by callers (see
      // `simBatch`, `activation.selectCandidates`, recall) hash to different
      // buckets than the stored skill vectors and skip the sparse channel
      // entirely. Fall back to the legacy TF encoder only during the cold-start
      // window before corpus stats finish building.
      const corpusStats = getConceptPageCorpusStats();
      encodeSparse = (input: string) =>
        corpusStats
          ? generateBm25DocEmbedding(input, corpusStats, {
              k1: config.memory.v2.bm25_k1,
              b: config.memory.v2.bm25_b,
            })
          : generateSparseEmbedding(input);
    }

    if (generation !== requestedSeedGeneration) {
      log.info(
        { generation, latestGeneration: requestedSeedGeneration },
        "Skipping stale v2 skill seed result",
      );
      lastSeedError = null;
      return;
    }

    if (seeds.length > 0) {
      const now = Date.now();
      await Promise.all(
        seeds.map((seed, i) =>
          upsertConceptPageEmbedding({
            slug: skillSlugFor(seed.id),
            dense: denseVectors[i],
            sparse: encodeSparse(seed.embeddingContent ?? seed.content),
            updatedAt: now,
            kind: SKILL_PAYLOAD_KIND,
          }),
        ),
      );
      for (const seed of seeds) {
        nextEntries.set(seed.id, seed);
      }
    }

    // Prune stale skill slugs. When the catalog is unavailable (empty array
    // from network failure or cold cache), we cannot enumerate which
    // uninstalled catalog skills should exist, so skip pruning entirely to
    // avoid aggressively removing previously-seeded catalog skill embeddings.
    if (catalogAvailable) {
      // Tag legacy skill points missing `payload.kind` before pruning so the
      // kind-scoped prune can see them. Once-per-process; the backfill is
      // idempotent (server-side `is_empty` filter), so a partial failure
      // converges on retry.
      if (!legacyKindBackfillDone) {
        try {
          await backfillKindOnPointsWithPrefix(
            SKILL_SLUG_PREFIX,
            SKILL_PAYLOAD_KIND,
            knownSkillIds,
          );
          legacyKindBackfillDone = true;
        } catch (err) {
          log.warn(
            { err },
            "Failed to backfill kind on legacy skill points — pruning may leave orphans this run",
          );
        }
      }
      await pruneSlugsWithPrefixExcept(
        SKILL_SLUG_PREFIX,
        seeds.map((s) => s.id),
        { kind: SKILL_PAYLOAD_KIND },
      );
    } else {
      log.info(
        "Catalog unavailable — skipping skill pruning to preserve prior catalog embeddings",
      );
    }

    // Atomically replace the cache only after every step above succeeds.
    entries = nextEntries;
    // Drop the page-index cache so the next router invocation observes the
    // freshly seeded skill set (skill entries share the unified concept-page
    // collection and surface in the same index).
    invalidatePageIndex();
    lastSeedError = null;
  } catch (err) {
    lastSeedError = err;
    log.warn({ err }, "Failed to seed v2 skill entries");
  }
}

/**
 * Synchronous lookup of a previously-seeded `SkillEntry` by skill id. Returns
 * `null` when the cache has not yet been populated, when the id is unknown,
 * or when a prior seed run dropped the id (e.g. the skill was disabled).
 *
 * Accepts either a bare skill id (`example-skill`) or its unified-collection
 * slug (`skills/example-skill`) so render-side callers can pass through what
 * they have without a manual prefix strip.
 *
 * Returns a frozen copy so callers cannot mutate the underlying cache entry
 * — matches the defensive-copy contract of `listSkillEntries`.
 */
export function getSkillCapability(idOrSlug: string): SkillEntry | null {
  const id = idOrSlug.startsWith(SKILL_SLUG_PREFIX)
    ? idOrSlug.slice(SKILL_SLUG_PREFIX.length)
    : idOrSlug;
  const entry = entries?.get(id);
  return entry ? Object.freeze({ ...entry }) : null;
}

/** True iff the slug refers to a skill entry in the unified collection. */
export function isSkillSlug(slug: string): boolean {
  return slug.startsWith(SKILL_SLUG_PREFIX);
}

/**
 * Snapshot of the in-process skill cache, sorted by skill id (ASCII order)
 * for determinism. Returns a freshly allocated array of frozen entry copies
 * on each call, so callers cannot mutate the underlying cache — neither by
 * reassigning the array nor by writing through entry fields.
 *
 * The cache is replaced atomically by `seedV2SkillEntries`, so a snapshot
 * may be stale once a subsequent seed run completes. Callers that need
 * up-to-the-moment state must re-call this after awaiting the seed.
 */
export function listSkillEntries(): SkillEntry[] {
  if (!entries) return [];
  return [...entries.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => Object.freeze({ ...entry }));
}

/** @internal Test-only: clear the module-level cache. */
export function _resetSkillStoreForTests(): void {
  entries = null;
  requestedSeedGeneration = 0;
  processedSeedGeneration = 0;
  activeSeedDrain = null;
  seedWaiters.splice(0, seedWaiters.length);
  lastSeedError = null;
  legacyKindBackfillDone = false;
}
