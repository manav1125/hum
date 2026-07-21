/**
 * Plugin registry indexer — turns an allowlisted GitHub repo into a list of
 * discoverable plugin items.
 *
 * A "plugin" in a source repo is any directory whose `package.json` declares a
 * dependency on `@vellumai/plugin-api` (peer, dev, or regular). One ETag-cached
 * recursive tree fetch finds every `package.json` in the tree; only new/changed
 * manifests are re-downloaded (raw.githubusercontent, bounded concurrency).
 *
 * This is the plugin analogue of `src/skills/marketplace/indexer.ts` and reuses
 * the same GitHub primitives (`src/skills/marketplace/github.ts`). Indexes are
 * cached per source under `$VELLUM_WORKSPACE_DIR/plugin-registry-cache/` with a
 * 24h TTL. Indexing is lazy — nothing here runs at daemon startup; only the CLI
 * `plugins reindex`/`plugins search` paths call it.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  fetchRawFile,
  fetchRepoInfo,
  fetchRepoTree,
  mapWithConcurrency,
  type TreeEntry,
} from "../../skills/marketplace/github.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { loadSources } from "./registry-file.js";
import type {
  PluginIndexItem,
  PluginRegistrySource,
  PluginSourceIndex,
} from "./types.js";

const log = getLogger("plugin-registry-indexer");

const RAW_FETCH_CONCURRENCY = 6;
const INDEX_TTL_MS = 24 * 3_600_000;
const MAX_ITEMS_PER_SOURCE = 200;

/** The peer-dependency that marks a package.json as a Vellum/Cue plugin. */
export const PLUGIN_API_PACKAGE = "@vellumai/plugin-api";

export function getPluginRegistryCacheDir(): string {
  return join(getWorkspaceDir(), "plugin-registry-cache");
}

/** Sanitize an id/path segment to filesystem- and selector-safe characters. */
export function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Namespaced id for an indexed plugin. */
export function pluginItemId(address: string, pluginName: string): string {
  const [owner = "unknown", repo = "unknown"] = address.split("/");
  return `${sanitizeSegment(owner)}--${sanitizeSegment(repo)}--${sanitizeSegment(pluginName)}`;
}

function cacheFilePath(address: string): string {
  return join(getPluginRegistryCacheDir(), `${sanitizeSegment(address)}.json`);
}

interface CachedIndexFile extends PluginSourceIndex {
  version: 1;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(value) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

function readCachedIndex(address: string): CachedIndexFile | null {
  const filePath = cacheFilePath(address);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf-8"),
    ) as CachedIndexFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedIndex(index: PluginSourceIndex): void {
  try {
    atomicWriteJson(cacheFilePath(index.address), { version: 1, ...index });
  } catch (err) {
    log.warn(
      { err, address: index.address },
      "Failed to write plugin index cache",
    );
  }
}

// ─── Manifest parsing ────────────────────────────────────────────────────────

interface ParsedManifest {
  name: string;
  description: string;
  version?: string;
  apiRange?: string;
  license?: string;
  surfaces: string[];
}

/**
 * Parse a `package.json` into a plugin item's fields, or null when it is not a
 * plugin manifest (no `@vellumai/plugin-api` dependency of any kind).
 *
 * `pluginPath` is the manifest's repo-relative directory; when the manifest has
 * no `name`, the directory basename is used (matching the loader's rule that a
 * plugin's identity is its install-directory basename, not `package.json` name).
 */
export function parsePluginManifest(
  content: string,
  pluginPath: string,
): ParsedManifest | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const deps = (k: string): Record<string, string> => {
    const v = pkg[k];
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, string>)
      : {};
  };
  const apiRange =
    deps("peerDependencies")[PLUGIN_API_PACKAGE] ??
    deps("devDependencies")[PLUGIN_API_PACKAGE] ??
    deps("dependencies")[PLUGIN_API_PACKAGE];
  if (!apiRange) return null; // not a plugin manifest

  const baseName = pluginPath ? pluginPath.split("/").pop()! : "";
  const name =
    typeof pkg.name === "string" && pkg.name.trim()
      ? pkg.name.replace(/^@[^/]+\//, "").trim()
      : baseName || "unknown";
  const description =
    typeof pkg.description === "string" ? pkg.description.trim() : "";

  // Surfaces are inferred here from declared vellum metadata when present; the
  // authoritative surface list for a *curated* entry comes from registry.json.
  const surfaces: string[] = [];
  const vellum = pkg.vellum;
  if (vellum && typeof vellum === "object" && !Array.isArray(vellum)) {
    const s = (vellum as Record<string, unknown>).surfaces;
    if (Array.isArray(s)) {
      for (const item of s) if (typeof item === "string") surfaces.push(item);
    }
  }

  return {
    name,
    description,
    ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
    apiRange,
    ...(typeof pkg.license === "string" ? { license: pkg.license } : {}),
    surfaces,
  };
}

// ─── Indexing ────────────────────────────────────────────────────────────────

async function indexGithubSource(
  source: PluginRegistrySource,
  cached: CachedIndexFile | null,
): Promise<PluginSourceIndex> {
  const address = source.address;
  let ref = source.ref ?? cached?.ref;
  if (!ref) ref = (await fetchRepoInfo(address)).defaultBranch;

  const treeResult = await fetchRepoTree(address, ref, cached?.treeEtag);
  if (treeResult.notModified && cached) {
    const refreshed: PluginSourceIndex = { ...cached, fetchedAt: Date.now() };
    writeCachedIndex(refreshed);
    return refreshed;
  }
  if (treeResult.notModified) {
    throw new Error(`Tree fetch for ${address} returned 304 without a cache`);
  }

  // Only top-level `node_modules` is excluded; a `package.json` at any other
  // depth is a candidate manifest.
  const manifestEntries = treeResult.entries.filter(
    (e) =>
      e.type === "blob" &&
      /(^|\/)package\.json$/.test(e.path) &&
      !e.path.split("/").includes("node_modules"),
  );
  const capped = manifestEntries.slice(0, MAX_ITEMS_PER_SOURCE);
  const truncated =
    treeResult.truncated || manifestEntries.length > MAX_ITEMS_PER_SOURCE;

  const previousBySha = new Map<string, PluginIndexItem>();
  for (const item of cached?.items ?? []) {
    if (item.manifestSha) {
      previousBySha.set(`${item.pluginPath} ${item.manifestSha}`, item);
    }
  }

  const sourceLabel = source.label ?? address;
  const reviewStatus = source.reviewStatus ?? "unreviewed";
  const items: PluginIndexItem[] = [];
  const seenIds = new Set<string>();
  const toFetch: TreeEntry[] = [];

  for (const entry of capped) {
    const pluginPath = entry.path.replace(/\/?package\.json$/i, "");
    const reused = previousBySha.get(`${pluginPath} ${entry.sha}`);
    if (reused && !seenIds.has(reused.id)) {
      seenIds.add(reused.id);
      items.push({ ...reused, ref, sourceLabel, reviewStatus });
      continue;
    }
    if (!reused) toFetch.push(entry);
  }

  const fetched = await mapWithConcurrency(
    toFetch,
    RAW_FETCH_CONCURRENCY,
    async (entry) => {
      const content = await fetchRawFile(address, ref!, entry.path);
      const pluginPath = entry.path.replace(/\/?package\.json$/i, "");
      return {
        entry,
        pluginPath,
        parsed: parsePluginManifest(content, pluginPath),
      };
    },
  );

  for (const result of fetched) {
    if (result instanceof Error) {
      log.warn(
        { address, err: result },
        "Failed to fetch package.json for index",
      );
      continue;
    }
    const { entry, pluginPath, parsed } = result;
    if (!parsed) continue; // not a plugin manifest
    const id = pluginItemId(address, parsed.name);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    items.push({
      id,
      name: parsed.name,
      displayName: parsed.name,
      description: parsed.description,
      source: address,
      sourceLabel,
      pluginPath,
      ref,
      url: `https://github.com/${address}/tree/${ref}/${pluginPath}`,
      ...(parsed.apiRange ? { apiRange: parsed.apiRange } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.license ? { license: parsed.license } : {}),
      reviewStatus,
      surfaces: parsed.surfaces,
      manifestSha: entry.sha,
    });
  }

  items.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const index: PluginSourceIndex = {
    address,
    ref,
    fetchedAt: Date.now(),
    ...(treeResult.etag ? { treeEtag: treeResult.etag } : {}),
    ...(treeResult.treeSha ? { treeSha: treeResult.treeSha } : {}),
    ...(truncated ? { truncated } : {}),
    items,
  };
  writeCachedIndex(index);
  return index;
}

// ─── Public API (single-flight + TTL) ────────────────────────────────────────

const inflight = new Map<string, Promise<PluginSourceIndex>>();

/**
 * Index a source, serving the on-disk cache while fresh (24h TTL). Concurrent
 * callers share one in-flight fetch per source. On failure a stale cache is
 * returned when available (degraded, not broken); with no cache the error
 * propagates.
 */
export async function indexSource(
  source: PluginRegistrySource,
  options?: { force?: boolean },
): Promise<PluginSourceIndex> {
  const cached = readCachedIndex(source.address);
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.fetchedAt < INDEX_TTL_MS &&
    (!source.ref || cached.ref === source.ref)
  ) {
    return cached;
  }

  const existing = inflight.get(source.address);
  if (existing) return existing;

  const task = (async () => {
    try {
      return await indexGithubSource(source, cached);
    } catch (err) {
      if (cached) {
        log.warn(
          { err, address: source.address },
          "Plugin source re-index failed; serving stale cache",
        );
        return cached;
      }
      throw err;
    } finally {
      inflight.delete(source.address);
    }
  })();
  inflight.set(source.address, task);
  return task;
}

/** Index every enabled source, best-effort. Returns the merged item list. */
export async function reindexAllSources(options?: {
  force?: boolean;
}): Promise<{
  items: PluginIndexItem[];
  errors: Array<{ address: string; error: string }>;
}> {
  const items: PluginIndexItem[] = [];
  const errors: Array<{ address: string; error: string }> = [];
  for (const source of loadSources()) {
    if (!source.enabled) continue;
    try {
      const index = await indexSource(source, options);
      items.push(...index.items);
    } catch (err) {
      errors.push({
        address: source.address,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { items, errors };
}

/**
 * Enumerate plugin items already present in the on-disk index caches of the
 * enabled sources. Reads ONLY the local cache files — never the network — so a
 * machine that has never run `plugins reindex` returns `[]`. This is the plugin
 * analogue of the skills `listCachedMarketplaceItems`, and is what feeds both
 * the deterministic `plugins search` and the embedding seed.
 */
export function listCachedPluginItems(): PluginIndexItem[] {
  if (!existsSync(getPluginRegistryCacheDir())) return [];
  const items: PluginIndexItem[] = [];
  for (const source of loadSources()) {
    if (!source.enabled) continue;
    const cached = readCachedIndex(source.address);
    if (!cached) continue;
    items.push(...cached.items);
  }
  return items;
}
