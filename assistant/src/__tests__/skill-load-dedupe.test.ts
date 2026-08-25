/**
 * Loading the same skill twice should not send its body twice.
 *
 * A large skill body runs to tens of thousands of characters. One real
 * conversation loaded App Builder nine times for 206 KB of identical text on
 * top of an already oversized history; re-sending what the model can already
 * read buys nothing and crowds out the work.
 *
 * The mutation checks guard both directions, because they fail differently.
 * Re-sending an unchanged body wastes context. Suppressing a CHANGED body is
 * worse: the model would keep following instructions that no longer exist.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (s: unknown) => String(s),
}));

mock.module("../skills/catalog-install.js", () => ({
  autoInstallFromCatalog: () => Promise.resolve(false),
  resolveCatalog: () => Promise.resolve([]),
}));

const testConfig = {
  permissions: {},
  skills: { load: { extraDirs: [] } },
  sandbox: { enabled: true },
};
mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

/** History the fake conversation reports back to the executor. */
let history: unknown[] = [];
const registryActual = await import("../daemon/conversation-registry.js");
mock.module("../daemon/conversation-registry.js", () => ({
  ...registryActual,
  findConversation: () => ({ messages: history }),
}));

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

const BODY_MARKER = "UNIQUE-BODY-SENTINEL-9f3a";

function writeSkill(skillId: string, body: string): void {
  const dir = join(TEST_DIR, "skills", skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: "${skillId}"\ndescription: "a test skill"\n---\n\n${body}\n`,
  );
}

async function load(skill: string): Promise<{ content: string }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load not registered");
  const r = await tool.execute(
    { skill, activity: "loading" },
    { workingDir: "/tmp", conversationId: "c1", trustClass: "guardian" },
  );
  return { content: String(r.content) };
}

/** A prior skill_load turn carrying the marker the executor looks for. */
function priorLoad(skillId: string, version: string): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu-1", name: "skill_load", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: `<loaded_skill id="${skillId}" version="${version}" />`,
        },
      ],
    },
  ];
}

beforeEach(() => {
  history = [];
});

describe("the first load sends the body", () => {
  test("a skill never loaded before arrives in full", async () => {
    writeSkill("alpha", BODY_MARKER);
    const r = await load("alpha");
    expect(r.content).toContain(BODY_MARKER);
    expect(r.content).toContain('<loaded_skill id="alpha"');
  });
});

describe("a second load of the same version does not resend it", () => {
  test("MUTATION CHECK: an unchanged reload returns a pointer, not the body", async () => {
    writeSkill("beta", BODY_MARKER);
    // Learn the real version hash from a genuine first load.
    const first = await load("beta");
    const version = /version="([^"]+)"/.exec(first.content)?.[1];
    expect(version).toBeTruthy();

    history = priorLoad("beta", version!);
    const second = await load("beta");

    expect(second.content).not.toContain(BODY_MARKER);
    expect(second.content).toMatch(/already loaded/i);
    // The marker must still be emitted, or tool-pruning loses the activation.
    expect(second.content).toContain('<loaded_skill id="beta"');
  });
});

describe("a changed skill is always resent", () => {
  test("MUTATION CHECK: a different version sends the new body", async () => {
    // The dangerous direction. Suppressing here would leave the model working
    // from instructions that no longer exist.
    writeSkill("gamma", BODY_MARKER);
    history = priorLoad("gamma", "v1:staleversionhash");
    const r = await load("gamma");
    expect(r.content).toContain(BODY_MARKER);
  });

  test("a legacy marker with no version resends rather than guessing", async () => {
    // Unversioned markers predate the hash. Unknown means reload — wrong in
    // this direction costs tokens; wrong the other way serves a stale skill.
    writeSkill("delta", BODY_MARKER);
    history = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-9", name: "skill_load", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-9",
            content: `<loaded_skill id="delta" />`,
          },
        ],
      },
    ];
    const r = await load("delta");
    expect(r.content).toContain(BODY_MARKER);
  });
});

describe("a marker the model did not earn is ignored", () => {
  test("MUTATION CHECK: a faked marker cannot suppress a real load", async () => {
    // `deriveActiveSkills` only trusts markers in tool_result blocks belonging
    // to an actual skill_load call. A marker pasted into a user message must
    // not be able to starve the model of a skill it asked for.
    writeSkill("epsilon", BODY_MARKER);
    const first = await load("epsilon");
    const version = /version="([^"]+)"/.exec(first.content)?.[1];
    history = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<loaded_skill id="epsilon" version="${version}" />`,
          },
        ],
      },
    ];
    const r = await load("epsilon");
    expect(r.content).toContain(BODY_MARKER);
  });
});
