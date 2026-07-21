/**
 * Tests for the pure helpers of the plugin embedding seed. The Qdrant upsert
 * path is not exercised here (it needs a live embedding backend + collection);
 * these cover the slug/content shaping that puts plugins in the shared
 * `plugins/` namespace, disjoint from the skills `skills/` namespace.
 */

import { describe, expect, test } from "bun:test";

import {
  buildPluginEmbeddingContent,
  isPluginSlug,
  PLUGIN_SLUG_PREFIX,
  pluginSlugSuffixFor,
} from "../embedding-seed.js";

describe("pluginSlugSuffixFor", () => {
  test("lowercases to a slug-safe suffix (hyphens preserved, like skill-store)", () => {
    expect(
      pluginSlugSuffixFor("AnitaKirkovska--model-router--model-router"),
    ).toBe("anitakirkovska--model-router--model-router");
  });

  test("collapses non-slug characters (dots, spaces) to a hyphen", () => {
    expect(pluginSlugSuffixFor("Owner/Repo.Name")).toBe("owner-repo-name");
  });

  test("returns null when nothing slug-safe remains", () => {
    expect(pluginSlugSuffixFor("!!!")).toBeNull();
  });
});

describe("isPluginSlug / prefix disjointness from skills", () => {
  test("recognizes the plugins/ prefix", () => {
    expect(isPluginSlug(`${PLUGIN_SLUG_PREFIX}foo`)).toBe(true);
  });

  test("does not claim skills/ slugs (so the two seeders never prune each other)", () => {
    expect(isPluginSlug("skills/foo")).toBe(false);
    expect(isPluginSlug("skills/marketplace/foo")).toBe(false);
  });
});

describe("buildPluginEmbeddingContent", () => {
  test("includes name, description, surfaces, and install hint", () => {
    const content = buildPluginEmbeddingContent({
      name: "model-router",
      description: "Route each turn.",
      surfaces: ["hooks"],
      reviewStatus: "community",
    });
    expect(content).toContain("model-router");
    expect(content).toContain("Route each turn.");
    expect(content).toContain("Surfaces: hooks");
    expect(content).toContain("plugins install model-router");
  });

  test("caps content length at 1500 chars", () => {
    const content = buildPluginEmbeddingContent({
      name: "x",
      description: "z".repeat(5000),
      surfaces: [],
      reviewStatus: "curated",
    });
    expect(content.length).toBeLessThanOrEqual(1500);
  });
});
