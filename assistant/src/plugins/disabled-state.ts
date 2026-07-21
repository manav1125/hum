/**
 * Per-plugin enable/disable state, backed by a `.disabled` sentinel file.
 *
 * A plugin at `<workspacePluginsDir>/<name>/` is disabled iff a `.disabled`
 * file exists in its directory. The sentinel is read by `loadUserPlugins()`
 * once per boot, immediately before the plugin's directory would be imported.
 *
 * Contract: a `.disabled` plugin is NEVER loaded — none of its code runs (no
 * module evaluation, init, hooks, tools, routes, or shutdown). This is the
 * safety boundary for untrusted/direct-installed plugins: disabling one
 * guarantees it is inert on the next load.
 *
 * Timing: because the gate is at load time, toggling a plugin that is already
 * running takes effect on the next assistant restart — the same rule the
 * install / uninstall / upgrade paths already advertise. A plugin that has
 * been imported has already evaluated its module and run `init()`, so there is
 * no honest way to retroactively make it inert without a restart.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

/** The sentinel filename written into a plugin dir to mark it disabled. */
export const DISABLED_SENTINEL = ".disabled";

/**
 * True iff `<workspacePluginsDir>/<name>/.disabled` exists. The single source
 * of truth for whether a plugin's code is allowed to load. `pluginsDir` may be
 * overridden for tests.
 */
export function isPluginDisabled(name: string, pluginsDir?: string): boolean {
  const dir = pluginsDir ?? getWorkspacePluginsDir();
  return existsSync(join(dir, name, DISABLED_SENTINEL));
}

/** Absolute path of a plugin's `.disabled` sentinel (whether or not it exists). */
export function disabledSentinelPath(
  name: string,
  pluginsDir?: string,
): string {
  const dir = pluginsDir ?? getWorkspacePluginsDir();
  return join(dir, name, DISABLED_SENTINEL);
}
