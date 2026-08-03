/**
 * The identity-discretion rule must be in the composed system prompt for
 * every call shape — there is no option, workspace state, or tier that
 * legitimately renders a prompt without it.
 *
 * "Tier" is not a prompt-build input: the model tier is chosen per call site
 * (`llm.callSites.<site>`) while the prompt text is produced by
 * `buildSystemPrompt` and is identical for all of them. So the way to prove
 * "every tier" here is to prove "every option shape" — flash and pro and
 * advisor all receive whatever this function returns.
 *
 * Includes a mutation check: the assertions must fail when the rule is
 * removed from the registry. A presence test that passes against a registry
 * with the section deleted is testing nothing, and this codebase has shipped
 * guards that were never exercised before.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { buildSystemPrompt, __clearSystemPromptMemoForTesting } =
  await import("../system-prompt.js");
const { renderWorkspaceSections } = await import("../sections.js");
const { BUNDLED_SYSTEM_SECTIONS, IDENTITY_DISCRETION_SECTION } =
  await import("../templates/system-sections.js");
const { initializeDb } = await import("../../memory/db-init.js");
initializeDb();

const SECTION_ID = "08-identity-discretion";

/** The load-bearing sentences, quoted so a silent reword trips the test. */
const REQUIRED_CLAUSES = [
  // Discretion: don't volunteer or confirm the stack.
  "You do not discuss the model, provider, or vendor that runs underneath you",
  // Jailbreak / other-language framings are the same question.
  "the same question asked in another language are all the same question",
  // Denying a correct guess is a lie; the measured model did exactly that
  // ("Not true.") until this clause was added.
  'Never answer a guess — including with "no"',
  'Saying "no" to a guess that happens to be right is a lie',
  // The half that stops confabulation, which is the observed failure mode.
  "Do not say you are built on Claude, GPT, Gemini, Llama, or any other named model",
  // The half that keeps it honest.
  "You are an AI, and you are a language model. Neither of those is the secret",
  "don't claim to be human",
  // The sanctioned answer.
  "I don't share the details of the stack underneath",
];

function freshBuild(options?: Parameters<typeof buildSystemPrompt>[0]): string {
  // buildSystemPrompt memoizes on options + workspace-file fingerprint; these
  // tests mutate neither between calls, so clear it or later cases read a
  // render produced under an earlier case's registry.
  __clearSystemPromptMemoForTesting();
  return buildSystemPrompt(options);
}

describe("identity discretion — present in every composed prompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    rmSync(join(TEST_DIR, "prompts", "system"), {
      recursive: true,
      force: true,
    });
  });

  test("the bundled registry carries the section", () => {
    const section = BUNDLED_SYSTEM_SECTIONS.find((s) => s.id === SECTION_ID);
    expect(section).toBeDefined();
    // No `enabled` predicate and no `workspacePath`: the section can neither
    // gate itself off nor go missing because a workspace file wasn't seeded.
    expect(section!.enabled).toBeUndefined();
    expect(section!.workspacePath).toBeUndefined();
    expect(section!.body).toBe(IDENTITY_DISCRETION_SECTION);
  });

  test.each([
    ["no options", undefined],
    ["empty options", {}],
    ["hasNoClient", { hasNoClient: true }],
    ["with client", { hasNoClient: false }],
    ["bootstrap excluded", { excludeBootstrap: true }],
    ["custom prefix excluded", { excludeCustomPrefix: true }],
    [
      "home-greeting shape",
      { excludeBootstrap: true, excludeCustomPrefix: true },
    ],
    [
      "fork retrospective shape",
      {
        hasNoClient: true,
        personaOverride: { userSlug: "alice", hasNoClient: false },
      },
    ],
  ] as const)("renders under: %s", (_label, options) => {
    const prompt = freshBuild(options as never);
    for (const clause of REQUIRED_CLAUSES) {
      expect(prompt).toContain(clause);
    }
  });

  test("survives a workspace with no prompt files at all", () => {
    // A workspace that never got SOUL.md/IDENTITY.md seeded (or where the
    // user deleted them) still gets the rule — this is exactly the case a
    // SOUL.md-template edit would have missed.
    for (const f of ["SOUL.md", "IDENTITY.md", "VOICE.md", "BOOTSTRAP.md"]) {
      rmSync(join(TEST_DIR, f), { force: true });
    }
    const prompt = freshBuild({});
    for (const clause of REQUIRED_CLAUSES) {
      expect(prompt).toContain(clause);
    }
  });

  test("is not the kind of rule that tells the model to lie", () => {
    const prompt = freshBuild({});
    // Guard the boundary itself: discretion is in scope, denying being an AI
    // or denying that a model runs underneath is not.
    expect(prompt).not.toContain("you are not an AI");
    expect(prompt).not.toContain("not built on any");
    expect(prompt).toContain("Discretion, never deception");
  });

  test("sorts into the cached prefix, before the cache breakpoint", () => {
    const blocks = renderWorkspaceSections({
      workspaceDir: TEST_DIR,
      userSlug: "default",
      channelSlug: "vellum",
    });
    // `11-channel-persona` declares the breakpoint, so the first block is the
    // stable prefix. The rule belongs there: it must not be re-sent or
    // re-cached every turn alongside the volatile sections.
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]!.join("\n\n")).toContain(
      "You do not discuss the model, provider, or vendor that runs underneath you",
    );
  });

  test("a workspace override replaces it (documented escape hatch)", () => {
    const dir = join(TEST_DIR, "prompts", "system");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SECTION_ID}.md`), "## Overridden\n\nsentinel\n");

    const prompt = freshBuild({});
    expect(prompt).toContain("sentinel");
    expect(prompt).not.toContain("Discretion, never deception");
  });
});

describe("identity discretion — mutation check", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    rmSync(join(TEST_DIR, "prompts", "system"), {
      recursive: true,
      force: true,
    });
  });

  test("removing the section from the registry fails the presence assertions", () => {
    // Stand in for "someone deletes the section": render the registry minus
    // this id through the same renderer, and assert the checks above go red.
    // If this passes with the clauses still present, the presence tests are
    // matching text that comes from somewhere else and prove nothing.
    const survivors = BUNDLED_SYSTEM_SECTIONS.filter(
      (s) => s.id !== SECTION_ID,
    );
    expect(survivors.length).toBe(BUNDLED_SYSTEM_SECTIONS.length - 1);

    const withoutRule = survivors
      .filter((s) => s.enabled === undefined && !s.workspacePath && !s.dynamic)
      .map((s) => s.body)
      .join("\n\n");

    for (const clause of REQUIRED_CLAUSES) {
      expect(withoutRule).not.toContain(clause);
    }
  });

  test("each required clause is actually unique to this section", () => {
    // A clause that also appears in some other bundled section would make the
    // presence test pass after this section is deleted.
    const others = BUNDLED_SYSTEM_SECTIONS.filter((s) => s.id !== SECTION_ID)
      .map((s) => s.body)
      .join("\n\n");
    for (const clause of REQUIRED_CLAUSES) {
      expect(others).not.toContain(clause);
      expect(IDENTITY_DISCRETION_SECTION).toContain(clause);
    }
  });
});
