/**
 * Where browser operations come from, and where they must not come from.
 *
 * This file used to lock a **CLI-only** contract: no `browser_*` tools
 * anywhere, every operation dispatched through `assistant browser <cmd>`.
 * That end-state was deliberately abandoned in `9fb8d1de3d` — the model was
 * never told the CLI existed, so it fell back to `computer_use_*` and clicked
 * at pixels instead of driving the connected browser. A capability reachable
 * only through a channel nothing mentions is the same as no capability: the
 * same defect as a tool named in the prompt but never registered.
 *
 * So `browser_*` tools are now registered from the manifest, and the two
 * assertions that demanded zero of them have been red ever since — a guard
 * nobody read, which is how it survived the change that invalidated it.
 *
 * What is still true, and still worth locking:
 *
 * - The tools come from the **manifest**, one per canonical operation. If an
 *   operation loses its tool it becomes invisible again, silently.
 * - They must **not** also arrive via skill projection. Loading the browser
 *   skill emits no tool definitions; two registration paths for one operation
 *   is how you get a name bound to a stale executor.
 * - The CLI path still exists and still carries help text, because the skill
 *   documents it.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const actualLoader = await import("../config/loader.js");
// Spread the real module: a hand-written factory deletes every export it does
// not name, process-wide, for every file that runs after this one.
mock.module("../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => ({}),
}));

import { BROWSER_OPERATION_META } from "../browser/operations.js";
import { BROWSER_OPERATIONS } from "../browser/types.js";
import {
  projectSkillTools,
  resetSkillToolProjection,
} from "../daemon/conversation-skill-tools.js";
import {
  __resetRegistryForTesting,
  getAllToolDefinitions,
  getAllTools,
  initializeTools,
} from "../tools/registry.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import {
  BROWSER_SKILL_ID,
  buildSkillLoadHistory,
} from "./test-support/browser-skill-harness.js";

afterAll(() => {
  __resetRegistryForTesting();
  setOverridesForTesting({});
});

describe("browser operations reach the model exactly once", () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    setOverridesForTesting({
      browser: true,
    });
    await initializeTools();
  });

  // ── 1. Every operation has a tool, or it is invisible ────────────

  test("every canonical browser operation is registered as a tool", () => {
    // The defect this replaces: operations existed, the CLI could run them,
    // and the model had no way to know. Counting is not enough — name the
    // missing operation, because "16 not 17" does not say which one went.
    const registered = new Set(
      getAllTools()
        .map((t) => t.name)
        .filter((n) => n.startsWith("browser_")),
    );
    const missing = BROWSER_OPERATION_META.map(
      (m) => `browser_${m.operation}`,
    ).filter((name) => !registered.has(name));
    expect(
      missing,
      "A browser operation lost its tool. The model cannot call what is not registered, and it will fall back to clicking pixels with computer_use_* rather than report the gap.",
    ).toEqual([]);
  });

  test("browser tool definitions match the registered tools exactly", () => {
    // Definitions are what the model is shown; tools are what can execute.
    // A name in one and not the other is a control wired to nothing.
    const defs = new Set(
      getAllToolDefinitions()
        .map((d) => d.name)
        .filter((n) => n.startsWith("browser_")),
    );
    const tools = new Set(
      getAllTools()
        .map((t) => t.name)
        .filter((n) => n.startsWith("browser_")),
    );
    expect([...defs].sort()).toEqual([...tools].sort());
    expect(defs.size).toBe(BROWSER_OPERATION_META.length);
  });

  // ── 2. Browser skill directory exists with SKILL.md ──────────────

  test("managed browser skill directory exists with SKILL.md but no TOOLS.json", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    // Browser skill lives in skills/vellum-browser-use/ (managed), not bundled-skills/.
    const skillDir = path.resolve(
      import.meta.dirname,
      "../../../skills/vellum-browser-use",
    );
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    // Browser operations are dispatched via the CLI, not via skill tools.
    expect(fs.existsSync(path.join(skillDir, "TOOLS.json"))).toBe(false);
  });

  // ── 3. Browser tool wrapper directory does not exist ─────────────

  test("browser tool wrapper scripts directory does not exist", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const toolsDir = path.resolve(
      import.meta.dirname,
      "../../../skills/vellum-browser-use/tools",
    );
    // Browser operations are dispatched via CLI commands,
    // not via per-tool executor files.
    expect(fs.existsSync(toolsDir)).toBe(false);
  });

  // ── 4. Browser operations have CLI metadata ──────────────────────

  test("every browser operation has CLI subcommand metadata", () => {
    for (const op of BROWSER_OPERATIONS) {
      const meta = BROWSER_OPERATION_META.find((m) => m.operation === op);
      expect(meta).toBeDefined();
      expect(meta!.helpText).toBeDefined();
      expect(meta!.helpText).toContain("assistant browser");
    }
  });

  // ── 5. Skill projection emits no tool definitions ────────────────

  test("skill_load projection registers no browser tools", () => {
    const history = buildSkillLoadHistory(BROWSER_SKILL_ID);
    const tracking = new Map<string, string>();

    try {
      const projection = projectSkillTools(history, {
        previouslyActiveSkillIds: tracking,
      });

      // No tool definitions sent to the LLM — browser operations are
      // dispatched via `assistant browser` CLI commands.
      expect(projection.toolDefinitions).toHaveLength(0);
      expect(projection.allowedToolNames.size).toBe(0);
    } finally {
      resetSkillToolProjection(tracking);
    }
  });

  // ── 6. Execution module exists ───────────────────────────────────

  test("browser-execution.ts exists with exported execute functions", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const execPath = path.resolve(
      import.meta.dirname,
      "../tools/browser/browser-execution.ts",
    );
    expect(fs.existsSync(execPath)).toBe(true);
  });
});
