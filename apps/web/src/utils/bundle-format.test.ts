/**
 * The export extension is `.cue`, but the import filter must stay wider than
 * the export: bundles written before the rename are still on disk, and the
 * daemon reads the bytes without consulting the filename — so a picker that
 * only offered `.cue` would grey out files that import perfectly well.
 */

import { describe, expect, test } from "bun:test";

import {
  BUNDLE_ACCEPT,
  BUNDLE_EXTENSION,
  bundleFilename,
} from "./bundle-format";

describe("bundle format", () => {
  test("exports carry the .cue extension", () => {
    expect(BUNDLE_EXTENSION).toBe(".cue");
    expect(bundleFilename("Cue Success Dashboard")).toBe(
      "Cue Success Dashboard.cue",
    );
  });

  test("the import filter still accepts pre-rename bundles", () => {
    const accepted = BUNDLE_ACCEPT.split(",").map((s) => s.trim());
    expect(accepted).toContain(".cue");
    expect(accepted).toContain(".vellum");
  });

  test("path characters are replaced so the reported name is the saved name", () => {
    // These used to diverge: the file was sanitised, the toast was not.
    expect(bundleFilename('Q3/Q4: "plan"')).toBe("Q3_Q4_ _plan_.cue");
  });

  test("a name that sanitises away still produces a usable filename", () => {
    expect(bundleFilename("   ")).toBe("App.cue");
    expect(bundleFilename("")).toBe("App.cue");
  });
});
