/**
 * Gated catalog resolver for the HTTP install-by-name path.
 *
 * The HTTP browse surface (search / detail) reads the curated, commit-pinned
 * `plugins/registry.json` catalog (see `../../plugins/registry/catalog.ts`).
 * Install-by-name over HTTP must resolve from the SAME catalog — otherwise a
 * card that appears in search can 404 on install (or install a different
 * revision than the one browsed). This module projects a registry catalog
 * match onto concrete, validated GitHub install coordinates the installer can
 * treat as trusted.
 *
 * The CLI's `plugins install <name>` deliberately stays on the
 * `plugins/marketplace.json` full-SHA pin flow (`inspect`/`install` agree via
 * that manifest); this resolver is the HTTP-path analogue, keeping each
 * surface internally consistent without merging the two catalogs.
 */

import {
  listRegistryCatalog,
  type RegistryCatalogMatch,
} from "../../plugins/registry/catalog.js";
import {
  githubSourceSchema,
  type ResolvedPluginSource,
} from "./plugin-marketplace.js";

/** Find the catalog entry claiming `name`, or `null` when none does. */
export function findCatalogEntry(name: string): RegistryCatalogMatch | null {
  return listRegistryCatalog().find((m) => m.name === name) ?? null;
}

/**
 * Project a catalog match onto concrete GitHub install coordinates.
 *
 * Validates the reconstructed source against the canonical marketplace
 * GitHub-source schema (`owner/repo` slug, clean repo-relative path, full
 * commit SHA) — the exact rules the marketplace manifest enforces. Registry
 * rows are typed loosely (`repo`/`path`/`ref` are any string), so a malformed
 * coordinate — an over-segmented or slashless repo, an escaping/empty path, a
 * mutable non-SHA ref — is rejected here before it becomes a trusted install
 * source rather than installing the wrong tree or a repointable revision.
 * Pure — unit-testable without a catalog on disk.
 */
export function resolveSourceFromMatch(
  match: RegistryCatalogMatch,
): ResolvedPluginSource {
  // Repo-root `""` maps to `undefined` (omitted = root) so the schema's
  // non-empty path refine does not reject a valid repo-root entry.
  const path = match.source.path || undefined;
  const parsed = githubSourceSchema.safeParse({
    source: "github" as const,
    repo: match.source.repo,
    ...(path ? { path } : {}),
    ref: match.source.ref,
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog entry "${match.name}" (${match.source.repo}) has an invalid source: ` +
        parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const [owner, repoName] = parsed.data.repo.split("/", 2) as [string, string];
  return {
    owner,
    repo: repoName,
    path: match.source.path ?? "",
    ref: match.source.ref,
  };
}

/** Resolve `name` to install coordinates from the registry catalog, or `null`. */
export function resolvePluginSourceFromCatalog(
  name: string,
): ResolvedPluginSource | null {
  const match = findCatalogEntry(name);
  return match ? resolveSourceFromMatch(match) : null;
}
