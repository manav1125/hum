/**
 * Plugin registry — shared types.
 *
 * The plugin registry is the plugin-side analogue of the skills marketplace
 * (`src/skills/marketplace/`). It is a curated, commit-pinned, security-
 * reviewed allowlist of GitHub repos/orgs whose plugin manifests
 * (`package.json` declaring an `@vellumai/plugin-api` peerDependency) are
 * indexed into the SAME embedding space as skills so that `plugins search`
 * works like `skill_search`.
 *
 * Two concepts live in `plugins/registry.json`:
 *
 * - **sources** — the GitHub repos/orgs the indexer crawls for plugin
 *   manifests. Analogous to the skills marketplace `marketplace-sources.json`.
 * - **plugins** — the reviewed, pinned catalog entries surfaced by default.
 *   Each references a source repo (+ optional subpath) at a specific commit.
 *
 * Nothing here installs code. Installation stays in the existing
 * `cli/lib/install-from-github.ts` path; the registry is the discovery +
 * curation + pinning layer that feeds it.
 */

// ─── Review status ───────────────────────────────────────────────────────────

/**
 * How much scrutiny an entry has had. Ordered from most to least trusted.
 * `unreviewed` entries are only surfaced when the caller opts in.
 */
export type PluginReviewStatus = "curated" | "community" | "unreviewed";

export const REVIEW_STATUS_RANK: Record<PluginReviewStatus, number> = {
  curated: 0,
  community: 1,
  unreviewed: 2,
};

// ─── Sources ─────────────────────────────────────────────────────────────────

/** A GitHub repo the indexer crawls for plugin manifests. */
export interface PluginRegistrySource {
  /** `owner/repo`. */
  address: string;
  kind: "github";
  /** Human label shown on cards/chips. Defaults to the address. */
  label?: string;
  /** Git ref (branch/tag). Defaults to the repo's default branch. */
  ref?: string;
  enabled: boolean;
  /** Seeded by Cue — protected from deletion (can still be disabled). */
  builtIn?: boolean;
  /** Review posture inherited by manifests discovered under this source. */
  reviewStatus?: PluginReviewStatus;
  /** SPDX id noted at add/seed time (e.g. "MIT", "Apache-2.0"). */
  license?: string;
}

// ─── Pinned catalog entries ──────────────────────────────────────────────────

/** Where a curated plugin's code lives (mirrors the marketplace.json shape). */
export interface PluginSourceRef {
  source: "github";
  /** `owner/repo`. */
  repo: string;
  /** Pinned commit SHA (preferred) or branch/tag. */
  ref: string;
  /** Repo-relative subpath when the plugin is not at the repo root. */
  path?: string;
}

/** A curated, reviewed, commit-pinned plugin the registry surfaces by default. */
export interface PluginRegistryEntry {
  /** Install name (the workspace `plugins/<name>/` directory basename). */
  name: string;
  source: PluginSourceRef;
  description: string;
  category?: string;
  homepage?: string;
  license?: string;
  reviewStatus: PluginReviewStatus;
  icon?: string;
  /** Which plugin surfaces the manifest contributes (hooks/tools/skills/routes/apps). */
  surfaces?: string[];
}

/** Parsed shape of `plugins/registry.json`. */
export interface PluginRegistryFile {
  version: 1;
  name?: string;
  owner?: { name?: string; url?: string };
  sources: PluginRegistrySource[];
  plugins: PluginRegistryEntry[];
}

// ─── Indexed items ───────────────────────────────────────────────────────────

/**
 * A plugin manifest discovered in a source repo and normalized for search.
 * The plugin analogue of the skills `MarketplaceItem`.
 */
export interface PluginIndexItem {
  /** Namespaced id: `{owner}--{repo}--{pluginName}`. */
  id: string;
  /** Manifest `name` (the install directory basename authors intend). */
  name: string;
  displayName: string;
  description: string;
  /** Source address (`owner/repo`). */
  source: string;
  sourceLabel: string;
  /** Repo-relative directory of the manifest ("" = repo root). */
  pluginPath: string;
  /** Resolved git ref the index was built from (branch/commit). */
  ref: string;
  /** Browsable URL of the plugin folder. */
  url?: string;
  /** Declared peer range for `@vellumai/plugin-api`. */
  apiRange?: string;
  /** Manifest `version`. */
  version?: string;
  license?: string;
  reviewStatus: PluginReviewStatus;
  /** Surfaces inferred from the manifest / declared in registry.json. */
  surfaces: string[];
  /** Git blob sha of package.json — cheap change detection. */
  manifestSha?: string;
}

/** A per-source on-disk index cache. */
export interface PluginSourceIndex {
  address: string;
  ref: string;
  /** Epoch ms when this index was built. */
  fetchedAt: number;
  /** ETag of the git tree response (conditional re-fetch). */
  treeEtag?: string;
  treeSha?: string;
  truncated?: boolean;
  items: PluginIndexItem[];
}
