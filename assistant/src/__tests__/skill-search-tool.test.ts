import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const stubLogger = () =>
  new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  });
mock.module("../util/logger.js", () => ({
  getLogger: stubLogger,
  getCliLogger: stubLogger,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
  truncateForLog: (s: unknown) => String(s),
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
}));

// Mock the first-party catalog cache so the tool never touches the network.
// Tests control the catalog contents via `mockCatalogEntries`.
let mockCatalogEntries: Array<Record<string, unknown>> = [];
mock.module("../skills/catalog-cache.js", () => ({
  getCatalog: () => Promise.resolve(mockCatalogEntries),
  getCachedCatalogSync: () => mockCatalogEntries,
  invalidateCatalogCache: () => {},
}));

const { rankSkillSearchCandidates, tokenize } =
  await import("../tools/skills/search.js");
const { getTool } = await import("../tools/registry.js");

function writeSkill(skillId: string, name: string, description: string): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nBody.\n`,
  );
}

function writeMarketplaceCache(
  address: string,
  items: Array<{ id: string; name: string; description: string }>,
): void {
  const cacheDir = join(TEST_DIR, "marketplace-cache");
  mkdirSync(cacheDir, { recursive: true });
  const fileName = `${address.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
  writeFileSync(
    join(cacheDir, fileName),
    JSON.stringify({
      version: 1,
      address,
      kind: "github",
      ref: "main",
      fetchedAt: Date.now(),
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        displayName: item.name,
        description: item.description,
        source: address,
        sourceLabel: address,
        skillPath: item.name,
        ref: "main",
        capabilities: { secrets: [], connectors: [], network: [], writes: [] },
      })),
    }),
  );
}

async function executeSkillSearch(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_search");
  if (!tool) throw new Error("skill_search tool was not registered");

  const result = await tool.execute(input, {
    workingDir: "/tmp",
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

describe("skill_search ranking", () => {
  test("tokenize lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Video-Studio: edit clips!")).toEqual([
      "video",
      "studio",
      "edit",
      "clips",
    ]);
  });

  test("returns the obvious skill first for a clear query", () => {
    const candidates = [
      {
        id: "video-studio",
        name: "video-studio",
        displayName: "Video Studio",
        description: "Produce complete videos with scenes and narration",
        availability: "installed" as const,
      },
      {
        id: "spreadsheet-studio",
        name: "spreadsheet-studio",
        displayName: "Spreadsheet Studio",
        description: "Build xlsx spreadsheets with live formulas",
        availability: "installed" as const,
      },
      {
        id: "image-studio",
        name: "image-studio",
        displayName: "Image Studio",
        description: "Generate and edit images",
        availability: "installed" as const,
      },
    ];

    const ranked = rankSkillSearchCandidates(candidates, "make a video", 8);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].candidate.id).toBe("video-studio");
  });

  test("activation hints contribute to the score", () => {
    const candidates = [
      {
        id: "plain",
        name: "plain",
        displayName: "Plain",
        description: "Unrelated",
        availability: "installed" as const,
      },
      {
        id: "hinted",
        name: "hinted",
        displayName: "Hinted",
        description: "Unrelated",
        activationHints: ["use for kubernetes deploys"],
        availability: "installed" as const,
      },
    ];

    const ranked = rankSkillSearchCandidates(candidates, "kubernetes", 8);
    expect(ranked.length).toBe(1);
    expect(ranked[0].candidate.id).toBe("hinted");
  });

  test("installed outranks catalog on equal scores", () => {
    const candidates = [
      {
        id: "aardvark-tracker",
        name: "aardvark-tracker",
        displayName: "Aardvark Tracker",
        description: "Track aardvarks",
        availability: "catalog" as const,
      },
      {
        id: "zebra-tracker",
        name: "zebra-tracker",
        displayName: "Zebra Tracker",
        description: "Track zebras",
        availability: "installed" as const,
      },
    ];

    const ranked = rankSkillSearchCandidates(candidates, "tracker", 8);
    expect(ranked.length).toBe(2);
    expect(ranked[0].candidate.id).toBe("zebra-tracker");
  });

  test("respects the limit", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `gizmo-${i}`,
      name: `gizmo-${i}`,
      displayName: `Gizmo ${i}`,
      description: "A gizmo helper",
      availability: "installed" as const,
    }));

    const ranked = rankSkillSearchCandidates(candidates, "gizmo", 3);
    expect(ranked.length).toBe(3);
  });
});

describe("skill_search tool", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    mockCatalogEntries = [];
  });

  test("finds an installed skill and labels it [installed] with a skill_load hint", async () => {
    writeSkill(
      "quokka-census",
      "Quokka Census",
      "Count quokkas on Rottnest Island",
    );

    const result = await executeSkillSearch({ query: "quokka census" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Quokka Census (id: quokka-census)");
    expect(result.content).toContain("[installed]");
    expect(result.content).toContain(
      'call skill_load with skill "quokka-census"',
    );
  });

  test("labels catalog-only skills as installable via skill_load auto-install", async () => {
    mockCatalogEntries = [
      {
        id: "wombat-burrow-mapper",
        name: "wombat-burrow-mapper",
        description: "Map wombat burrows from satellite data",
        metadata: {
          vellum: { "display-name": "Wombat Burrow Mapper" },
        },
      },
    ];

    const result = await executeSkillSearch({ query: "wombat burrow" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Wombat Burrow Mapper (id: wombat-burrow-mapper)",
    );
    expect(result.content).toContain("[installable from catalog]");
    expect(result.content).toContain(
      'call skill_load with skill "wombat-burrow-mapper"',
    );
    expect(result.content).toContain("auto-installs from the catalog");
  });

  test("an installed skill also present in the catalog is reported once as installed", async () => {
    writeSkill("numbat-diary", "Numbat Diary", "Log numbat sightings");
    mockCatalogEntries = [
      {
        id: "numbat-diary",
        name: "numbat-diary",
        description: "Log numbat sightings",
        metadata: {},
      },
    ];

    const result = await executeSkillSearch({ query: "numbat diary" });
    expect(result.isError).toBe(false);
    const occurrences = result.content.match(/id: numbat-diary/g)?.length ?? 0;
    expect(occurrences).toBe(1);
    expect(result.content).toContain("[installed]");
    expect(result.content).not.toContain("[installable from catalog]");
  });

  test("includes cached marketplace entries with a UI-install hint", async () => {
    // "anthropics/skills" is an enabled built-in source seeded by loadSources().
    writeMarketplaceCache("anthropics/skills", [
      {
        id: "anthropics--skills--bilby-relocator",
        name: "bilby-relocator",
        description: "Plan bilby relocation logistics",
      },
    ]);

    const result = await executeSkillSearch({ query: "bilby relocation" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("anthropics--skills--bilby-relocator");
    expect(result.content).toContain("[marketplace:");
    expect(result.content).toContain(
      "Requires user install via the marketplace UI",
    );
    expect(result.content).toContain("skill_load will NOT auto-install it");
  });

  test("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      writeSkill(
        `pangolin-tool-${i}`,
        `Pangolin Tool ${i}`,
        "Pangolin scale analysis",
      );
    }

    const result = await executeSkillSearch({ query: "pangolin", limit: 2 });
    expect(result.isError).toBe(false);
    const matches = result.content.match(/id: pangolin-tool-\d/g) ?? [];
    expect(matches.length).toBe(2);
    expect(result.content).toContain("Found 2 skills");
  });

  test("returns a non-error guidance message when nothing matches", async () => {
    const result = await executeSkillSearch({
      query: "xyzzy-plugh-nothing-matches-this",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No skills matched");
  });

  test("rejects an empty query", async () => {
    const result = await executeSkillSearch({ query: "   " });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("rejects an invalid limit", async () => {
    const result = await executeSkillSearch({ query: "anything", limit: 0 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit must be");
  });
});
