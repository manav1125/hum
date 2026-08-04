import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { devendorBalancedEconomyDescriptionMigration } from "../workspace/migrations/104-devendor-balanced-economy-description.js";

const NEW_DESCRIPTION =
  "Full-depth reasoning and longer answers, at a lower price";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readProfiles(): Record<string, Record<string, unknown>> {
  const llm = readConfig().llm as Record<string, unknown>;
  return llm.profiles as Record<string, Record<string, unknown>>;
}

function configWithDescription(description: string): Record<string, unknown> {
  return {
    llm: {
      profiles: {
        "balanced-economy": {
          provider: "fireworks",
          provider_connection: "fireworks-managed",
          model: "accounts/fireworks/models/minimax-m3",
          label: "Balanced Economy",
          description,
          maxTokens: 32000,
        },
      },
    },
  };
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-104-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("104-devendor-balanced-economy-description migration", () => {
  test("no-op when config.json does not exist", () => {
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op on unparseable config.json", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "fireworks" } } };
    writeConfig(original);
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  // The instance shape this migration exists for: already ran 101, so the
  // model is current but the description still names the vendor.
  test("rewrites the description written by the previous seed template", () => {
    writeConfig(
      configWithDescription(
        "Strong open model (MiniMax M3) at a lower price point",
      ),
    );
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    const profile = readProfiles()["balanced-economy"]!;
    expect(profile.description).toBe(NEW_DESCRIPTION);
    // Everything else about the profile is left exactly as it was.
    expect(profile.model).toBe("accounts/fireworks/models/minimax-m3");
    expect(profile.maxTokens).toBe(32000);
    expect(profile.label).toBe("Balanced Economy");
  });

  test("rewrites the older pre-101 description too", () => {
    writeConfig(
      configWithDescription(
        "Strong open model (Kimi K2.6) at a lower price point",
      ),
    );
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(readProfiles()["balanced-economy"]!.description).toBe(
      NEW_DESCRIPTION,
    );
  });

  // A self-hoster running their own key may legitimately name their model.
  // Only the two strings this codebase itself wrote are replaced.
  test("leaves a user-edited description untouched", () => {
    const original = configWithDescription(
      "My own GPT-5.5 box, cheap at night",
    );
    writeConfig(original);
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("is idempotent", () => {
    writeConfig(
      configWithDescription(
        "Strong open model (MiniMax M3) at a lower price point",
      ),
    );
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    const once = readConfig();
    devendorBalancedEconomyDescriptionMigration.run(workspaceDir);
    expect(readConfig()).toEqual(once);
  });
});
