/**
 * The Cue app-bundle file format — one definition of the extension, shared by
 * every surface that writes a bundle, names one, or offers to open one.
 *
 * Exports are written as `.cue`. Imports deliberately accept `.vellum` too:
 * bundles exported under the old name are still on people's disks, and the
 * daemon's import route reads the raw bytes without ever consulting the
 * filename — so rejecting the old extension in the file picker would grey out
 * files that import perfectly well. The extension is a label for humans, never
 * a validity check.
 */

/** Extension written by every export. */
export const BUNDLE_EXTENSION = ".cue";

/**
 * `accept` filter for bundle file inputs. Includes the pre-rename extension so
 * older exports stay openable.
 */
export const BUNDLE_ACCEPT = ".cue,.vellum";

/**
 * The filename a bundle export will actually be saved as.
 *
 * Built in one place so the toast that reports the export and the file that
 * lands on disk cannot disagree — they used to be composed separately, so an
 * app whose name contained a slash was saved sanitised but reported raw.
 */
export function bundleFilename(appName: string): string {
  const safeName = appName.replace(/[/\\:*?"<>|]/g, "_").trim() || "App";
  return `${safeName}${BUNDLE_EXTENSION}`;
}
