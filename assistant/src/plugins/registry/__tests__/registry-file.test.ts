/**
 * Tests for the plugin registry file loader. The bundled catalog is injected
 * via `$CUE_PLUGIN_REGISTRY_FILE` pointing at a temp fixture; workspace source
 * overrides live under the per-test temp workspace dir and are cleaned between
 * cases. No globals are monkey-patched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addSource,
  findRegistryPlugin,
  getSourceOverridesPath,
  loadBundledRegistry,
  loadRegistryPlugins,
  loadSources,
  normalizeGithubAddress,
  setSourceEnabled,
} from "../registry-file.js";

const FIXTURE = {
  version: 1,
  name: "test-registry",
  sources: [
    {
      address: "vellum-ai/simple-memory",
      kind: "github",
      label: "builtin",
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
      reviewStatus: "curated",
      surfaces: ["hooks", "tools"],
    },
  ],
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cue-plugin-registry-"));
  const file = join(tmp, "registry.json");
  writeFileSync(file, JSON.stringify(FIXTURE), "utf-8");
  process.env.CUE_PLUGIN_REGISTRY_FILE = file;
  // Ensure a clean override file per test.
  const overrides = getSourceOverridesPath();
  if (existsSync(overrides)) rmSync(overrides, { force: true });
});

afterEach(() => {
  delete process.env.CUE_PLUGIN_REGISTRY_FILE;
  const overrides = getSourceOverridesPath();
  if (existsSync(overrides)) rmSync(overrides, { force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadBundledRegistry", () => {
  test("reads the file named by the env override", () => {
    const reg = loadBundledRegistry();
    expect(reg.plugins).toHaveLength(1);
    expect(reg.plugins[0].name).toBe("simple-memory");
    expect(reg.sources[0].builtIn).toBe(true);
  });

  test("finds a curated plugin by name", () => {
    expect(findRegistryPlugin("simple-memory")?.source.repo).toBe(
      "vellum-ai/simple-memory",
    );
    expect(findRegistryPlugin("does-not-exist")).toBeUndefined();
  });

  test("loadRegistryPlugins returns the pinned entries", () => {
    expect(loadRegistryPlugins().map((p) => p.name)).toEqual(["simple-memory"]);
  });
});

describe("source overrides", () => {
  test("addSource adds a new unreviewed source merged over the built-ins", () => {
    addSource({ address: "acme/my-plugin", label: "Acme" });
    const sources = loadSources();
    const acme = sources.find((s) => s.address === "acme/my-plugin");
    expect(acme?.enabled).toBe(true);
    expect(acme?.reviewStatus).toBe("unreviewed");
    // Built-in is still present.
    expect(sources.some((s) => s.address === "vellum-ai/simple-memory")).toBe(
      true,
    );
  });

  test("setSourceEnabled shadows a built-in source with a disabled override", () => {
    expect(setSourceEnabled("vellum-ai/simple-memory", false)).toBe(true);
    const builtin = loadSources().find(
      (s) => s.address === "vellum-ai/simple-memory",
    );
    expect(builtin?.enabled).toBe(false);
  });

  test("setSourceEnabled returns false for an unknown address", () => {
    expect(setSourceEnabled("nobody/nothing", true)).toBe(false);
  });
});

describe("normalizeGithubAddress", () => {
  test.each([
    ["owner/repo", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["github.com/owner/repo/tree/main", "owner/repo"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeGithubAddress(input)).toBe(expected);
  });

  test("rejects garbage", () => {
    expect(normalizeGithubAddress("not a repo")).toBeNull();
    expect(normalizeGithubAddress("owner")).toBeNull();
  });
});
