/**
 * Personal-memory gating for the advisor context pack: NOW.md, PKB, and the
 * fresh recall search must only reach the advisor when the turn's trust
 * admits personal memory (and, for NOW.md, the scratchpad-injection toggle is
 * on) — the same policy the runtime memory injectors apply. Without it, a
 * low-risk advisor consult on a remote/trusted-contact turn could forward
 * private content the main agent would never receive.
 *
 * Mocks spread the real modules and override only the seams under test
 * (assistant/CLAUDE.md: never write an exhaustive `mock.module` factory).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../daemon/trust-context.js";

let personalAllowed = false;
let scratchpadEnabled = true;
let gateArg: unknown = null;
let recallStalls = false;

const actualTrust = await import("../daemon/trust-context.js");
mock.module("../daemon/trust-context.js", () => ({
  ...actualTrust,
  isPersonalMemoryAllowed: (trust: unknown) => {
    gateArg = trust;
    return personalAllowed;
  },
}));

const actualNow = await import("../daemon/now-scratchpad.js");
mock.module("../daemon/now-scratchpad.js", () => ({
  ...actualNow,
  readNowScratchpad: () => "NOW-CONTENT",
}));

const actualLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualLoader,
  // Minimal config object: only the paths the pack reads. Not a module
  // factory — the loader module keeps every real export.
  getConfig: () =>
    ({
      memory: {
        retrieval: { scratchpadInjection: { enabled: scratchpadEnabled } },
      },
    }) as ReturnType<typeof actualLoader.getConfig>,
}));

const actualPkb = await import("../memory/pkb/context.js");
mock.module("../memory/pkb/context.js", () => ({
  ...actualPkb,
  readPkbContext: () => "PKB-CONTENT",
}));

const actualSearch = await import("../memory/context-search/search.js");
mock.module("../memory/context-search/search.js", () => ({
  ...actualSearch,
  runDeterministicRecallSearch: () =>
    recallStalls
      ? new Promise(() => {}) // never settles: the section timeout must cover it
      : Promise.resolve({
          evidence: [{ id: "e1" }],
          searchedSources: [],
        }),
}));

const actualFormat = await import("../memory/context-search/format.js");
mock.module("../memory/context-search/format.js", () => ({
  ...actualFormat,
  formatDeterministicRecallAnswer: () => ({
    answer: "RECALL-EVIDENCE",
    evidence: [],
  }),
}));

// Keep every other section empty so the assertions isolate the gated surfaces.
const actualSkills = await import("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...actualSkills,
  loadSkillCatalog: () => [],
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
const actualRegistry = await import("../daemon/conversation-registry.js");
mock.module("../daemon/conversation-registry.js", () => ({
  ...actualRegistry,
  findConversationOrSubagent: () => undefined,
}));

const { buildAdvisorContext } = await import("./consult-context.js");

// A remote, non-guardian per-turn snapshot: the case the live-state read
// could have wrongly elevated.
const trustSnapshot = {
  sourceChannel: "telegram",
  trustClass: "unknown",
} as TrustContext;

const sources = {
  conversationId: "c1",
  // A path that does not exist, so the workspace-tree section stays empty and
  // the assertions isolate the gated surfaces.
  workingDir: "/tmp/does-not-exist-consult-gating",
  trust: trustSnapshot,
  recallQuery: "the proposed action",
};

beforeEach(() => {
  personalAllowed = false;
  scratchpadEnabled = true;
  gateArg = null;
  recallStalls = false;
});

describe("advisor context pack: personal-memory gating", () => {
  test("withholds NOW.md, PKB, and recall when personal memory is disallowed", async () => {
    personalAllowed = false;
    const ctx = (await buildAdvisorContext(sources)) ?? "";
    expect(ctx).not.toContain("NOW-CONTENT");
    expect(ctx).not.toContain("PKB-CONTENT");
    expect(ctx).not.toContain("RECALL-EVIDENCE");
  });

  test("includes NOW.md, PKB, and recall when the gate admits", async () => {
    personalAllowed = true;
    const ctx = (await buildAdvisorContext(sources)) ?? "";
    expect(ctx).toContain("NOW-CONTENT");
    expect(ctx).toContain("PKB-CONTENT");
    expect(ctx).toContain("RECALL-EVIDENCE");
  });

  test("withholds NOW.md when the scratchpad toggle is off", async () => {
    personalAllowed = true;
    scratchpadEnabled = false;
    const ctx = (await buildAdvisorContext(sources)) ?? "";
    expect(ctx).not.toContain("NOW-CONTENT");
    // The toggle governs NOW.md only; PKB stays admitted.
    expect(ctx).toContain("PKB-CONTENT");
  });

  test("skips the recall search when no query is threaded in", async () => {
    personalAllowed = true;
    const ctx =
      (await buildAdvisorContext({ ...sources, recallQuery: undefined })) ?? "";
    expect(ctx).not.toContain("RECALL-EVIDENCE");
    expect(ctx).toContain("PKB-CONTENT");
  });

  test("feeds the gate the per-turn trust snapshot, not live conversation state", async () => {
    personalAllowed = true;
    await buildAdvisorContext(sources);
    // The gate must see exactly the snapshot threaded from the loop's run
    // options so a concurrent live-trust change can't elevate this consult.
    expect(gateArg).toBe(trustSnapshot);
  });

  test("a stalled source costs at most the section budget and drops only its section", async () => {
    personalAllowed = true;
    recallStalls = true;
    const started = Date.now();
    const ctx =
      (await buildAdvisorContext(
        { ...sources, tools: [{ name: "bash" }] },
        150,
      )) ?? "";
    expect(Date.now() - started).toBeLessThan(1_500);
    // The stalled personal-memory section is dropped whole...
    expect(ctx).not.toContain("RECALL-EVIDENCE");
    // ...while unaffected sections still arrive.
    expect(ctx).toContain("## Available tools");
  });
});
