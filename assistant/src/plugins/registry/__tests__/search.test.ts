/**
 * Tests for plugin registry search — the deterministic token-overlap ranker
 * (mirrors skill_search) and the curated-entry collector. The bundled catalog
 * is injected via `$CUE_PLUGIN_REGISTRY_FILE`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  collectPluginCandidates,
  type PluginSearchCandidate,
  rankPluginCandidates,
  searchPluginRegistry,
} from "../search.js";

function candidate(
  over: Partial<PluginSearchCandidate> & { name: string },
): PluginSearchCandidate {
  return {
    id: over.name,
    displayName: over.name,
    description: "",
    source: "owner/repo",
    reviewStatus: "curated",
    availability: "curated",
    surfaces: [],
    ...over,
  };
}

describe("rankPluginCandidates", () => {
  test("ranks name matches above description matches", () => {
    const cands = [
      candidate({ name: "coffee-tracker", description: "unrelated" }),
      candidate({ name: "budget", description: "track your model routing" }),
      candidate({ name: "model-router", description: "route each turn" }),
    ];
    const ranked = rankPluginCandidates(cands, "model router", 10);
    expect(ranked[0].candidate.name).toBe("model-router");
  });

  test("returns nothing for a stopword-only query", () => {
    const cands = [candidate({ name: "x", description: "the a of to" })];
    expect(rankPluginCandidates(cands, "the a of", 10)).toHaveLength(0);
  });

  test("respects the limit", () => {
    const cands = Array.from({ length: 5 }, (_, i) =>
      candidate({ name: `router-${i}`, description: "model router" }),
    );
    expect(rankPluginCandidates(cands, "router", 3)).toHaveLength(3);
  });

  test("breaks score ties by review status then name", () => {
    const cands = [
      candidate({
        name: "b-router",
        description: "router",
        reviewStatus: "community",
      }),
      candidate({
        name: "a-router",
        description: "router",
        reviewStatus: "curated",
      }),
    ];
    const ranked = rankPluginCandidates(cands, "router", 10);
    expect(ranked[0].candidate.name).toBe("a-router");
  });
});

describe("collectPluginCandidates + searchPluginRegistry (with fixture)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cue-plugin-search-"));
    const file = join(tmp, "registry.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sources: [],
        plugins: [
          {
            name: "model-router",
            source: { source: "github", repo: "a/model-router", ref: "abc" },
            description: "Route each turn to a model chosen by intent.",
            reviewStatus: "community",
            surfaces: ["hooks"],
          },
          {
            name: "agent-wrapped",
            source: { source: "github", repo: "b/agent-wrapped", ref: "def" },
            description: "Your agent's year in review.",
            reviewStatus: "curated",
            surfaces: ["tools"],
          },
        ],
      }),
      "utf-8",
    );
    process.env.CUE_PLUGIN_REGISTRY_FILE = file;
  });
  afterEach(() => {
    delete process.env.CUE_PLUGIN_REGISTRY_FILE;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("collects curated entries from the registry", () => {
    const cands = collectPluginCandidates();
    expect(cands.map((c) => c.name).sort()).toEqual([
      "agent-wrapped",
      "model-router",
    ]);
    expect(cands.every((c) => c.availability === "curated")).toBe(true);
  });

  test("end-to-end search finds a curated plugin by intent", () => {
    const ranked = searchPluginRegistry("route model by intent", { limit: 5 });
    expect(ranked[0].candidate.name).toBe("model-router");
  });
});
