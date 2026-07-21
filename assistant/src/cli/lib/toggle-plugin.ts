/**
 * Enable / disable an installed plugin by writing or removing its `.disabled`
 * sentinel (see {@link ../../plugins/disabled-state}).
 *
 * Disabling is the safe way to neutralize an untrusted or misbehaving plugin
 * without deleting it: the sentinel is read at load time by every plugin
 * surface, so a disabled plugin's code never runs on the next turn. Enabling
 * removes the sentinel.
 *
 * The CLI commands `assistant plugins disable|enable <name>` are thin wrappers
 * that supply the live workspace directory and format the result.
 */

import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";

import {
  disabledSentinelPath,
  isPluginDisabled,
} from "../../plugins/disabled-state.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  InvalidPluginNameError,
  sanitizePluginName,
} from "./install-from-github.js";
import { PluginNotInstalledError } from "./uninstall-plugin.js";

export interface TogglePluginOptions {
  readonly name: string;
  /** Override the workspace plugins directory. Falls back to the live one. */
  readonly workspacePluginsDir?: string;
}

export interface TogglePluginResult {
  readonly name: string;
  /** State after the operation. */
  readonly disabled: boolean;
  /** True when the call actually changed the on-disk state. */
  readonly changed: boolean;
}

function assertInstalledDir(name: string, pluginsDir: string): string {
  const target = `${pluginsDir}/${name}`;
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new PluginNotInstalledError(name, target);
  }
  return target;
}

/** Write the `.disabled` sentinel so the plugin stops loading next turn. */
export function disablePlugin(opts: TogglePluginOptions): TogglePluginResult {
  const name = sanitizePluginName(opts.name);
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();
  assertInstalledDir(name, pluginsDir);

  if (isPluginDisabled(name, pluginsDir)) {
    return { name, disabled: true, changed: false };
  }
  writeFileSync(disabledSentinelPath(name, pluginsDir), "", "utf-8");
  return { name, disabled: true, changed: true };
}

/** Remove the `.disabled` sentinel so the plugin loads again next turn. */
export function enablePlugin(opts: TogglePluginOptions): TogglePluginResult {
  const name = sanitizePluginName(opts.name);
  const pluginsDir = opts.workspacePluginsDir ?? getWorkspacePluginsDir();
  assertInstalledDir(name, pluginsDir);

  if (!isPluginDisabled(name, pluginsDir)) {
    return { name, disabled: false, changed: false };
  }
  rmSync(disabledSentinelPath(name, pluginsDir), { force: true });
  return { name, disabled: false, changed: true };
}

// Re-exported so `local` CLI commands (e.g. `plugins list` / `plugins
// versions`) can read a plugin's enable/disable state through this cli/lib
// facade instead of importing daemon-internal `plugins/disabled-state.js`
// directly (the cli/no-daemon-internals boundary).
export { isPluginDisabled } from "../../plugins/disabled-state.js";
export { InvalidPluginNameError, PluginNotInstalledError };
