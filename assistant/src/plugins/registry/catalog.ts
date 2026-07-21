/**
 * Browse/search catalog projection over the curated plugin registry.
 *
 * `plugins/registry.json` (via {@link loadRegistryPlugins}) is the single
 * source of truth for the plugin *browse* surface: the HTTP list/search/detail
 * routes, the CLI `plugins search`, and the embedding seed all resolve against
 * it, so a card that appears in search always resolves on detail. This module
 * projects the curated, commit-pinned entries into the match shape the
 * `GET /v1/plugins/search` route serializes — the registry analogue of the
 * marketplace `PluginSearchMatch`, enriched with the curation metadata the
 * registry carries (reviewStatus, surfaces, category, icon, license, homepage).
 *
 * Only the curated + community (hand-reviewed) entries are surfaced here —
 * never the raw `unreviewed` manifests the indexer discovers from allowlisted
 * sources. `loadRegistryPlugins()` returns only the reviewed, pinned catalog,
 * so the HTTP browse surface never advertises an unreviewed plugin. Unreviewed
 * discovery stays CLI-gated (`plugins search --all`), preserving the security
 * posture that only curated names are installable by name over HTTP.
 */

import { loadRegistryPlugins } from "./registry-file.js";
import type { PluginRegistryEntry, PluginReviewStatus } from "./types.js";

/**
 * One curated catalog entry projected for the browse/search surface. Shares the
 * `name` / `path` / `description` / `source` core with the marketplace
 * `PluginSearchMatch`, and adds the curation metadata registry.json carries so
 * the UI's review chips + consent rows can render real data.
 */
export interface RegistryCatalogMatch {
  /** Install name — `plugins install <name>` resolves to this entry. */
  name: string;
  /** Human-readable origin: a `github:owner/repo[/path]@ref` locator (pinned commit). */
  path: string;
  /** Short description from the curated entry. */
  description: string;
  /** Pinned origin the detail view + installer resolve from. */
  source: { kind: "github"; repo: string; path?: string; ref: string };
  /** Curation posture: how much scrutiny the entry has had. */
  reviewStatus: PluginReviewStatus;
  /** Plugin surfaces (hooks/tools/skills/routes/apps); `[]` when the entry declares none. */
  surfaces: string[];
  /** Free-form grouping hint (e.g. `productivity`); `null` when absent. */
  category: string | null;
  /** SPDX license expression; `null` when absent. */
  license: string | null;
  /** Project homepage URL; `null` when absent. */
  homepage: string | null;
  /** Display emoji/icon; `null` when the entry ships none. */
  icon: string | null;
}

/** The full curated browse catalog, sorted alphabetically by install name. */
export function listRegistryCatalog(): RegistryCatalogMatch[] {
  return loadRegistryPlugins()
    .map(toCatalogMatch)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toCatalogMatch(entry: PluginRegistryEntry): RegistryCatalogMatch {
  const { repo, path, ref } = entry.source;
  return {
    name: entry.name,
    path: `github:${repo}${path ? `/${path}` : ""}@${ref}`,
    description: entry.description,
    source: {
      kind: "github",
      repo,
      ...(path ? { path } : {}),
      ref,
    },
    reviewStatus: entry.reviewStatus,
    surfaces: entry.surfaces ?? [],
    category: entry.category ?? null,
    license: entry.license ?? null,
    homepage: entry.homepage ?? null,
    icon: entry.icon ?? null,
  };
}
