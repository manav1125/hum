/**
 * The repair drops ONLY what cannot be served.
 *
 * The mutation checks guard the three ways this migration could quietly do
 * damage: taking a model from a workspace that can serve it, taking the
 * vendor-prefixed form that is CORRECT, or taking the per-site `effort` /
 * `thinking` intent along with the model it was sitting next to.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { repairUnservableAnthropicCallsiteModelsMigration as migration } from "../105-repair-unservable-anthropic-callsite-models.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cue-mig105-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function llmOf(dir: string): Record<string, any> {
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
  return raw.llm ?? {};
}

/** The shape a freshly provisioned workspace actually had on 2026-08-12. */
const SEEDED = {
  llm: {
    profiles: {
      balanced: { model: "deepseek/deepseek-v4-pro" },
      "cost-optimized": { model: "deepseek/deepseek-v4-flash" },
    },
    callSites: {
      interactionClassifier: {
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        thinking: { enabled: false },
      },
      conversationSummarization: {
        model: "claude-opus-4-7",
        effort: "low",
        thinking: { enabled: false },
      },
    },
  },
};

describe("the unservable override is removed", () => {
  test("bare Anthropic ids are dropped from every call site", () => {
    const dir = workspaceWith(SEEDED);
    migration.run(dir);
    const cs = llmOf(dir).callSites;
    expect(cs.interactionClassifier.model).toBeUndefined();
    expect(cs.conversationSummarization.model).toBeUndefined();
  });

  test("MUTATION CHECK: effort and thinking survive", () => {
    // They are provider-independent per-site intent. Deleting the whole entry
    // would silently reset ten call sites to defaults nobody chose.
    const dir = workspaceWith(SEEDED);
    migration.run(dir);
    const site = llmOf(dir).callSites.interactionClassifier;
    expect(site.effort).toBe("low");
    expect(site.thinking).toEqual({ enabled: false });
  });

  test("the profiles that make chat work are untouched", () => {
    const dir = workspaceWith(SEEDED);
    migration.run(dir);
    expect(llmOf(dir).profiles).toEqual(SEEDED.llm.profiles);
  });

  test("an entry with nothing left is removed, not left as a shell", () => {
    const dir = workspaceWith({
      llm: { callSites: { commitMessage: { model: "claude-haiku-4-5" } } },
    });
    migration.run(dir);
    expect(llmOf(dir).callSites).toBeUndefined();
  });
});

describe("what it must NOT touch", () => {
  test("MUTATION CHECK: the vendor-PREFIXED form is correct and stays", () => {
    // `anthropic/claude-haiku-4.5` is exactly what migration 073 writes for
    // OpenRouter. Stripping it would break the workspaces that are right.
    const dir = workspaceWith({
      llm: { callSites: { recall: { model: "anthropic/claude-haiku-4.5" } } },
    });
    migration.run(dir);
    expect(llmOf(dir).callSites.recall.model).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });

  test("MUTATION CHECK: a workspace on Anthropic serves bare ids fine", () => {
    const dir = workspaceWith({
      llm: {
        default: { provider: "anthropic" },
        callSites: { commitMessage: { model: "claude-haiku-4-5-20251001" } },
      },
    });
    migration.run(dir);
    expect(llmOf(dir).callSites.commitMessage.model).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  test("a site naming anthropic itself is a deliberate choice", () => {
    const dir = workspaceWith({
      llm: {
        callSites: {
          commitMessage: { provider: "anthropic", model: "claude-opus-4-7" },
        },
      },
    });
    migration.run(dir);
    expect(llmOf(dir).callSites.commitMessage.model).toBe("claude-opus-4-7");
  });

  test("non-Anthropic models are none of its business", () => {
    const dir = workspaceWith({
      llm: {
        callSites: { cueLiveVision: { model: "qwen/qwen2.5-vl-72b-instruct" } },
      },
    });
    migration.run(dir);
    expect(llmOf(dir).callSites.cueLiveVision.model).toBe(
      "qwen/qwen2.5-vl-72b-instruct",
    );
  });
});

describe("it is safe to re-run and safe on junk", () => {
  test("idempotent — a second run changes nothing", () => {
    const dir = workspaceWith(SEEDED);
    migration.run(dir);
    const after = readFileSync(join(dir, "config.json"), "utf-8");
    migration.run(dir);
    expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe(after);
  });

  test("no config, unparseable config, and no llm block all no-op", () => {
    const empty = mkdtempSync(join(tmpdir(), "cue-mig105-none-"));
    expect(() => migration.run(empty)).not.toThrow();

    const junk = mkdtempSync(join(tmpdir(), "cue-mig105-junk-"));
    writeFileSync(join(junk, "config.json"), "{ not json");
    expect(() => migration.run(junk)).not.toThrow();
    // Left exactly as found rather than rewritten.
    expect(readFileSync(join(junk, "config.json"), "utf-8")).toBe("{ not json");

    const bare = workspaceWith({ services: {} });
    expect(() => migration.run(bare)).not.toThrow();
  });
});
