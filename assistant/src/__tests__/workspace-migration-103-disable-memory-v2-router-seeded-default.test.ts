/**
 * Tests for workspace migration `103-disable-memory-v2-router-seeded-default`.
 *
 * The memory-v2 LLM router (a blocking per-turn model call) flipped to
 * disabled-by-default in the config schema, but existing workspaces carry an
 * explicit `memory.v2.router.enabled: true` written by config
 * materialization from the old default. The migration flips that seeded
 * `true` to `false` — but ONLY when every other router knob still holds its
 * seeded default, so workspaces that deliberately tuned the router keep it.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemoryV2ConfigSchema } from "../config/schemas/memory-v2.js";
import { disableMemoryV2RouterSeededDefaultMigration } from "../workspace/migrations/103-disable-memory-v2-router-seeded-default.js";

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-103-test-"));
  configPath = join(workspaceDir, "config.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeConfig(config: unknown): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function readRouter(): Record<string, unknown> {
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    memory: { v2: { router: Record<string, unknown> } };
  };
  return config.memory.v2.router;
}

/** The exact shape the old default materialized into config.json. */
function seededRouterBlock(): Record<string, unknown> {
  return {
    enabled: true,
    max_page_ids: 25,
    router_prompt_path: null,
    batch_size: null,
    tier1_size: null,
    tier2_size: null,
    historical_pairs: 1,
    historical_pairs_max_chars: null,
  };
}

describe("103-disable-memory-v2-router-seeded-default migration", () => {
  test("has correct id", () => {
    expect(disableMemoryV2RouterSeededDefaultMigration.id).toBe(
      "103-disable-memory-v2-router-seeded-default",
    );
  });

  test("schema default is disabled (the flip this migration completes)", () => {
    expect(MemoryV2ConfigSchema.parse({}).router.enabled).toBe(false);
  });

  test("flips the exact seeded shape to disabled", () => {
    writeConfig({ memory: { v2: { router: seededRouterBlock() } } });
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readRouter().enabled).toBe(false);
  });

  test("flips when optional knobs are absent (partial seeded shape)", () => {
    writeConfig({ memory: { v2: { router: { enabled: true } } } });
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readRouter().enabled).toBe(false);
  });

  test("preserves a customized router (user was actively using it)", () => {
    const custom = { ...seededRouterBlock(), batch_size: 40 };
    writeConfig({ memory: { v2: { router: custom } } });
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readRouter().enabled).toBe(true);
    expect(readRouter().batch_size).toBe(40);
  });

  test("leaves an already-disabled router untouched", () => {
    const disabled = { ...seededRouterBlock(), enabled: false };
    writeConfig({ memory: { v2: { router: disabled } } });
    const before = readFileSync(configPath, "utf-8");
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("no-ops when config.json is missing", () => {
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(existsSync(configPath)).toBe(false);
  });

  test("no-ops when memory.v2.router is absent", () => {
    writeConfig({ memory: { v2: {} } });
    const before = readFileSync(configPath, "utf-8");
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("no-ops on malformed config.json", () => {
    writeFileSync(configPath, "{ not json");
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("is idempotent", () => {
    writeConfig({ memory: { v2: { router: seededRouterBlock() } } });
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath, "utf-8");
    disableMemoryV2RouterSeededDefaultMigration.run(workspaceDir);
    expect(readFileSync(configPath, "utf-8")).toBe(afterFirst);
  });
});
