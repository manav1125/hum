/**
 * Tests for {@link ../plugin-catalog-resolve} — the gated resolver the HTTP
 * install-by-name route uses to map a name onto trusted install coordinates
 * from the SAME curated `plugins/registry.json` catalog the search/detail
 * routes read.
 *
 * The bundled catalog is injected via `$CUE_PLUGIN_REGISTRY_FILE` pointing at
 * a temp fixture — the same seam the catalog/search tests use — so no globals
 * are patched and nothing touches the network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RegistryCatalogMatch } from "../../../plugins/registry/catalog.js";
import {
  findCatalogEntry,
  resolvePluginSourceFromCatalog,
  resolveSourceFromMatch,
} from "../plugin-catalog-resolve.js";

const PIN_SHA = "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3";

const FIXTURE = {
  version: 1,
  name: "test-registry",
  sources: [],
  plugins: [
    {
      name: "simple-memory",
      source: {
        source: "github",
        repo: "vellum-ai/simple-memory",
        ref: PIN_SHA,
      },
      description: "Reference memory plugin.",
      reviewStatus: "curated",
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
    },
    {
      // A malformed row: the ref is a mutable branch, not a full commit SHA.
      // The registry file loader tolerates it (ref is any string), so the
      // resolver's schema validation is the gate that must refuse it.
      name: "branch-pinned",
      source: {
        source: "github",
        repo: "acme/branch-pinned",
        ref: "main",
      },
      description: "Entry pinned to a mutable ref.",
      reviewStatus: "community",
    },
  ],
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cue-plugin-catalog-resolve-"));
  const file = join(tmp, "registry.json");
  writeFileSync(file, JSON.stringify(FIXTURE), "utf-8");
  process.env.CUE_PLUGIN_REGISTRY_FILE = file;
});

afterEach(() => {
  delete process.env.CUE_PLUGIN_REGISTRY_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

/** A syntactically valid catalog match to mutate per-case. */
function match(
  overrides: Partial<RegistryCatalogMatch["source"]> = {},
): RegistryCatalogMatch {
  return {
    name: "simple-memory",
    path: `github:vellum-ai/simple-memory@${PIN_SHA}`,
    description: "Reference memory plugin.",
    source: {
      kind: "github",
      repo: "vellum-ai/simple-memory",
      ref: PIN_SHA,
      ...overrides,
    },
    reviewStatus: "curated",
    surfaces: [],
    category: null,
    license: null,
    homepage: null,
    icon: null,
  };
}

describe("findCatalogEntry", () => {
  test("finds the catalog entry claiming the name", () => {
    const entry = findCatalogEntry("simple-memory");
    expect(entry?.name).toBe("simple-memory");
    expect(entry?.source.ref).toBe(PIN_SHA);
  });

  test("returns null when no entry claims the name", () => {
    expect(findCatalogEntry("ghost")).toBeNull();
  });
});

describe("resolveSourceFromMatch", () => {
  test("projects a repo-root entry onto owner/repo coordinates", () => {
    expect(resolveSourceFromMatch(match())).toEqual({
      owner: "vellum-ai",
      repo: "simple-memory",
      path: "",
      ref: PIN_SHA,
    });
  });

  test("preserves a repo subpath", () => {
    const resolved = resolveSourceFromMatch(
      match({ path: "packages/caveman" }),
    );
    expect(resolved.path).toBe("packages/caveman");
  });

  test.each([
    ["slashless repo", { repo: "no-slash" }],
    ["over-segmented repo", { repo: "a/b/c" }],
    ["escaping path", { path: "../escape" }],
    ["empty path segment", { path: "a//b" }],
    ["mutable branch ref", { ref: "main" }],
    ["abbreviated SHA", { ref: "ed09a4c" }],
  ])("rejects a malformed source: %s", (_label, overrides) => {
    expect(() => resolveSourceFromMatch(match(overrides))).toThrow(
      /invalid source/,
    );
  });
});

describe("resolvePluginSourceFromCatalog", () => {
  test("resolves a catalog name to validated install coordinates", () => {
    expect(resolvePluginSourceFromCatalog("caveman")).toEqual({
      owner: "JuliusBrussee",
      repo: "caveman",
      path: "packages/caveman",
      ref: "63a91ecadbf4c4719a4602a5abb00883f9966034",
    });
  });

  test("returns null when the catalog does not claim the name", () => {
    expect(resolvePluginSourceFromCatalog("ghost")).toBeNull();
  });

  test("refuses a catalog row whose ref is not a full commit SHA", () => {
    // A mutable ref in the catalog must never become a trusted install
    // source — an upstream owner could repoint it at unreviewed code.
    expect(() => resolvePluginSourceFromCatalog("branch-pinned")).toThrow(
      /invalid source/,
    );
  });
});
