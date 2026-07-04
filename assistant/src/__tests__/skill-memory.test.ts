import { describe, expect, test } from "bun:test";

import type { SkillSummary } from "../config/skills.js";
import type { CatalogSkill } from "../skills/catalog-install.js";
import {
  fromCatalogSkill,
  fromSkillSummary,
  rebrandSkillDisplayText,
} from "../skills/skill-memory.js";

function makeSkillSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "test-skill",
    name: "test-skill",
    displayName: "Test Skill",
    description: "A skill for testing",
    directoryPath: "/skills/test-skill",
    skillFilePath: "/skills/test-skill/SKILL.md",
    source: "managed",
    ...overrides,
  };
}

// ─── fromSkillSummary ────────────────────────────────────────────────────────

describe("fromSkillSummary", () => {
  test("maps displayName from SkillSummary", () => {
    const entry = makeSkillSummary({ displayName: "Pretty Name" });
    const input = fromSkillSummary(entry);
    expect(input.displayName).toBe("Pretty Name");
  });

  test("maps activationHints from SkillSummary", () => {
    const hints = ["user asks to search", "needs web data"];
    const entry = makeSkillSummary({ activationHints: hints });
    const input = fromSkillSummary(entry);
    expect(input.activationHints).toEqual(hints);
  });

  test("leaves activationHints undefined when not present", () => {
    const entry = makeSkillSummary({ activationHints: undefined });
    const input = fromSkillSummary(entry);
    expect(input.activationHints).toBeUndefined();
  });

  test("maps avoidWhen from SkillSummary", () => {
    const cues = ["offline mode", "user wants local files only"];
    const entry = makeSkillSummary({ avoidWhen: cues });
    const input = fromSkillSummary(entry);
    expect(input.avoidWhen).toEqual(cues);
  });

  test("leaves avoidWhen undefined when not present", () => {
    const entry = makeSkillSummary({ avoidWhen: undefined });
    const input = fromSkillSummary(entry);
    expect(input.avoidWhen).toBeUndefined();
  });

  test("copies id and description directly", () => {
    const entry = makeSkillSummary({
      id: "my-id",
      description: "Does amazing things",
    });
    const input = fromSkillSummary(entry);
    expect(input.id).toBe("my-id");
    expect(input.description).toBe("Does amazing things");
  });

  test("maps custom managed skill metadata required by Memory V2 rendering", () => {
    const entry = makeSkillSummary({
      id: "geo-article-writer",
      name: "geo-article-writer",
      displayName: "Geo Article Writer",
      description: "Writes local geo articles",
      source: "managed",
      activationHints: ["user asks for local article drafts"],
      avoidWhen: ["user only wants citation extraction"],
    });

    const input = fromSkillSummary(entry);

    expect(input).toEqual({
      id: "geo-article-writer",
      displayName: "Geo Article Writer",
      description: "Writes local geo articles",
      activationHints: ["user asks for local article drafts"],
      avoidWhen: ["user only wants citation extraction"],
    });
  });
});

// ─── rebrand: Vellum → Cue in user-visible display text ──────────────────────

describe("rebrandSkillDisplayText", () => {
  test("rebrands multi-word product phrases", () => {
    expect(rebrandSkillDisplayText("Vellum OAuth Integrations")).toBe(
      "Cue OAuth Integrations",
    );
    expect(
      rebrandSkillDisplayText(
        "Connect a Telegram bot to the Vellum Assistant gateway",
      ),
    ).toBe("Connect a Telegram bot to the Cue gateway");
    expect(rebrandSkillDisplayText("the Vellum gateway")).toBe(
      "the Cue gateway",
    );
    expect(rebrandSkillDisplayText("the Vellum Assistant helps you")).toBe(
      "the Cue helps you",
    );
    expect(rebrandSkillDisplayText("built on the Vellum platform")).toBe(
      "built on the Cue",
    );
  });

  test("rebrands a bare standalone product name", () => {
    expect(rebrandSkillDisplayText("Powered by Vellum.")).toBe(
      "Powered by Cue.",
    );
  });

  test("leaves non-product text untouched", () => {
    expect(rebrandSkillDisplayText("Browse the web using commands")).toBe(
      "Browse the web using commands",
    );
  });
});

describe("rebrand applied through capability producers", () => {
  test("fromSkillSummary rebrands display prose but never the id", () => {
    const input = fromSkillSummary(
      makeSkillSummary({
        id: "vellum-oauth-integrations",
        name: "vellum-oauth-integrations",
        displayName: "Vellum OAuth Integrations",
        description:
          "Act on behalf of your user via the Vellum Assistant gateway",
        activationHints: ["When the user wants to connect Vellum to a service"],
      }),
    );

    // id is a protocol identifier — must stay "vellum-*".
    expect(input.id).toBe("vellum-oauth-integrations");
    expect(input.displayName).toBe("Cue OAuth Integrations");
    expect(input.description).toBe(
      "Act on behalf of your user via the Cue gateway",
    );
    expect(input.activationHints).toEqual([
      "When the user wants to connect Cue to a service",
    ]);
  });

  test("fromCatalogSkill rebrands display prose but never the id", () => {
    const entry: CatalogSkill = {
      id: "vellum-browser-use",
      name: "vellum-browser-use",
      description: "Browse the web on behalf of the Vellum Assistant",
      metadata: {
        vellum: {
          "display-name": "Vellum Browser",
          "activation-hints": ["Load first to browse the web with Vellum"],
        },
      },
    };

    const input = fromCatalogSkill(entry);

    expect(input.id).toBe("vellum-browser-use");
    expect(input.displayName).toBe("Cue Browser");
    expect(input.description).toBe("Browse the web on behalf of the Cue");
    expect(input.activationHints).toEqual([
      "Load first to browse the web with Cue",
    ]);
  });
});
