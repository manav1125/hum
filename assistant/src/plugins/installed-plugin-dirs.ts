/**
 * Enumerate installed plugin directories under the workspace plugins dir.
 *
 * An installed plugin is a non-hidden directory carrying a `package.json`,
 * whose realpath stays under the realpath of the plugins directory. The walk
 * is shared by the schedule reconciler
 * (`../schedule/plugin-schedule-reconciler.ts`) and the plugin auto-update
 * sweep (`./auto-update.ts`) so both agree on what counts as an installed
 * plugin. Disabled-state and manifest validation are caller concerns.
 *
 * The containment half of that definition is exported on its own
 * ({@link isInsidePluginRoot}): a symlinked entry is judged by where it
 * points rather than by where it sits, so a link that escapes the plugins
 * directory is never reported as installed.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { getWorkspacePluginsDir } from "../util/platform.js";

export interface InstalledPluginDir {
  /** Directory basename: the plugin's install identity. */
  readonly name: string;
  /** Absolute path to the plugin directory. */
  readonly dir: string;
}

/**
 * True when `dir` resolves to a location strictly inside `root`.
 *
 * Both sides are resolved before the comparison. Resolving the candidate is
 * what judges a symlinked entry by where it points rather than by where it
 * sits; resolving the root is what keeps a root that itself sits behind a
 * symlinked path component (macOS `/tmp` to `/private/tmp`, a workspace under
 * a linked home) matching its own children. A link pointing at the root
 * itself is outside the boundary: it aliases the root, not a plugin.
 */
export function isInsidePluginRoot(dir: string, root: string): boolean {
  try {
    return realpathSync(dir).startsWith(realpathSync(root) + sep);
  } catch {
    // Unresolvable (dangling link, races with an uninstall, unreadable): not
    // provably contained, so it is not inside.
    return false;
  }
}

/**
 * List every installed plugin directory, sorted by the underlying readdir
 * order. A missing plugins directory yields `[]`. `pluginsDir` may be
 * overridden for tests.
 */
export function listInstalledPluginDirs(
  pluginsDir?: string,
): InstalledPluginDir[] {
  const root = pluginsDir ?? getWorkspacePluginsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // No plugins directory yet, so nothing installed.
    return [];
  }
  const out: InstalledPluginDir[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!isInsidePluginRoot(dir, root)) {
      continue;
    }
    if (!existsSync(join(dir, "package.json"))) {
      continue;
    }
    out.push({ name: entry, dir });
  }
  return out;
}
