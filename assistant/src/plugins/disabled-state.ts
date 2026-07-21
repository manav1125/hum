/**
 * Per-plugin enable/disable state, backed by a `.disabled` sentinel file.
 *
 * A plugin at `<workspacePluginsDir>/<name>/` is disabled iff a `.disabled`
 * file exists in its directory. The check is a synchronous `existsSync` read at
 * request/turn time by every surface that loads plugin code (hooks, tools,
 * routes, injectors), so toggling takes effect on the next turn without a
 * daemon restart.
 *
 * Contract: a `.disabled` plugin is NEVER loaded — none of its code runs (no
 * init, hooks, tools, routes, or shutdown). This is the safety boundary for
 * untrusted/direct-installed plugins: disabling one guarantees it is inert.
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
