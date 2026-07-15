/**
 * Tests for `memory/v2/skill-content.ts` — v2-owned port of v1's
 * `buildSkillContent` plus the `mcp-setup` description augmentation.
 */
import { describe, expect, mock, test } from "bun:test";

import type { SkillCapabilityInput } from "../../../skills/skill-memory.js";

describe("buildSkillContent", () => {
  test("renders minimal input with id, displayName, description", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
    };
    expect(buildSkillContent(input)).toBe(
      'The "Example Skill" skill (example-skill) is available. Does an example thing.',
    );
  });

  test("includes both activationHints and avoidWhen clauses", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
      activationHints: ["user mentions example", "task involves examples"],
      avoidWhen: ["user is busy", "topic is unrelated"],
    };
    const out = buildSkillContent(input);
    expect(out).toContain(
      "Use when: user mentions example; task involves examples.",
    );
    expect(out).toContain("Avoid when: user is busy; topic is unrelated.");
  });

  test("caps output at 500 characters by default", async () => {
    const { buildSkillContent } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "x".repeat(1000),
    };
    const out = buildSkillContent(input);
    expect(out.length).toBeLessThanOrEqual(500);
  });

  test("honors a wider explicit cap for the embedding form", async () => {
    const { buildSkillContent, SKILL_EMBEDDING_CONTENT_MAX_CHARS } =
      await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "x".repeat(2000),
    };
    const out = buildSkillContent(input, SKILL_EMBEDDING_CONTENT_MAX_CHARS);
    expect(out.length).toBe(SKILL_EMBEDDING_CONTENT_MAX_CHARS);
  });
});

describe("buildSkillContents", () => {
  test("short form is capped while the embedding form keeps the full hint lists", async () => {
    const { buildSkillContents } = await import("../skill-content.js");
    // Enough hints that the combined prose passes 500 chars: the short form
    // must truncate, the embedding form must retain every hint verbatim.
    const activationHints = Array.from(
      { length: 12 },
      (_, i) => `user asks about scenario number ${i} involving many words`,
    );
    const avoidWhen = ["the final avoid-when hint must survive embedding"];
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
      activationHints,
      avoidWhen,
    };
    const { content, embeddingContent } = buildSkillContents(input);

    expect(content.length).toBeLessThanOrEqual(500);
    expect(embeddingContent.length).toBeLessThanOrEqual(1500);
    expect(embeddingContent.length).toBeGreaterThan(content.length);
    // Every hint — including the trailing avoid-when — is present in the
    // embedded form even though the short form truncated.
    for (const hint of activationHints) {
      expect(embeddingContent).toContain(hint);
    }
    expect(embeddingContent).toContain(
      "Avoid when: the final avoid-when hint must survive embedding.",
    );
    expect(content).not.toContain(
      "the final avoid-when hint must survive embedding",
    );
    // Same structure, same prefix — the embedding form is a superset render.
    expect(embeddingContent.startsWith(content)).toBe(true);
  });

  test("short and embedding forms are identical when under the short cap", async () => {
    const { buildSkillContents } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
      activationHints: ["user mentions example"],
    };
    const { content, embeddingContent } = buildSkillContents(input);
    expect(embeddingContent).toBe(content);
  });
});

describe("buildMarketplaceSkillContents", () => {
  test("states the skill is NOT installed and requires a marketplace install", async () => {
    const { buildMarketplaceSkillContents } =
      await import("../skill-content.js");
    const { content, embeddingContent } = buildMarketplaceSkillContents({
      id: "acme--tools--widgets",
      displayName: "Widgets",
      description: "Makes widgets",
      sourceLabel: "Acme tools",
    });
    for (const out of [content, embeddingContent]) {
      expect(out).toContain('The "Widgets" skill (acme--tools--widgets)');
      expect(out).toContain("skill marketplace");
      expect(out).toContain('from "Acme tools"');
      expect(out).toContain("NOT installed");
      expect(out).toContain("installed by the user via the marketplace UI");
    }
  });

  test("omits the source clause when no sourceLabel is given and caps both forms", async () => {
    const { buildMarketplaceSkillContents } =
      await import("../skill-content.js");
    const { content, embeddingContent } = buildMarketplaceSkillContents({
      id: "acme--tools--widgets",
      displayName: "Widgets",
      description: "x".repeat(2000),
    });
    expect(content).not.toContain('from "');
    expect(content.length).toBeLessThanOrEqual(500);
    expect(embeddingContent.length).toBeLessThanOrEqual(1500);
    expect(embeddingContent.startsWith(content)).toBe(true);
  });
});

describe("augmentMcpSetupDescription", () => {
  test("is a no-op when id is not mcp-setup", async () => {
    const { augmentMcpSetupDescription } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "example-skill",
      displayName: "Example Skill",
      description: "Does an example thing",
    };
    expect(augmentMcpSetupDescription(input)).toBe(input);
  });

  test("appends 'Configured: <names>' for mcp-setup with enabled servers", async () => {
    mock.module("../../../config/loader.js", () => ({
      getConfig: () => ({
        mcp: {
          servers: {
            "example-server": { enabled: true },
            "another-server": { enabled: true },
            "disabled-server": { enabled: false },
          },
        },
      }),
    }));
    const { augmentMcpSetupDescription } = await import("../skill-content.js");
    const input: SkillCapabilityInput = {
      id: "mcp-setup",
      displayName: "MCP Setup",
      description: "Configures MCP servers",
    };
    const out = augmentMcpSetupDescription(input);
    expect(out.description).toBe(
      "Configures MCP servers Configured: example-server, another-server",
    );
    expect(out.id).toBe("mcp-setup");
  });
});
