/**
 * Opt-in unattended plugin upgrades.
 *
 * Ported from upstream 2ca872ad2b with its mandatory security companion
 * d1a3f49aec, re-based onto Cue's single-process daemon: upstream runs the
 * sweep in a separate resource-monitor process and asks the daemon to
 * upgrade over IPC; we have no monitor process, so the sweep runs on an
 * in-daemon timer (started from the plugin loader) and performs the upgrade
 * in-process, then hot-swaps the plugin through the existing
 * `reregisterExternalPlugin` reload path and re-reconciles declared
 * schedules.
 *
 * Opt-in is per plugin, recorded in
 * `<workspace>/plugins-data/plugin-auto-update.json` — deliberately outside
 * the plugin's install directory, which upgrades re-materialize, and
 * outside its `plugins-data/<name>/` storage dir, which the plugin itself
 * writes to. Nothing upgrades unattended unless a plugin's name is listed
 * there with `true`.
 *
 * Only plugins that come from the curated marketplace are swept
 * (upstream d1a3f49aec / ATL-1239). The catalog (`plugins/marketplace.json`)
 * pins every entry to an immutable full commit SHA that a curator reviewed,
 * so an unattended upgrade can only land code that passed that review —
 * "update available" in Cue's index-not-host marketplace model means the
 * catalog's pin SHA no longer equals the installed commit recorded in
 * `install-meta.json`. A plugin installed straight from a GitHub URL has no
 * such gate: its upgrade target is a mutable ref, so it is excluded from the
 * sweep (`not-in-marketplace` is not an upgradable status) and left for a
 * human running `assistant plugins upgrade`. An install whose recorded
 * source names a different repository or plugin root than the catalog entry
 * claiming its name is a direct install squatting on a curated name and is
 * skipped too, so it is never silently swapped for someone else's code.
 *
 * The curated boundary is enforced at the execution layer, not just the
 * filter: the sweep never calls the direct-upgrade path at all. It invokes
 * `installPlugin({ name, force: true })`, whose only source resolution is
 * the marketplace catalog — if the catalog entry disappears between the
 * inspection and the install, the install fails with `PluginNotFoundError`
 * instead of falling back to the install's mutable recorded ref (the
 * daemon-side enforcement upstream added with `marketplaceOnly`).
 *
 * The last completed sweep is stamped in the plugins-data dir, so a daemon
 * that restarts often still upgrades at most once per interval instead of
 * re-cloning on every boot.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  inspectPlugin as defaultInspectPlugin,
  type PluginInspection,
} from "../cli/lib/inspect-plugin.js";
import { installPlugin as defaultInstallPlugin } from "../cli/lib/install-from-github.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { isPluginDisabled } from "./disabled-state.js";
import { listInstalledPluginDirs } from "./installed-plugin-dirs.js";

const log = getLogger("plugin-auto-update");

// ── Opt-in store ────────────────────────────────────────────────────────

export const AUTO_UPDATE_CONFIG_FILENAME = "plugin-auto-update.json";

interface AutoUpdateConfigFile {
  version: 1;
  /** Install name → opted in. Absent names are opted out. */
  plugins: Record<string, boolean>;
}

function autoUpdateConfigPath(dataDir?: string): string {
  return join(
    dataDir ?? join(getWorkspaceDir(), "plugins-data"),
    AUTO_UPDATE_CONFIG_FILENAME,
  );
}

function readAutoUpdateConfig(dataDir?: string): AutoUpdateConfigFile {
  try {
    const raw = JSON.parse(
      readFileSync(autoUpdateConfigPath(dataDir), "utf8"),
    ) as unknown;
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as AutoUpdateConfigFile).version === 1 &&
      typeof (raw as AutoUpdateConfigFile).plugins === "object" &&
      (raw as AutoUpdateConfigFile).plugins !== null
    ) {
      return raw as AutoUpdateConfigFile;
    }
  } catch {
    // Missing or unreadable: nothing opted in. A config that cannot be read
    // is not an invitation to upgrade anything.
  }
  return { version: 1, plugins: {} };
}

/** True when the user opted `name` into unattended upgrades. */
export function isAutoUpdateEnabled(name: string, dataDir?: string): boolean {
  return readAutoUpdateConfig(dataDir).plugins[name] === true;
}

/** Names currently opted into unattended upgrades. */
export function listAutoUpdatePlugins(dataDir?: string): string[] {
  return Object.entries(readAutoUpdateConfig(dataDir).plugins)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
    .sort();
}

/**
 * Record the per-plugin opt-in. `enabled: false` removes the entry so the
 * file only ever lists deliberate choices.
 */
export function setAutoUpdateEnabled(
  name: string,
  enabled: boolean,
  dataDir?: string,
): void {
  const config = readAutoUpdateConfig(dataDir);
  if (enabled) {
    config.plugins[name] = true;
  } else {
    delete config.plugins[name];
  }
  const path = autoUpdateConfigPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── Sweep ───────────────────────────────────────────────────────────────

/** Default interval between sweeps. */
export const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** How often the loop re-tests whether a sweep is due. */
const DUE_POLL_INTERVAL_MS = 60_000;

/**
 * Delay before the first due-check: the daemon is still migrating and
 * loading plugins at boot; there is nothing to upgrade into until it is up.
 */
const BOOT_DELAY_MS = 60_000;

const STAMP_FILENAME = "plugin-auto-update-last-run-at";

/**
 * Inspection verdicts worth upgrading.
 *
 * Both resolve to a curated marketplace pin, which is the only revision this
 * sweep is willing to move an install to. `update-available` is the obvious
 * one. `unknown-provenance` (an older or manually-copied install with no
 * recorded commit) is included because an upgrade re-pins it to that same
 * curated commit, which is how it stops being unknown.
 *
 * Everything else is skipped: `up-to-date` has nowhere to move,
 * `remote-unavailable` means the catalog could not be read so an upgrade
 * would fail on the same outage a moment later, and `not-in-marketplace` is
 * the untrusted direct install whose only upgrade target is a mutable
 * upstream ref.
 */
const UPGRADABLE_STATUSES: ReadonlySet<string> = new Set([
  "update-available",
  "unknown-provenance",
]);

/**
 * Whether an installed copy actually tracks the curated source the sweep
 * would upgrade it to.
 *
 * The provenance sidecar records the owner/repo/path the install was
 * materialized from. When that names a different repository than the catalog
 * entry claiming the plugin's name, the install is a direct (untrusted) one
 * sitting on a curated name, and only its name lines up with the catalog.
 * The sweep leaves it alone: the user picked that source, and swapping it
 * for someone else's code is a call for a human running `assistant plugins
 * upgrade`, not for an unattended hourly pass.
 *
 * An install with no recorded source at all (an older or manually-copied
 * copy) is not disqualified. Nothing about it contradicts the catalog, and
 * re-pinning it to the curated commit is exactly how it gains provenance.
 */
export function tracksCuratedSource(inspection: PluginInspection): boolean {
  const source = inspection.local?.source;
  if (!source) {
    return true;
  }
  const remote = inspection.remote;
  if (!remote) {
    return false;
  }
  return (
    `${source.owner}/${source.repo}`.toLowerCase() ===
      remote.repo.toLowerCase() && (source.path ?? "") === remote.path
  );
}

/** Injectable seams; production values are the real modules. */
export interface PluginAutoUpdateDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly inspectPlugin?: typeof defaultInspectPlugin;
  readonly installPlugin?: typeof defaultInstallPlugin;
  readonly listInstalledPluginDirs?: typeof listInstalledPluginDirs;
  readonly isPluginDisabled?: typeof isPluginDisabled;
  /** Hot-swap the upgraded plugin into the live registry. */
  readonly reloadPlugin?: (name: string) => Promise<void>;
  /** Re-reconcile plugin-declared schedules after upgrades landed. */
  readonly reconcileSchedules?: () => Promise<void>;
  /** Override the workspace plugins directory (tests). */
  readonly workspacePluginsDir?: string;
  /** Override the plugins-data directory holding opt-in + stamp (tests). */
  readonly dataDir?: string;
  /** Override the sweep interval. */
  readonly checkIntervalMs?: number;
  readonly now?: () => number;
}

async function defaultReloadPlugin(name: string): Promise<void> {
  // Dynamic import: the daemon bootstrap statically imports this module's
  // siblings, so a static edge back into it would be a cycle.
  const { reregisterExternalPlugin } =
    await import("../daemon/external-plugins-bootstrap.js");
  await reregisterExternalPlugin(name);
}

async function defaultReconcileSchedules(): Promise<void> {
  const { reconcilePluginSchedules } =
    await import("../schedule/plugin-schedule-reconciler.js");
  await reconcilePluginSchedules();
}

function stampPath(deps: PluginAutoUpdateDeps): string {
  return join(
    deps.dataDir ?? join(getWorkspaceDir(), "plugins-data"),
    STAMP_FILENAME,
  );
}

/** Epoch millis of the last completed sweep, or `null` when never swept. */
function lastSweepAt(deps: PluginAutoUpdateDeps): number | null {
  try {
    return statSync(stampPath(deps)).mtimeMs;
  } catch {
    return null; // never swept, or an unreadable stamp — treat as due
  }
}

function stampSweep(deps: PluginAutoUpdateDeps): void {
  try {
    const path = stampPath(deps);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch (err) {
    log.warn({ err }, "Could not stamp the plugin auto-update sweep");
  }
}

/** What one sweep did, for logging and tests. */
export interface PluginAutoUpdateSweepResult {
  /** Why the sweep did no work, or `null` when it ran. */
  readonly skipped: "not-due" | "no-candidates" | null;
  readonly upgraded: readonly string[];
  readonly unchanged: readonly string[];
  readonly failed: readonly string[];
  /**
   * Installs the sweep refused to touch because they do not come from the
   * curated marketplace (direct GitHub installs, or a direct install
   * squatting on a curated name). They are not failures: a human can still
   * upgrade them with `assistant plugins upgrade`.
   */
  readonly skippedUntrusted: readonly string[];
}

const NOTHING: Omit<PluginAutoUpdateSweepResult, "skipped"> = {
  upgraded: [],
  unchanged: [],
  failed: [],
  skippedUntrusted: [],
};

/**
 * Run one sweep if any plugin is opted in and the interval has elapsed.
 *
 * Never throws: a plugin whose upgrade fails (source unreachable, catalog
 * entry vanished) is logged and skipped so one bad plugin cannot block the
 * rest, and the sweep is stamped regardless — a failure retries on the next
 * interval, not on the next minute.
 */
export async function runPluginAutoUpdateSweepIfDue(
  deps: PluginAutoUpdateDeps = {},
): Promise<PluginAutoUpdateSweepResult> {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  const lastRunAt = lastSweepAt(deps);
  if (lastRunAt !== null && now() - lastRunAt < intervalMs) {
    return { skipped: "not-due", ...NOTHING };
  }

  const listDirs = deps.listInstalledPluginDirs ?? listInstalledPluginDirs;
  const disabled = deps.isPluginDisabled ?? isPluginDisabled;
  const inspect = deps.inspectPlugin ?? defaultInspectPlugin;
  const install = deps.installPlugin ?? defaultInstallPlugin;
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);

  // Only opted-in, enabled installs are candidates. A disabled plugin is
  // deliberately left alone: the user switched it off, and upgrading it
  // would re-materialize code for something that isn't running.
  const optedIn = listDirs(deps.workspacePluginsDir)
    .map((p) => p.name)
    .filter(
      (name) =>
        isAutoUpdateEnabled(name, deps.dataDir) &&
        !disabled(name, deps.workspacePluginsDir),
    );

  if (optedIn.length === 0) {
    // Nothing opted in is a completed sweep; stamping avoids re-walking the
    // plugins dir every minute.
    stampSweep(deps);
    return { skipped: "no-candidates", ...NOTHING };
  }

  const candidates: string[] = [];
  const untrusted: string[] = [];
  for (const name of optedIn) {
    let inspection: PluginInspection;
    try {
      inspection = await inspect(
        { name },
        { fetch: fetchFn, workspacePluginsDir: deps.workspacePluginsDir },
      );
    } catch (err) {
      // An install whose drift cannot be classified (source unreachable,
      // rate-limited) is skipped rather than upgraded blind.
      log.debug({ err, name }, "Plugin auto-update could not inspect plugin");
      continue;
    }
    if (inspection.status === "not-in-marketplace") {
      // No catalog entry claims the name: the only thing to upgrade to is
      // whatever the recorded upstream ref points at right now. Excluded.
      untrusted.push(name);
      continue;
    }
    if (!UPGRADABLE_STATUSES.has(inspection.status)) {
      continue;
    }
    if (!tracksCuratedSource(inspection)) {
      untrusted.push(name);
      continue;
    }
    candidates.push(name);
  }

  if (untrusted.length > 0) {
    log.info(
      { plugins: untrusted },
      "Plugin auto-update skipped plugins that are not from the curated marketplace",
    );
  }
  if (candidates.length === 0) {
    stampSweep(deps);
    return {
      skipped: "no-candidates",
      ...NOTHING,
      skippedUntrusted: untrusted,
    };
  }

  const upgraded: string[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];

  // Sequential on purpose: each upgrade clones a repository and may install
  // dependencies, and the swapped plugin's lifecycle hooks run in-process.
  for (const name of candidates) {
    try {
      // Marketplace resolution only. `installPlugin` with no `directSource`
      // resolves the name through the catalog and throws PluginNotFoundError
      // when no entry claims it, so a catalog entry vanishing between the
      // inspection above and this call fails the upgrade instead of falling
      // back to the install's mutable recorded ref.
      const result = await install(
        { name, force: true },
        { fetch: fetchFn, workspacePluginsDir: deps.workspacePluginsDir },
      );
      upgraded.push(name);
      log.info(
        { name, to: result.commit, fileCount: result.fileCount },
        "Plugin auto-upgraded to the current marketplace pin",
      );
    } catch (err) {
      failed.push(name);
      log.warn({ err, name }, "Plugin auto-upgrade failed");
      continue;
    }
    try {
      await (deps.reloadPlugin ?? defaultReloadPlugin)(name);
    } catch (err) {
      log.warn(
        { err, name },
        "Plugin auto-upgrade landed on disk but hot-reload failed — the new version loads on next restart",
      );
    }
  }

  if (upgraded.length > 0) {
    try {
      await (deps.reconcileSchedules ?? defaultReconcileSchedules)();
    } catch (err) {
      log.warn({ err }, "Post-upgrade schedule reconcile failed");
    }
  }

  stampSweep(deps);
  log.info(
    {
      upgraded: upgraded.length,
      unchanged: unchanged.length,
      failed: failed.length,
      skippedUntrusted: untrusted.length,
    },
    "Plugin auto-update sweep complete",
  );

  return {
    skipped: null,
    upgraded,
    unchanged,
    failed,
    skippedUntrusted: untrusted,
  };
}

// ── Worker loop ─────────────────────────────────────────────────────────

/** Handle for the running auto-update loop. */
export interface PluginAutoUpdateHandle {
  stop(): void;
}

let inFlight = false;

/**
 * Guarded sweep: a sweep can outlive the poll interval, and two concurrent
 * sweeps would upgrade the same plugin twice.
 */
async function tick(): Promise<void> {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    await runPluginAutoUpdateSweepIfDue();
  } catch (err) {
    log.warn({ err }, "Plugin auto-update sweep failed (non-fatal)");
  } finally {
    inFlight = false;
  }
}

let workerHandle: PluginAutoUpdateHandle | null = null;

/**
 * Start the auto-update loop. Idempotent: repeat calls reuse the running
 * loop. The timer runs regardless of opt-in state — the sweep reads the
 * opt-in file each pass, so opting a plugin in takes effect within one poll
 * instead of at the next daemon restart. Timers are unref'd so the loop
 * never keeps the process alive.
 */
export function startPluginAutoUpdateWorker(): PluginAutoUpdateHandle {
  if (workerHandle) {
    return workerHandle;
  }
  const bootTimer = setTimeout(() => void tick(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  const pollTimer = setInterval(() => void tick(), DUE_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  workerHandle = {
    stop() {
      clearTimeout(bootTimer);
      clearInterval(pollTimer);
      workerHandle = null;
    },
  };
  return workerHandle;
}
