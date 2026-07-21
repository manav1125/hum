/**
 * Tests for the registry browse/search catalog projection. The bundled catalog
 * is injected via `$CUE_PLUGIN_REGISTRY_FILE` pointing at a temp fixture — the
 * same seam the CLI search + embedding seed use — so no globals are patched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listRegistryCatalog } from "../catalog.js";

const FIXTURE = {
  version: 1,
  name: "test-registry",
  sources: [
    {
      address: "vellum-ai/simple-memory",
      kind: "github",
      enabled: true,
      builtIn: true,
      reviewStatus: "curated",
    },
  ],
  plugins: [
    {
      name: "simple-memory",
      source: {
        source: "github",
        repo: "vellum-ai/simple-memory",
        ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
      },
      description: "Reference memory plugin.",
      category: "memory",
      homepage: "https://example.com/simple-memory",
      license: "MIT",
      reviewStatus: "curated",
      surfaces: ["hooks", "tools"],
    },
    {
      name: "caveman",
      source: {
        source: "github",
        repo: "JuliusBrussee/caveman",
        ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
        path: "packages/caveman",
      },
      description: "Ultra-compressed communication mode.",
      reviewStatus: "community",
      icon: "🦴",
      surfaces: ["hooks"],
    },
    {
      // A minimal entry: no category/homepage/license/icon/surfaces declared.
      name: "bare",
      source: {
        source: "github",
        repo: "acme/bare",
        ref: "1111111111111111111111111111111111111111",
      },
      description: "Bare entry.",
      reviewStatus: "curated",
    },
  ],
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cue-plugin-catalog-"));
  const file = join(tmp, "registry.json");
  writeFileSync(file, JSON.stringify(FIXTURE), "utf-8");
  process.env.CUE_PLUGIN_REGISTRY_FILE = file;
});

afterEach(() => {
  delete process.env.CUE_PLUGIN_REGISTRY_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

describe("listRegistryCatalog", () => {
  test("projects every curated entry, sorted alphabetically by name", () => {
    const catalog = listRegistryCatalog();
    expect(catalog.map((m) => m.name)).toEqual([
      "bare",
      "caveman",
      "simple-memory",
    ]);
  });

  test("carries the rich curation metadata for a full entry", () => {
    const memory = listRegistryCatalog().find(
      (m) => m.name === "simple-memory",
    );
    expect(memory).toEqual({
      name: "simple-memory",
      path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
      description: "Reference memory plugin.",
      source: {
        kind: "github",
        repo: "vellum-ai/simple-memory",
        ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
      },
      reviewStatus: "curated",
      surfaces: ["hooks", "tools"],
      category: "memory",
      license: "MIT",
      homepage: "https://example.com/simple-memory",
      icon: null,
    });
  });

  test("includes a repo subpath in both the locator and the source", () => {
    const caveman = listRegistryCatalog().find((m) => m.name === "caveman");
    expect(caveman?.path).toBe(
      "github:JuliusBrussee/caveman/packages/caveman@63a91ecadbf4c4719a4602a5abb00883f9966034",
    );
    expect(caveman?.source).toEqual({
      kind: "github",
      repo: "JuliusBrussee/caveman",
      ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
      path: "packages/caveman",
    });
    expect(caveman?.reviewStatus).toBe("community");
    expect(caveman?.icon).toBe("🦴");
  });

  test("nulls absent optional fields and defaults surfaces to []", () => {
    const bare = listRegistryCatalog().find((m) => m.name === "bare");
    expect(bare?.category).toBeNull();
    expect(bare?.license).toBeNull();
    expect(bare?.homepage).toBeNull();
    expect(bare?.icon).toBeNull();
    expect(bare?.surfaces).toEqual([]);
  });
});
