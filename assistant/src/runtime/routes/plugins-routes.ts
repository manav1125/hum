/**
 * Route handlers for the assistant plugins surface.
 *
 * GET    /v1/plugins                — list installed plugins under `<workspaceDir>/plugins/`.
 * GET    /v1/plugins/search         — search the canonical GitHub catalog of installable plugins.
 * GET    /v1/plugins/:name          — resolve a single plugin's detail view (metadata + README).
 * POST   /v1/plugins/install        — install a plugin by name from the curated registry catalog.
 * POST   /v1/plugins/:name/enable   — clear a plugin's `.disabled` sentinel.
 * POST   /v1/plugins/:name/disable  — write a plugin's `.disabled` sentinel.
 * DELETE /v1/plugins/:name          — uninstall a plugin from `<workspaceDir>/plugins/<name>/`.
 *
 * The read-only routes are projections over the same library functions
 * the CLI uses (`assistant plugins list`, `assistant plugins search`).
 * The install / uninstall / enable / disable routes are symmetric to
 * `assistant plugins install|uninstall|enable|disable` and delegate to the
 * same `installPlugin` / `uninstallPlugin` / `enablePlugin` / `disablePlugin`
 * lib functions. CLI / daemon / web stay aligned on what an installed or
 * available plugin looks like — mirroring the skills surface, which already
 * exposes detail + install over HTTP.
 *
 * Together these close the plugin lifecycle over HTTP:
 * Install → Enabled ⟷ Disabled → Remove. The list and detail responses both
 * carry `disabled` so a client can render which of those states a plugin is
 * in without a second call.
 *
 * # Policy gating
 *
 * Reads require `settings.read`; install, uninstall, enable, and disable
 * require `settings.write`. The HTTP router enforces the per-route `policy`
 * block below, and the IPC route adapter ships the same policy in
 * `get_route_schema` so the gateway's IPC proxy stays in sync.
 */

import { z } from "zod";

import {
  inspectPlugin,
  PluginInspectNotFoundError,
} from "../../cli/lib/inspect-plugin.js";
import {
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  sanitizePluginName,
} from "../../cli/lib/install-from-github.js";
import {
  type InstalledPluginInfo,
  listInstalledPlugins,
} from "../../cli/lib/list-installed-plugins.js";
import { resolvePluginSourceFromCatalog } from "../../cli/lib/plugin-catalog-resolve.js";
import {
  getPluginDetails,
  PluginDetailsNotFoundError,
} from "../../cli/lib/plugin-details.js";
import {
  assertValidSearchPattern,
  InvalidSearchPatternError,
} from "../../cli/lib/search-plugins.js";
import {
  disablePlugin,
  enablePlugin,
  isPluginDisabled,
} from "../../cli/lib/toggle-plugin.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../../cli/lib/uninstall-plugin.js";
import {
  PluginNotUpgradableError,
  upgradePlugin,
} from "../../cli/lib/upgrade-plugin.js";
import {
  listRegistryCatalog,
  type RegistryCatalogMatch,
} from "../../plugins/registry/catalog.js";
import { seedPluginEmbeddings } from "../../plugins/registry/embedding-seed.js";
import type { PluginReviewStatus } from "../../plugins/registry/types.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const pluginInfoSchema = z.object({
  id: z
    .string()
    .describe(
      "Plugin's directory name (kebab-case). Matches `assistant plugins install <id>`.",
    ),
  name: z.string().describe("Display name. Equal to `id` today."),
  description: z
    .string()
    .nullable()
    .describe("From `package.json#description`; `null` when unknown."),
  version: z
    .string()
    .nullable()
    .describe("From `package.json#version`; `null` when unknown."),
  disabled: z
    .boolean()
    .describe(
      "True when the plugin carries a `.disabled` sentinel, i.e. the loader skips it. This is the Enabled ⟷ Disabled axis of the lifecycle; toggle it with `POST /v1/plugins/:name/{enable,disable}`.",
    ),
  path: z
    .string()
    .optional()
    .describe("Absolute path to the plugin directory on the assistant host."),
  issues: z
    .array(z.string())
    .optional()
    .describe(
      "Non-fatal issues with this entry (missing `package.json`, malformed JSON, ...). Omitted when clean.",
    ),
});

const pluginsListResponseSchema = z.object({
  plugins: z.array(pluginInfoSchema),
});

const pluginReviewStatusSchema = z
  .enum(["curated", "community", "unreviewed"])
  .describe(
    "Curation posture: `curated` (first-party / hand-reviewed), `community` (PR-submitted, license + manifest verified), or `unreviewed`. The HTTP browse surface only ever returns curated/community — unreviewed discovery stays CLI-gated.",
  );

const pluginMatchSourceSchema = z
  .object({
    kind: z.literal("github"),
    repo: z
      .string()
      .describe("`owner/repo` of the external plugin repository."),
    path: z
      .string()
      .optional()
      .describe(
        "Directory within the repo, when the plugin is not at the root.",
      ),
    ref: z
      .string()
      .describe("Pinned git ref (commit) the plugin is fetched from."),
  })
  .describe("Origin of the match: a whitelisted external plugin repository.");

const pluginSearchMatchSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  path: z
    .string()
    .describe(
      "Human-readable origin: a `github:owner/repo[/path]@ref` locator (the pinned commit).",
    ),
  description: z
    .string()
    .describe("Short description from the curated registry entry."),
  source: pluginMatchSourceSchema,
  reviewStatus: pluginReviewStatusSchema,
  surfaces: z
    .array(z.string())
    .describe(
      "Plugin surfaces the entry contributes (hooks/tools/skills/routes/apps); `[]` when it declares none.",
    ),
  category: z
    .string()
    .nullable()
    .describe(
      "Free-form grouping hint (e.g. `productivity`); `null` when absent.",
    ),
  license: z
    .string()
    .nullable()
    .describe("SPDX license expression; `null` when absent."),
  homepage: z
    .string()
    .nullable()
    .describe("Project homepage URL; `null` when absent."),
  icon: z
    .string()
    .nullable()
    .describe("Display emoji/icon; `null` when the entry ships none."),
});

const pluginsSearchResponseSchema = z.object({
  query: z
    .string()
    .describe("Echo of the requested query (ECMAScript regex source)."),
  ref: z
    .string()
    .describe(
      'Catalog source identifier. Always `"registry"` — the browse catalog is the on-disk curated `plugins/registry.json`, not a live git ref.',
    ),
  matches: z
    .array(pluginSearchMatchSchema)
    .describe("Curated catalog matches, sorted alphabetically by name."),
});

const pluginUninstallResponseSchema = z.object({
  name: z
    .string()
    .describe(
      "Directory name that was removed. Echoes the request's `:name` path parameter after sanitization.",
    ),
  target: z
    .string()
    .describe(
      "Absolute path that was removed on the assistant host. Useful for audit logs and confirmation toasts.",
    ),
});

const pluginDetailsResponseSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  installed: z
    .boolean()
    .describe(
      "Whether a copy is materialized under `<workspaceDir>/plugins/<name>/`.",
    ),
  disabled: z
    .boolean()
    .describe(
      "True when the installed copy carries a `.disabled` sentinel, i.e. the loader skips it. Always `false` when `installed` is false.",
    ),
  description: z
    .string()
    .nullable()
    .describe(
      "Short description, best-effort across disk, manifest, and repo.",
    ),
  homepage: z.string().nullable().describe("Project homepage URL, when known."),
  license: z
    .string()
    .nullable()
    .describe("SPDX license expression, when known."),
  version: z
    .string()
    .nullable()
    .describe(
      "Resolved version (installed copy first, then repo `package.json`).",
    ),
  source: pluginMatchSourceSchema
    .nullable()
    .describe(
      "Pinned origin from the curated registry entry, or null when an installed copy has no catalog entry.",
    ),
  reviewStatus: pluginReviewStatusSchema
    .nullable()
    .describe(
      "Curation posture from the registry entry, or null when an installed copy has no registry entry.",
    ),
  surfaces: z
    .array(z.string())
    .describe(
      "Plugin surfaces the entry contributes (hooks/tools/skills/routes/apps); `[]` when unknown or none declared.",
    ),
  category: z
    .string()
    .nullable()
    .describe("Free-form grouping hint from the registry; null when absent."),
  icon: z
    .string()
    .nullable()
    .describe(
      "Display emoji/icon from the registry entry; null when it ships none.",
    ),
  readme: z
    .string()
    .nullable()
    .describe("README markdown, or null when the plugin ships none."),
  ref: z
    .string()
    .describe(
      "Git ref the README was resolved at: the registry entry's pinned commit when one claims the name, else the fallback ref.",
    ),
  artifact: z
    .object({
      url: z
        .string()
        .describe("HTTPS URL the prebuilt client artifact is downloaded from."),
      sha256: z
        .string()
        .describe(
          "Lowercase 64-char hex SHA-256 the download is verified against.",
        ),
      label: z
        .string()
        .optional()
        .describe(
          'Optional human label for the download (e.g. "Download for macOS"); absent when the plugin doesn\'t name it.',
        ),
    })
    .nullable()
    .describe(
      "Prebuilt client artifact from `package.json` `vellum.artifact`, or null when the plugin ships none or its descriptor is incomplete (e.g. a placeholder sha256).",
    ),
});

const pluginInstallRequestSchema = z.object({
  name: z
    .string()
    .describe("Install name to resolve against the marketplace catalog."),
  force: z
    .boolean()
    .optional()
    .describe("Overwrite an existing install in place. Defaults to false."),
});

const pluginInstallResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string().describe("Install name that was materialized."),
  target: z
    .string()
    .describe("Absolute path the plugin was materialized into on the host."),
  fileCount: z
    .number()
    .describe("Number of files written for the installed plugin."),
  ref: z.string().describe("Git ref the plugin was fetched from."),
});

const fingerprintComparisonSchema = z
  .object({
    modified: z
      .array(z.string())
      .describe("Tracked files whose content changed since install."),
    added: z
      .array(z.string())
      .describe("Files present on disk but absent from the install baseline."),
    removed: z
      .array(z.string())
      .describe("Files recorded at install but missing from the on-disk copy."),
    clean: z
      .boolean()
      .describe("True when no files were added, removed, or modified."),
  })
  .describe(
    "Local-edit comparison of the on-disk tree against the install-time fingerprint.",
  );

const installMetaSourceSchema = z
  .object({
    kind: z.string().describe("Source kind. Only `github` is written today."),
    owner: z.string(),
    repo: z.string(),
    path: z
      .string()
      .optional()
      .describe(
        "Repo-relative directory holding the plugin root; absent = repo root.",
      ),
    ref: z
      .string()
      .describe(
        "Ref the install resolved through (the pinned commit SHA for marketplace installs).",
      ),
  })
  .describe(
    "Source coordinates recorded in the install-time provenance sidecar.",
  );

const pluginLocalInfoSchema = z
  .object({
    target: z
      .string()
      .describe("Absolute path to the installed plugin directory."),
    commit: z
      .string()
      .nullable()
      .describe(
        "Resolved commit the copy was installed at; null when no provenance was recorded.",
      ),
    committedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 committer timestamp (UTC) of the installed commit — the human-readable version; null for installs predating commit-timestamp capture. Distinct from `installedAt`.",
      ),
    version: z
      .string()
      .nullable()
      .describe("Installed `package.json#version`."),
    description: z
      .string()
      .nullable()
      .describe("Installed `package.json#description`."),
    installedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 install timestamp from the sidecar; null when absent.",
      ),
    source: installMetaSourceSchema
      .nullable()
      .describe(
        "Source recorded at install time; null when no sidecar exists.",
      ),
    localChanges: fingerprintComparisonSchema
      .nullable()
      .describe(
        "Local-edit state vs the install-time fingerprint; null when no baseline was recorded (older/manual install).",
      ),
    issues: z
      .array(z.string())
      .describe(
        "Non-fatal issues with the installed copy (e.g. malformed `package.json`).",
      ),
  })
  .describe("The locally installed copy of the plugin.");

const pluginRemoteInfoSchema = z
  .object({
    repo: z
      .string()
      .describe("`owner/repo` of the external plugin repository."),
    path: z
      .string()
      .describe(
        'Repo-relative directory holding the plugin root; `""` = repo root.',
      ),
    commit: z
      .string()
      .describe(
        "Pinned commit SHA the marketplace currently resolves installs to.",
      ),
    committedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 committer timestamp (UTC) of the pinned commit, resolved from GitHub; null when the commit metadata could not be fetched.",
      ),
    description: z.string().nullable(),
    homepage: z.string().nullable(),
    license: z.string().nullable(),
    category: z.string().nullable(),
    marketplaceRef: z
      .string()
      .describe(
        "Ref of the canonical repo the marketplace manifest was read from.",
      ),
  })
  .describe("The marketplace's current pin and advertised metadata.");

const pluginInspectResponseSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  installed: z
    .boolean()
    .describe(
      "Whether a copy is materialized under `<workspaceDir>/plugins/`.",
    ),
  status: z
    .enum([
      "up-to-date",
      "update-available",
      "not-installed",
      "not-in-marketplace",
      "unknown-provenance",
      "remote-unavailable",
    ])
    .describe(
      "Drift classification between the installed copy and the marketplace pin.",
    ),
  local: pluginLocalInfoSchema
    .nullable()
    .describe("Locally installed copy; null when the plugin is not installed."),
  remote: pluginRemoteInfoSchema
    .nullable()
    .describe(
      "Marketplace pin + metadata; null when no entry claims the name or it was unreachable.",
    ),
  remoteError: z
    .string()
    .nullable()
    .describe(
      "Marketplace fetch error message, when the catalog could not be read.",
    ),
});

const pluginUpgradeRequestSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Report what would change without modifying the install. Defaults to false.",
    ),
});

const pluginUpgradeResponseSchema = z.object({
  name: z.string().describe("Install name that was (or would be) upgraded."),
  outcome: z
    .enum(["upgraded", "already-up-to-date", "would-upgrade"])
    .describe(
      "`upgraded` moved the install to the pin; `already-up-to-date` was a no-op; `would-upgrade` is a dry-run that found drift.",
    ),
  fromCommit: z
    .string()
    .nullable()
    .describe(
      "Installed commit before the upgrade; null when no provenance was recorded.",
    ),
  fromTimestamp: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer timestamp (UTC) of `fromCommit` — the version moved from; null when not recorded.",
    ),
  toCommit: z
    .string()
    .describe(
      "Marketplace-pinned commit the install was (or would be) moved to.",
    ),
  toTimestamp: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer timestamp (UTC) of `toCommit` — the version moved to; null when it could not be resolved.",
    ),
  target: z
    .string()
    .describe("Absolute path to the installed plugin directory on the host."),
  fileCount: z
    .number()
    .nullable()
    .describe(
      "Files materialized by the upgrade; null for a no-op or dry run.",
    ),
  dryRun: z.boolean().describe("Whether this was a dry run (no changes made)."),
  provenanceWasUnknown: z
    .boolean()
    .describe(
      "Whether the install lacked resolvable provenance before the upgrade; such installs are re-pinned to record it going forward.",
    ),
});

const pluginToggleResponseSchema = z.object({
  name: z
    .string()
    .describe(
      "Directory name that was toggled. Echoes the request's `:name` path parameter after sanitization.",
    ),
  disabled: z
    .boolean()
    .describe(
      "State AFTER the operation: `true` when the `.disabled` sentinel is present. `POST .../disable` always resolves to `true`, `POST .../enable` to `false`.",
    ),
  changed: z
    .boolean()
    .describe(
      "Whether the call actually changed the on-disk state. `false` means the plugin was already in the requested state — the route is idempotent, so this is a 200 rather than a conflict.",
    ),
  restartRequired: z
    .boolean()
    .describe(
      "Whether the assistant must restart for this toggle to take effect. Mirrors `changed`: the sentinel is read when a plugin directory is imported at load time, so a change only lands on the next load. `false` for a no-op toggle.",
    ),
});

const pluginSeedEmbeddingsRequestSchema = z.object({
  includeUnreviewed: z
    .boolean()
    .optional()
    .describe(
      "Also seed unreviewed manifests indexed from allowlisted sources. Defaults to false (curated + community-reviewed entries only).",
    ),
});

const pluginSeedEmbeddingsResponseSchema = z.object({
  seeded: z
    .number()
    .describe(
      "Number of plugin manifests upserted into the shared embedding collection. `0` when the embedding backend is unavailable (deterministic search still works).",
    ),
  skipped: z
    .number()
    .describe(
      "Number of candidates not seeded (duplicate slugs, or all candidates when the backend was unavailable).",
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PluginView {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  disabled: boolean;
  path: string;
  issues?: string[];
}

function projectPlugin(entry: InstalledPluginInfo): PluginView {
  // `id` and `name` both track the directory name. `package.json#name` can
  // be scoped (e.g. `@vendor/plugin-name`) which is fine for npm but not
  // what the CLI uses to install — so we don't surface it as `name`.
  const view: PluginView = {
    id: entry.name,
    name: entry.name,
    description: entry.packageJson?.description ?? null,
    version: entry.packageJson?.version ?? null,
    // Read through the cli/lib facade so the list route and `plugins list`
    // agree on enable/disable state without either reaching past the other.
    disabled: isPluginDisabled(entry.name),
    path: entry.target,
  };
  if (entry.issues.length > 0) {
    view.issues = [...entry.issues];
  }
  return view;
}

/** Wire shape for a catalog match. Mirrors {@link pluginSearchMatchSchema}. */
interface PluginMatchView {
  name: string;
  path: string;
  description: string;
  source: { kind: "github"; repo: string; path?: string; ref: string };
  reviewStatus: PluginReviewStatus;
  surfaces: string[];
  category: string | null;
  license: string | null;
  homepage: string | null;
  icon: string | null;
}

/**
 * Re-pack a registry catalog match into a mutable wire object so the route
 * serializer's `Record<string, unknown>` contract holds. The wire shape is
 * {@link pluginSearchMatchSchema}.
 */
function projectMatch(m: RegistryCatalogMatch): PluginMatchView {
  return {
    name: m.name,
    path: m.path,
    description: m.description,
    source: {
      kind: "github",
      repo: m.source.repo,
      ref: m.source.ref,
      ...(m.source.path !== undefined ? { path: m.source.path } : {}),
    },
    reviewStatus: m.reviewStatus,
    surfaces: [...m.surfaces],
    category: m.category,
    license: m.license,
    homepage: m.homepage,
    icon: m.icon,
  };
}

function matchesQuery(plugin: PluginView, needle: string): boolean {
  const q = needle.toLowerCase();
  if (plugin.id.toLowerCase().includes(q)) return true;
  if (plugin.name.toLowerCase().includes(q)) return true;
  if (plugin.description && plugin.description.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler — list installed
// ---------------------------------------------------------------------------

function handleListPlugins({ queryParams = {} }: RouteHandlerArgs): {
  plugins: PluginView[];
} {
  const q = queryParams.q?.trim();
  const installed = listInstalledPlugins();
  const projected = installed.map(projectPlugin);
  const filtered = q ? projected.filter((p) => matchesQuery(p, q)) : projected;
  return { plugins: filtered };
}

// ---------------------------------------------------------------------------
// Handler — search catalog
// ---------------------------------------------------------------------------

interface PluginsSearchResponse {
  query: string;
  ref: string;
  matches: PluginMatchView[];
}

/**
 * Identifier reported in the search response's `ref` field. The browse catalog
 * is the on-disk curated `plugins/registry.json` — the SAME source the CLI
 * `plugins search`, detail, and the embedding seed read — so there is no live
 * git ref to report and no network I/O to rate-limit. This keeps search and
 * detail consistent: every match here resolves on `GET /v1/plugins/:name`.
 */
const REGISTRY_CATALOG_REF = "registry";

async function handleSearchPlugins({
  queryParams = {},
}: RouteHandlerArgs): Promise<PluginsSearchResponse> {
  // Empty string is a legitimate "match everything" query — an empty regex
  // matches every name, so an empty/absent `q` returns the full curated set.
  const query = queryParams.q ?? "";

  try {
    // Reject a malformed regex up front so a user typo is a cheap deterministic
    // 400. `assertValidSearchPattern` compiles the same case-insensitive regex
    // used below, so a passing assert guarantees the RegExp constructor here
    // never throws.
    assertValidSearchPattern(query);
    const matcher = new RegExp(query, "i");
    const matches = listRegistryCatalog()
      .filter((m) => matcher.test(m.name))
      .map(projectMatch);
    return { query, ref: REGISTRY_CATALOG_REF, matches };
  } catch (err) {
    if (err instanceof InvalidSearchPatternError) {
      throw new BadRequestError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin catalog search failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — uninstall
// ---------------------------------------------------------------------------

interface PluginUninstallResponse {
  name: string;
  target: string;
}

function handleUninstallPlugin({
  pathParams = {},
}: RouteHandlerArgs): PluginUninstallResponse {
  // The HTTP router has already URL-decoded `:name` for us; pass it
  // through verbatim — `uninstallPlugin` runs the same
  // `sanitizePluginName` check the CLI uses, so attacker-supplied
  // `../escape` style names get rejected before `rmSync` is reached.
  const rawName = pathParams.name ?? "";

  try {
    const result = uninstallPlugin({ name: rawName });
    return { name: result.name, target: result.target };
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginNotInstalledError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin uninstall failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — detail view
// ---------------------------------------------------------------------------

async function handleGetPluginDetails({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";
  const ref = queryParams.ref?.trim() || undefined;

  try {
    return await getPluginDetails(
      { name: rawName, ref },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginDetailsNotFoundError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin detail lookup failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — install
// ---------------------------------------------------------------------------

async function handleInstallPlugin({ body = {} }: RouteHandlerArgs) {
  const rawName = typeof body.name === "string" ? body.name : "";
  if (!rawName) {
    throw new BadRequestError("`name` is required");
  }
  const force = typeof body.force === "boolean" ? body.force : undefined;

  // The install source is never taken from the request: a caller-supplied
  // ref/repo would let any `settings.write` principal install from an
  // unreviewed revision (a PR branch, fork ref, ...) whose code the loader
  // then dynamically imports. The name resolves — server-side — against the
  // curated, commit-pinned `plugins/registry.json` catalog: the SAME source of
  // truth `handleSearchPlugins` and the detail route read, so a card that
  // appears in search always resolves here on install, at exactly the pinned
  // revision the card advertised. The pre-resolved source is validated against
  // the marketplace github-source schema (full-SHA pin) and handed to the
  // installer as trusted coordinates — no `plugins/marketplace.json` fetch.
  // Operators who need another ref use the local CLI's
  // `assistant plugins install --ref`.
  try {
    // Validate the name up front — before any catalog work — so a malformed
    // name (`../escape`) is a deterministic 400 rather than a 404 from the
    // catalog lookup. `installPlugin` sanitizes too; this preserves the
    // advertised 400.
    const name = sanitizePluginName(rawName);
    const source = resolvePluginSourceFromCatalog(name);
    if (!source) {
      throw new NotFoundError(`No plugin named "${name}" in the catalog.`);
    }
    const result = await installPlugin(
      {
        name,
        force,
        trustedSource: {
          owner: source.owner,
          repo: source.repo,
          rootPath: source.path,
          ref: source.ref,
        },
      },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    return {
      ok: true as const,
      name: result.name,
      target: result.target,
      fileCount: result.fileCount,
      ref: result.ref,
    };
  } catch (err) {
    // The not-in-catalog case above is already a RouteError; re-throw it
    // verbatim rather than masking it as a 500.
    if (err instanceof NotFoundError) {
      throw err;
    }
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginAlreadyInstalledError) {
      throw new ConflictError(err.message);
    }
    if (err instanceof PluginNotFoundError) {
      throw new NotFoundError(err.message);
    }
    // A rate-limited or otherwise temporarily-down GitHub source is
    // retryable, so surface 503 rather than a misleading 500.
    if (err instanceof PluginSourceUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin install failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — inspect (drift)
// ---------------------------------------------------------------------------

async function handleInspectPlugin({ pathParams = {} }: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";

  try {
    // `inspectPlugin` never throws for an unreachable marketplace when a local
    // copy exists — it reports `status: "remote-unavailable"` and captures the
    // message in `remoteError`. It only throws when there is nothing to show.
    return await inspectPlugin(
      { name: rawName },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginInspectNotFoundError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin inspect failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — upgrade
// ---------------------------------------------------------------------------

async function handleUpgradePlugin({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : undefined;

  // Like install, the upgrade target ref is the curated marketplace pin
  // (resolved inside `upgradePlugin` via `inspectPlugin`), never a
  // caller-supplied ref — a `settings.write` principal cannot redirect the
  // upgrade at an unreviewed revision.
  try {
    const result = await upgradePlugin(
      { name: rawName, dryRun },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    return {
      name: result.name,
      outcome: result.outcome,
      fromCommit: result.fromCommit,
      fromTimestamp: result.fromTimestamp,
      toCommit: result.toCommit,
      toTimestamp: result.toTimestamp,
      target: result.target,
      fileCount: result.fileCount,
      dryRun: result.dryRun,
      provenanceWasUnknown: result.provenanceWasUnknown,
    };
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginNotInstalledError) {
      throw new NotFoundError(err.message);
    }
    if (err instanceof PluginNotFoundError) {
      throw new NotFoundError(err.message);
    }
    // The install has neither a marketplace entry nor a recorded GitHub
    // source to advance to — a permanent state the caller cannot resolve by
    // retrying. 409 marks the request as well-formed but not actionable in
    // the current state.
    if (err instanceof PluginNotUpgradableError) {
      throw new ConflictError(err.message);
    }
    // A rate-limited or temporarily-down source (the plugin repo or the
    // marketplace catalog) is a retryable outage, not a conflict — 503.
    if (err instanceof PluginSourceUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin upgrade failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — enable / disable
// ---------------------------------------------------------------------------

interface PluginToggleResponse {
  name: string;
  disabled: boolean;
  changed: boolean;
  restartRequired: boolean;
}

/**
 * Shared body for both toggle routes. `enablePlugin` / `disablePlugin` run the
 * same `sanitizePluginName` check the CLI uses, so an attacker-supplied
 * `../escape` name is rejected before any path is joined — the raw `:name` is
 * handed off verbatim exactly like the uninstall route does.
 *
 * Idempotent by contract: toggling a plugin that is already in the requested
 * state returns 200 with `changed: false` rather than a conflict, so a
 * double-tapped UI toggle is harmless.
 */
function togglePlugin(
  rawName: string,
  next: "enable" | "disable",
): PluginToggleResponse {
  try {
    const result =
      next === "disable"
        ? disablePlugin({ name: rawName })
        : enablePlugin({ name: rawName });
    return {
      name: result.name,
      disabled: result.disabled,
      changed: result.changed,
      // The sentinel gates the loader's import, so a real change only lands
      // on the next load — same restart rule install/uninstall/upgrade carry.
      restartRequired: result.changed,
    };
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginNotInstalledError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : `plugin ${next} failed`,
    );
  }
}

function handleEnablePlugin({
  pathParams = {},
}: RouteHandlerArgs): PluginToggleResponse {
  return togglePlugin(pathParams.name ?? "", "enable");
}

function handleDisablePlugin({
  pathParams = {},
}: RouteHandlerArgs): PluginToggleResponse {
  return togglePlugin(pathParams.name ?? "", "disable");
}

// ---------------------------------------------------------------------------
// Handler — seed embeddings
// ---------------------------------------------------------------------------

/**
 * Seed the curated + indexed plugin registry into the shared Qdrant
 * embedding space. Unlike the other plugin operations this genuinely needs
 * the running daemon (embedding backend + Qdrant connection), so it is only
 * reachable over HTTP/IPC — the CLI's `plugins reindex --embed` calls it via
 * `seedPluginEmbeddingsViaDaemon`. Best-effort by contract: an unavailable
 * embedding backend yields `{ seeded: 0 }` rather than an error.
 */
async function handleSeedPluginEmbeddings({ body = {} }: RouteHandlerArgs) {
  const includeUnreviewed =
    typeof body.includeUnreviewed === "boolean"
      ? body.includeUnreviewed
      : undefined;
  try {
    const result = await seedPluginEmbeddings(
      includeUnreviewed !== undefined ? { includeUnreviewed } : {},
    );
    return { seeded: result.seeded, skipped: result.skipped };
  } catch (err) {
    throw new InternalError(
      err instanceof Error ? err.message : "plugin embedding seed failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "plugins_list",
    endpoint: "plugins",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List installed plugins",
    description:
      "Return one entry per directory under `<workspaceDir>/plugins/`, sorted alphabetically. Matches the CLI's `assistant plugins list`. Supports `?q=<text>` for case-insensitive substring matching across plugin id, name, and description.",
    tags: ["plugins"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description:
          "Optional substring filter applied to plugin id, name, and description.",
      },
    ],
    responseBody: pluginsListResponseSchema,
    handler: handleListPlugins,
  },
  {
    operationId: "plugins_search",
    endpoint: "plugins/search",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search the plugin catalog",
    description:
      "List installable plugins from the curated, commit-pinned `plugins/registry.json` catalog — the SAME on-disk source the CLI `plugins search`, the detail route, and the embedding seed read, so every match here resolves on `GET /v1/plugins/:name`. The query is an ECMAScript regex matched case-insensitively against the plugin name (e.g. `memory`, `^simple`). Empty query returns every curated entry. Only curated + community (hand-reviewed) entries are returned; unreviewed discovery stays CLI-gated. Each match carries its curation metadata (reviewStatus, surfaces, category, license, homepage, icon).",
    tags: ["plugins"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description:
          "ECMAScript regex pattern matched case-insensitively against catalog plugin names. Empty/missing matches everything.",
      },
      {
        name: "ref",
        schema: { type: "string" },
        description:
          "Accepted for backward compatibility but ignored: the browse catalog is the on-disk curated registry, not a live git ref.",
      },
    ],
    responseBody: pluginsSearchResponseSchema,
    handler: handleSearchPlugins,
  },
  {
    operationId: "plugins_install",
    endpoint: "plugins/install",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Install a plugin",
    description:
      "Install a plugin by name from the curated, commit-pinned `plugins/registry.json` catalog — the SAME on-disk source the search and detail routes read, so any card returned by `GET /v1/plugins/search` installs here at exactly the pinned revision it advertised. The install source is resolved server-side (no caller-supplied ref/repo): installing from an unreviewed revision would bypass the curation boundary and let attacker-controlled code be loaded. Materializes the plugin under `<workspaceDir>/plugins/<name>/`; the assistant must be restarted to load it. An already-installed name without `force` returns 409; a name the catalog does not claim returns 404. Sibling to `POST /v1/skills/install`.",
    tags: ["plugins"],
    requestBody: pluginInstallRequestSchema,
    responseBody: pluginInstallResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The request body was missing `name` or the name failed sanitization.",
      },
      "404": {
        description: "No catalog entry claims the given name.",
      },
      "409": {
        description:
          "A plugin with the same name is already installed and `force` was not set.",
      },
    },
    handler: handleInstallPlugin,
  },
  {
    operationId: "plugins_get",
    endpoint: "plugins/:name",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a plugin's detail view",
    description:
      "Resolve a single plugin's tracked metadata (description, homepage, license, version, source, reviewStatus, surfaces, category, icon) plus its README markdown. Unions the locally installed copy, the curated `plugins/registry.json` entry, and the plugin's repository at the pinned commit — preferring the installed copy. Reads the SAME on-disk catalog the search route lists, so any card returned by search resolves here. Names that are neither installed nor present in the catalog return 404. Powers the web plugin detail page; mirrors `GET /v1/skills/:id`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    queryParams: [
      {
        name: "ref",
        schema: { type: "string" },
        description:
          "Optional git ref to read catalog metadata / README at. Defaults to the CLI's `DEFAULT_PLUGIN_REF`.",
      },
    ],
    responseBody: pluginDetailsResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No installed copy and no catalog entry claims the given name.",
      },
    },
    handler: handleGetPluginDetails,
  },
  {
    operationId: "plugins_uninstall",
    endpoint: "plugins/:name",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Uninstall a plugin",
    description:
      "Remove the directory at `<workspaceDir>/plugins/<name>/`. Mirrors the CLI's `assistant plugins uninstall <name>` (without the interactive confirmation — the API caller is responsible for any prompt). The plugin name is sanitized by the same regex the CLI uses; `../escape`-style values, hidden names, and absolute paths return 400. Missing plugins return 404. The assistant must be restarted to drop the plugin from the running runtime.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginUninstallResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description: "No plugin directory exists with the given name.",
      },
    },
    handler: handleUninstallPlugin,
  },
  {
    operationId: "plugins_inspect",
    endpoint: "plugins/:name/inspect",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Inspect a plugin's install drift",
    description:
      "Compare the locally installed copy of a plugin against the marketplace's current pinned commit and report whether an upgrade is available. Returns a six-way `status` (`up-to-date`, `update-available`, `not-installed`, `not-in-marketplace`, `unknown-provenance`, `remote-unavailable`) plus the local provenance (installed commit, version, source, and any local edits vs the install-time fingerprint) and the remote pin. An unreachable marketplace for an installed plugin is not fatal — it returns 200 with `status: \"remote-unavailable\"`. A name that is neither installed nor in the catalog returns 404. Powers the web upgrade affordance; mirrors the CLI's `assistant plugins inspect <name>` and `GET /v1/skills/:id/inspect`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginInspectResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No installed copy and no catalog entry claims the given name.",
      },
    },
    handler: handleInspectPlugin,
  },
  {
    operationId: "plugins_upgrade",
    endpoint: "plugins/:name/upgrade",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Upgrade a plugin to its source's current revision",
    description:
      "Move an installed plugin to its source's current revision, re-materializing it under `<workspaceDir>/plugins/<name>/`. A marketplace plugin advances to the curated pin; a plugin the marketplace does not claim but whose provenance records a GitHub source (an untrusted direct install) advances to whatever its recorded ref now resolves to — a branch/tag/HEAD moves as upstream does, and a full-SHA pin follows the repo's default branch — re-materialized verbatim with no curated adapter overlay. The target ref is never taken from the request (no caller-supplied ref), mirroring `plugins install`'s curation boundary. A no-op (`outcome: \"already-up-to-date\"`) when the installed commit already equals the target; pass `dryRun` to preview the move (`outcome: \"would-upgrade\"`) without touching the install. Installs lacking provenance are re-pinned to the current SHA. The assistant must be restarted to load the upgraded code. This does not gate on local edits — callers should consult `GET /v1/plugins/:name/inspect` (`local.localChanges`) first and confirm before overwriting. Mirrors the CLI's `assistant plugins upgrade <name>`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    requestBody: pluginUpgradeRequestSchema,
    responseBody: pluginUpgradeResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No copy of the plugin is installed, or its source resolves to nothing.",
      },
      "409": {
        description:
          "The install has neither a marketplace entry nor a recorded GitHub source to advance to.",
      },
      "503": {
        description:
          "The plugin source (GitHub) was temporarily unavailable; the upgrade is retryable.",
      },
    },
    handler: handleUpgradePlugin,
  },
  {
    operationId: "plugins_enable",
    endpoint: "plugins/:name/enable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Enable an installed plugin",
    description:
      "Remove the `.disabled` sentinel from `<workspaceDir>/plugins/<name>/` so the loader imports the plugin again. Mirrors the CLI's `assistant plugins enable <name>`. Idempotent: an already-enabled plugin returns 200 with `changed: false` rather than a conflict. The sentinel gates the loader's import, so a real change lands on the next assistant restart (`restartRequired`) — the same rule install / uninstall / upgrade carry. The plugin name is sanitized by the same regex the CLI uses; `../escape`-style values return 400, and a name with no installed directory returns 404. This is the Enabled half of the Install → Enabled ⟷ Disabled → Remove lifecycle; `disabled` on `GET /v1/plugins` and `GET /v1/plugins/:name` reports the current state.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginToggleResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description: "No plugin directory exists with the given name.",
      },
    },
    handler: handleEnablePlugin,
  },
  {
    operationId: "plugins_disable",
    endpoint: "plugins/:name/disable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Disable an installed plugin",
    description:
      "Write a `.disabled` sentinel into `<workspaceDir>/plugins/<name>/` so the loader skips the plugin entirely — no module evaluation, init, hooks, tools, or routes. This is the reversible alternative to uninstalling an untrusted or misbehaving plugin: the code stays on disk and `POST /v1/plugins/:name/enable` restores it. Mirrors the CLI's `assistant plugins disable <name>`. Idempotent: an already-disabled plugin returns 200 with `changed: false`. The gate is at load time, so a real change lands on the next assistant restart (`restartRequired`). The plugin name is sanitized by the same regex the CLI uses; `../escape`-style values return 400, and a name with no installed directory returns 404.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginToggleResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description: "No plugin directory exists with the given name.",
      },
    },
    handler: handleDisablePlugin,
  },
  {
    operationId: "plugins_seed_embeddings",
    endpoint: "plugins/seed-embeddings",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Seed the plugin registry into the shared embedding space",
    description:
      "Upsert the curated + already-indexed plugin manifests into the shared `memory_v2_concept_pages` Qdrant collection (under a `plugins/` slug prefix) so plugin discovery shares the skill embedding space. Unlike the other plugin routes, this requires the running daemon's embedding backend and Qdrant connection — it is the daemon-side half of the CLI's `assistant plugins reindex --embed` (the manifest fetch/cache half runs locally in the CLI). Best-effort: an unavailable embedding backend returns 200 with `seeded: 0` (deterministic search still works) rather than an error.",
    tags: ["plugins"],
    requestBody: pluginSeedEmbeddingsRequestSchema,
    responseBody: pluginSeedEmbeddingsResponseSchema,
    handler: handleSeedPluginEmbeddings,
  },
];
