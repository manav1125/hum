/**
 * Skill-catalog behavior for the advisor context pack: the section must list
 * only skills the conversation can actually load (mirroring the `skill_load`
 * feature-flag gate), surface activation hints, and prefer the conversation's
 * warm `skillProjectionCache.catalog` over a fresh on-disk scan.
 *
 * Mocks spread the real modules and override only the seams under test
 * (assistant/CLAUDE.md: never write an exhaustive `mock.module` factory).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { TrustContext } from "../daemon/trust-context.js";

function skill(
  overrides: Partial<SkillSummary> & { id: string },
): SkillSummary {
  return {
    name: overrides.id,
    displayName: overrides.id,
    description: "",
    directoryPath: `/skills/${overrides.id}`,
    skillFilePath: `/skills/${overrides.id}/SKILL.md`,
    source: "bundled",
    ...overrides,
  } as SkillSummary;
}

let diskCatalog: SkillSummary[] = [];
let warmCatalog: SkillSummary[] | undefined;
let flagEnabled = false;

const actualSkills = await import("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...actualSkills,
  loadSkillCatalog: () => diskCatalog,
}));

const actualFlags = await import("../config/assistant-feature-flags.js");
mock.module("../config/assistant-feature-flags.js", () => ({
  ...actualFlags,
  isAssistantFeatureFlagEnabled: () => flagEnabled,
}));

const actualLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () =>
    ({
      memory: { retrieval: { scratchpadInjection: { enabled: false } } },
    }) as ReturnType<typeof actualLoader.getConfig>,
}));

const actualRegistry = await import("../daemon/conversation-registry.js");
mock.module("../daemon/conversation-registry.js", () => ({
  ...actualRegistry,
  findConversationOrSubagent: () =>
    warmCatalog
      ? ({ skillProjectionCache: { catalog: warmCatalog } } as ReturnType<
          typeof actualRegistry.findConversationOrSubagent
        >)
      : undefined,
}));

// Keep the other sections empty so the assertions isolate the skills catalog.
const actualTrust = await import("../daemon/trust-context.js");
mock.module("../daemon/trust-context.js", () => ({
  ...actualTrust,
  isPersonalMemoryAllowed: () => false,
}));
const actualWorkspace = await import("../daemon/conversation-workspace.js");
mock.module("../daemon/conversation-workspace.js", () => ({
  ...actualWorkspace,
  resolveWorkspaceTopLevelContext: () => null,
}));
const actualRuntimeAssembly =
  await import("../daemon/conversation-runtime-assembly.js");
mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  ...actualRuntimeAssembly,
  buildActiveDocuments: () => null,
}));

const { buildAdvisorContext } = await import("./consult-context.js");

const baseSources = {
  conversationId: "c1",
  workingDir: "/tmp/does-not-exist-consult-skills",
  trust: { sourceChannel: "vellum", trustClass: "guardian" } as TrustContext,
};

beforeEach(() => {
  diskCatalog = [];
  warmCatalog = undefined;
  flagEnabled = false;
});

describe("advisor context pack: skill catalog", () => {
  test("omits flag-gated skills whose flag is off, mirroring skill_load", async () => {
    diskCatalog = [
      skill({ id: "plain-skill", description: "Always loadable." }),
      skill({
        id: "flag-off-skill",
        description: "Flag-gated skill.",
        featureFlag: "some-flag",
      }),
    ];
    const ctx = (await buildAdvisorContext(baseSources)) ?? "";
    expect(ctx).toContain("## Available skills");
    expect(ctx).toContain("plain-skill");
    expect(ctx).not.toContain("flag-off-skill");
  });

  test("includes flag-gated skills when the flag is on, with activation hints", async () => {
    flagEnabled = true;
    diskCatalog = [
      skill({
        id: "flagged-skill",
        description: "Flag-gated skill. Second sentence never shown.",
        featureFlag: "some-flag",
        activationHints: ["user asks for X", "task mentions Y"],
      }),
    ];
    const ctx = (await buildAdvisorContext(baseSources)) ?? "";
    expect(ctx).toContain("flagged-skill");
    expect(ctx).toContain("use when: user asks for X; task mentions Y");
    expect(ctx).not.toContain("Second sentence never shown");
  });

  test("prefers the conversation's warm catalog over a fresh disk scan", async () => {
    warmCatalog = [skill({ id: "warm-skill", description: "From the cache." })];
    diskCatalog = [skill({ id: "disk-skill", description: "From a rescan." })];
    const ctx = (await buildAdvisorContext(baseSources)) ?? "";
    expect(ctx).toContain("warm-skill");
    expect(ctx).not.toContain("disk-skill");
  });

  test("a threaded-in catalog wins over both", async () => {
    warmCatalog = [skill({ id: "warm-skill" })];
    diskCatalog = [skill({ id: "disk-skill" })];
    const ctx =
      (await buildAdvisorContext({
        ...baseSources,
        skillCatalog: [skill({ id: "threaded-skill" })],
      })) ?? "";
    expect(ctx).toContain("threaded-skill");
    expect(ctx).not.toContain("warm-skill");
    expect(ctx).not.toContain("disk-skill");
  });
});
