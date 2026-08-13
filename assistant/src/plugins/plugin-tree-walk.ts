/**
 * Shared plugin-tree walking rules.
 *
 * Subsystems that walk installed plugin trees must agree on what "the
 * plugin's tree" means. Today the schedule-declaration hasher
 * (`../schedule/plugin-schedule-declarations.ts`) is the consumer; the
 * walk mirrors upstream's shared walker so future ports (fingerprinting,
 * live-reload change detection) can adopt it without drift.
 *
 * Symlinks are never followed, at any depth: install never materializes
 * them, and following a symlinked directory would let a link like
 * `hooks/loop -> ..` cycle the walk or escape the plugin root entirely. A
 * plugin whose *root* is a symlink is supported by callers resolving the
 * root (`realpathSync`) before walking.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Top-level entries that are runtime-owned state rather than part of the
 * plugin's source tree at the pinned commit:
 *
 * - `install-meta.json` — provenance sidecar written at install time.
 * - `config.json` — user-editable plugin config.
 * - `data` — runtime data directory.
 * - `.disabled` — sentinel file written by the disable toggle.
 */
export const PRESERVED_ENTRIES = [
  "install-meta.json",
  "config.json",
  "data",
  ".disabled",
] as const;

/**
 * Directory names {@link walkPluginTree} skips at any depth, unconditionally.
 * `node_modules` holds a plugin's installed dependencies — derived from the
 * pinned `package.json` and re-installed on every (re)install and upgrade,
 * never tracked source.
 */
const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/** Options controlling which entries a {@link walkPluginTree} visits. */
export interface PluginTreeWalkOptions {
  /**
   * Entries to exclude. A `string` matches a top-level entry by name (e.g.
   * {@link PRESERVED_ENTRIES}); a `RegExp` matches any entry — at any depth —
   * by its POSIX path relative to the walk root, and when it matches a
   * directory the whole subtree is skipped.
   */
  readonly excludeRootEntries?: Iterable<string | RegExp>;
  /** Skip entries whose name starts with `.`, at any depth. */
  readonly excludeDotEntries?: boolean;
  /**
   * Skip directories that fail to read instead of throwing. Change
   * detection wants this (a tree being mutated mid-walk is retried on the
   * next pass); install fingerprinting does not (a vanished tree is an
   * error the caller must see).
   */
  readonly bestEffort?: boolean;
}

/**
 * Visit every regular file under `root`, depth-first in `readdir` order.
 * `rel` is the POSIX-style (forward-slash) path relative to `root`; `abs`
 * is the absolute path. Symlinked entries are never visited or followed.
 */
export function walkPluginTree(
  root: string,
  options: PluginTreeWalkOptions,
  visit: (rel: string, abs: string) => void,
): void {
  // Split the exclusion list: bare strings match a top-level entry name;
  // RegExps match an entry's relative path at any depth.
  const excludedRootNames = new Set<string>();
  const excludePatterns: RegExp[] = [];
  for (const entry of options.excludeRootEntries ?? []) {
    if (typeof entry === "string") {
      excludedRootNames.add(entry);
    } else {
      excludePatterns.push(entry);
    }
  }

  const walk = (relDir: string): void => {
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (options.bestEffort === true) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (relDir === "" && excludedRootNames.has(name)) {
        continue;
      }
      if (options.excludeDotEntries === true && name.startsWith(".")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      if (excludePatterns.some((pattern) => pattern.test(rel))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRS.has(name)) {
          continue;
        }
        walk(rel);
      } else if (entry.isFile()) {
        visit(rel, join(absDir, name));
      }
    }
  };

  walk("");
}
