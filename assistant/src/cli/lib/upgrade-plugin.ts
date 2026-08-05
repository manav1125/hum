/**
 * Upgrade a single installed plugin to its source's current revision.
 *
 * A marketplace plugin pins to a full, immutable commit SHA (see
 * {@link ./plugin-marketplace}); an upgrade re-materializes the install at
 * whatever SHA the catalog currently advertises. Drift is detected with the
 * same exact commit-SHA comparison {@link ./inspect-plugin} uses, so an
 * upgrade is a no-op when the installed copy already matches the pin.
 *
 * A plugin the marketplace does not claim (untrusted, installed from a GitHub
 * source directly) is upgraded against its *recorded* source instead: its
 * `install-meta.json` names the owner/repo/path/ref it was cloned from, and
 * the upgrade target is whatever that ref resolves to now — a branch / tag /
 * `HEAD` advances as upstream does, and an install pinned to an immutable full
 * SHA follows the repo's default branch rather than freezing forever (a full
 * SHA has no "later" revision of itself to move to). Such an upgrade
 * re-materializes verbatim, with no curated adapter overlay, exactly as the
 * original untrusted install was (see {@link directUpgrade}).
 *
 * This is deliberately a distinct operation from install: `install` is
 * first-time materialization (and errors on an existing install unless
 * `--force` is passed), whereas `upgrade` moves an existing install forward.
 * Mechanically the move is a forced re-install at the current pin, which the
 * underlying {@link ./install-from-github.installPlugin} performs atomically —
 * the previously installed copy is preserved until the fetch succeeds.
 *
 * Conflict resolution for locally-modified plugins is intentionally out of
 * scope here: this overwrites the install with the pinned tree. A future
 * iteration will detect local edits (installed SHA = merge base) and resolve
 * them before the swap.
 *
 * Designed for direct programmatic use with injected dependencies, mirroring
 * the sibling plugin libraries. The CLI command `assistant plugins upgrade
 * <name>` is a thin wrapper that supplies production deps and formats the
 * result.
 */

import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  fetchCommitDate,
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
  type PluginLocalInfo,
} from "./inspect-plugin.js";
import {
  DEFAULT_DIRECT_REF,
  type FetchLike,
  type GitRunner,
  installPlugin,
  isFullCommitSha,
  type PluginFetchSource,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  type PostinstallRunner,
  resolveRefCommit,
  sanitizePluginName,
} from "./install-from-github.js";
import type { DependencyInstaller } from "./install-plugin-dependencies.js";
import { PluginNotInstalledError } from "./uninstall-plugin.js";

/**
 * Outcome of an upgrade attempt.
 *
 * - `upgraded` — the install was moved to the current marketplace pin.
 * - `already-up-to-date` — the installed commit already equals the pin; no-op.
 * - `would-upgrade` — a `--dry-run` that found drift but made no changes.
 */
export type PluginUpgradeOutcome =
  | "upgraded"
  | "already-up-to-date"
  | "would-upgrade";

/** Options that control which plugin to upgrade and how. */
export interface UpgradePluginOptions {
  /** Install name (kebab-case directory name). */
  readonly name: string;
  /** Report what would change without modifying the install. */
  readonly dryRun?: boolean;
}

/** Dependencies injected by the caller. */
export interface UpgradePluginDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to the live workspace. */
  readonly workspacePluginsDir?: string;
  /** Override the git runner used to clone the source. Forwarded to {@link installPlugin}. */
  readonly runGit?: GitRunner;
  /** Override the postinstall adapter runner. Forwarded to {@link installPlugin}. */
  readonly runPostinstall?: PostinstallRunner;
  /** Override the dependency-install runner. Forwarded to {@link installPlugin}. */
  readonly runInstallDeps?: DependencyInstaller;
}

/** Result of an upgrade attempt. */
export interface PluginUpgradeResult {
  readonly name: string;
  readonly outcome: PluginUpgradeOutcome;
  /** Installed commit before the upgrade; `null` when no provenance was recorded. */
  readonly fromCommit: string | null;
  /**
   * ISO-8601 committer timestamp (UTC) of {@link PluginUpgradeResult.fromCommit},
   * the human-readable version moved from; `null` when it was not recorded.
   */
  readonly fromTimestamp: string | null;
  /** Marketplace-pinned commit the install was (or would be) moved to. */
  readonly toCommit: string;
  /**
   * ISO-8601 committer timestamp (UTC) of {@link PluginUpgradeResult.toCommit},
   * the human-readable version moved to; `null` when it could not be resolved.
   */
  readonly toTimestamp: string | null;
  /** Absolute path to the installed plugin directory. */
  readonly target: string;
  /** Files materialized by the upgrade; `null` for a no-op or dry run. */
  readonly fileCount: number | null;
  /** Whether this was a dry run (no changes made). */
  readonly dryRun: boolean;
  /**
   * Whether the installed copy lacked resolvable provenance before the
   * upgrade. Such installs are re-pinned to the current SHA, which also
   * records provenance going forward.
   */
  readonly provenanceWasUnknown: boolean;
}

/** An installed plugin has neither a marketplace pin nor a recorded GitHub source to upgrade to. */
export class PluginNotUpgradableError extends Error {
  constructor(
    readonly pluginName: string,
    reason: string,
  ) {
    super(`Plugin "${pluginName}" cannot be upgraded: ${reason}.`);
    this.name = "PluginNotUpgradableError";
  }
}

function pluginTarget(name: string, deps: UpgradePluginDeps): string {
  const dir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  return join(dir, name);
}

/**
 * Move an installed plugin to its source's current revision — the marketplace
 * pin for a catalog plugin, or the recorded GitHub ref's current commit for a
 * directly-installed one (delegated to {@link directUpgrade}).
 *
 * Throws {@link PluginNotInstalledError} when no copy is installed,
 * {@link PluginNotUpgradableError} when the install is neither in the
 * marketplace nor carries a recorded GitHub source to advance,
 * {@link PluginNotFoundError} when a direct install's recorded ref has
 * vanished from the remote, {@link PluginSourceUnavailableError} when the
 * marketplace catalog or the plugin source is temporarily unreachable (a
 * retryable outage, distinct from the permanent no-source case), and
 * propagates {@link installPlugin}'s errors (e.g. source unavailable,
 * postinstall failure) when the re-install itself fails.
 */
export async function upgradePlugin(
  opts: UpgradePluginOptions,
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const name = sanitizePluginName(opts.name);
  const dryRun = opts.dryRun ?? false;

  let inspection: PluginInspection;
  try {
    inspection = await inspectPlugin(
      { name },
      { fetch: deps.fetch, workspacePluginsDir: deps.workspacePluginsDir },
    );
  } catch (err) {
    if (err instanceof PluginInspectNotFoundError) {
      throw new PluginNotInstalledError(name, pluginTarget(name, deps));
    }
    throw err;
  }

  switch (inspection.status) {
    case "not-installed":
      throw new PluginNotInstalledError(name, pluginTarget(name, deps));
    case "not-in-marketplace": {
      // The marketplace doesn't claim this name, but an install sourced
      // directly from GitHub (untrusted) still has a recorded source to
      // advance: upgrade it by re-fetching whatever its recorded ref now
      // resolves to.
      const local = inspection.local;
      if (!local) {
        throw new PluginNotUpgradableError(
          name,
          "it has no marketplace entry and no installed copy to upgrade",
        );
      }
      return directUpgrade({ name, local, dryRun }, deps);
    }
    case "remote-unavailable":
      // A transient catalog outage is not a permanent "cannot upgrade" state:
      // the same request can succeed once the marketplace source recovers, so
      // surface it as a retryable source-unavailable error rather than a
      // conflict.
      throw new PluginSourceUnavailableError(
        `Plugin "${name}" cannot be upgraded: the marketplace could not be reached (${inspection.remoteError ?? "unknown error"}).`,
        503,
      );
  }

  // The remaining statuses (up-to-date, update-available, unknown-provenance)
  // all imply an installed copy and a resolvable marketplace pin.
  const { local, remote } = inspection;
  if (!local || !remote) {
    throw new PluginNotUpgradableError(
      name,
      "its install or marketplace metadata could not be resolved",
    );
  }

  const fromCommit = local.commit;
  const fromTimestamp = local.committedAt;
  const toCommit = remote.commit;
  const toTimestamp = remote.committedAt;
  const provenanceWasUnknown = inspection.status === "unknown-provenance";

  if (inspection.status === "up-to-date") {
    return {
      name,
      outcome: "already-up-to-date",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun,
      provenanceWasUnknown: false,
    };
  }

  if (dryRun) {
    return {
      name,
      outcome: "would-upgrade",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun: true,
      provenanceWasUnknown,
    };
  }

  const result = await installPlugin(
    { name, force: true },
    {
      fetch: deps.fetch,
      workspacePluginsDir: deps.workspacePluginsDir,
      runGit: deps.runGit,
      runPostinstall: deps.runPostinstall,
      runInstallDeps: deps.runInstallDeps,
    },
  );

  return {
    name,
    outcome: "upgraded",
    fromCommit,
    fromTimestamp,
    toCommit: result.commit ?? toCommit,
    toTimestamp: result.committedAt ?? toTimestamp,
    target: result.target,
    fileCount: result.fileCount,
    dryRun: false,
    provenanceWasUnknown,
  };
}

/**
 * Upgrade a plugin the marketplace does not claim by re-fetching its recorded
 * GitHub source — the untrusted-direct-install analogue of the marketplace
 * upgrade above.
 *
 * A direct install records the exact owner/repo/path/ref it was cloned from in
 * its `install-meta.json`. Its "latest" is whatever that ref currently
 * resolves to, so the upgrade target is {@link resolveRefCommit} of the
 * recorded ref — a branch / tag / `HEAD` moves as upstream does. An install
 * pinned to an immutable full SHA has no later revision of that SHA to advance
 * to, so rather than freezing forever it follows the repo's default branch
 * ({@link DEFAULT_DIRECT_REF}); the first upgrade that advances re-records
 * that tracking ref, so later upgrades follow the branch through the ordinary
 * path with no SHA special-casing. The move is then materialized verbatim,
 * with no curated adapter overlay, exactly as the original untrusted install
 * was.
 *
 * Throws {@link PluginNotUpgradableError} when no resolvable GitHub source was
 * recorded (a manually-copied install), {@link PluginNotFoundError} when the
 * recorded ref (or the followed default branch) has vanished from the remote,
 * and {@link PluginSourceUnavailableError} on a transient source outage.
 */
async function directUpgrade(
  ctx: {
    readonly name: string;
    readonly local: PluginLocalInfo;
    readonly dryRun: boolean;
  },
  deps: UpgradePluginDeps,
): Promise<PluginUpgradeResult> {
  const { name, local, dryRun } = ctx;
  const source = local.source;
  // Without resolvable GitHub coordinates in the provenance sidecar (a
  // manually-copied install, or a sidecar naming a non-github source) there is
  // nothing to re-fetch.
  if (!source || source.kind !== "github" || !source.owner || !source.repo) {
    throw new PluginNotUpgradableError(
      name,
      "it has no marketplace entry and no recorded GitHub source to re-fetch from",
    );
  }
  // An install pinned to an immutable full SHA has no later revision of that
  // SHA to advance to. Rather than make `upgrade` a permanent no-op, follow
  // the repo's default branch (DEFAULT_DIRECT_REF, "HEAD") instead — a direct
  // install is already the untrusted path that fetches and imports mutable-ref
  // code. The first upgrade that advances re-records this tracking ref, so
  // later upgrades follow the branch through the ordinary branch/tag/HEAD path
  // with no SHA special-casing.
  const trackingRef = isFullCommitSha(source.ref)
    ? DEFAULT_DIRECT_REF
    : source.ref;
  const fetchSource: PluginFetchSource = {
    owner: source.owner,
    repo: source.repo,
    rootPath: source.path ?? "",
    ref: trackingRef,
  };

  const fromCommit = local.commit;
  const fromTimestamp = local.committedAt;
  const provenanceWasUnknown = fromCommit === null;

  // Resolve what the tracking ref points at now, without cloning.
  const toCommit = await resolveRefCommit(fetchSource, deps.runGit);
  if (toCommit === null) {
    // The recorded ref is gone from the remote (deleted branch / tag) or the
    // repo is unreachable as a hard failure — there is no revision to move to.
    throw new PluginNotFoundError(
      name,
      fetchSource.ref,
      `${fetchSource.owner}/${fetchSource.repo}`,
    );
  }

  if (
    fromCommit !== null &&
    toCommit.toLowerCase() === fromCommit.toLowerCase()
  ) {
    return {
      name,
      outcome: "already-up-to-date",
      fromCommit,
      fromTimestamp,
      toCommit,
      // The ref still points at the installed commit, so the "to" version is
      // the "from" version — reuse its recorded timestamp over a fresh fetch.
      toTimestamp: fromTimestamp,
      target: local.target,
      fileCount: null,
      dryRun,
      provenanceWasUnknown: false,
    };
  }

  if (dryRun) {
    // Preview: resolve the target commit's date the same way `plugins inspect`
    // does, so the dry run shows the human-readable version it would move to.
    const toTimestamp = await fetchCommitDate(
      `${fetchSource.owner}/${fetchSource.repo}`,
      toCommit,
      deps.fetch,
    );
    return {
      name,
      outcome: "would-upgrade",
      fromCommit,
      fromTimestamp,
      toCommit,
      toTimestamp,
      target: local.target,
      fileCount: null,
      dryRun: true,
      provenanceWasUnknown,
    };
  }

  // Re-install the recorded direct source verbatim, moving to whatever its
  // tracking ref now resolves to. Untrusted — no curated adapter overlay, just
  // as the original direct install was materialized. The tracking ref (not the
  // resolved SHA) is what gets re-recorded, so the next upgrade keeps
  // following the branch.
  const result = await installPlugin(
    { name, force: true, directSource: fetchSource },
    {
      fetch: deps.fetch,
      workspacePluginsDir: deps.workspacePluginsDir,
      runGit: deps.runGit,
      runPostinstall: deps.runPostinstall,
      runInstallDeps: deps.runInstallDeps,
    },
  );

  return {
    name,
    outcome: "upgraded",
    fromCommit,
    fromTimestamp,
    toCommit: result.commit ?? toCommit,
    toTimestamp: result.committedAt,
    target: result.target,
    fileCount: result.fileCount,
    dryRun: false,
    provenanceWasUnknown,
  };
}
