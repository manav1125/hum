/**
 * Temporary approval overrides (allow_10m / allow_conversation) in the
 * permission checker.
 *
 * Recovery of upstream's temporary-approval-modes feature (e05896063f,
 * last intact at 46d64df40d^) with fork-specific safety carve-outs:
 *
 *   - persistent deny rules always beat an active override
 *   - checkpoint/autonomy-forced prompts (send/money/delete classes) still
 *     fire under an active override
 *   - expiry returns to ask — nothing is EVER auto-allowed on timeout
 *   - voice/call sessions keep per-action prompts (v1 scope)
 *   - requireFreshApproval always prompts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PermissionCheckResult } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Module mocks (spread the real module; override only the driven seams)
// ---------------------------------------------------------------------------

const checkMock = mock<() => Promise<PermissionCheckResult>>(() =>
  Promise.resolve({ decision: "prompt", reason: "test prompt" }),
);

const actualChecker = await import("../permissions/checker.js");
mock.module("../permissions/checker.js", () => ({
  ...actualChecker,
  classifyRisk: () => Promise.resolve({ level: "medium", reason: "test risk" }),
  check: checkMock,
  getCachedAssessment: () => undefined,
  generateAllowlistOptions: () => Promise.resolve([]),
  generateScopeOptions: () => [],
}));

const actualThresholdReader =
  await import("../permissions/gateway-threshold-reader.js");
mock.module("../permissions/gateway-threshold-reader.js", () => ({
  ...actualThresholdReader,
  getAutoApproveThreshold: () => Promise.resolve("none"),
}));

const { PermissionChecker } = await import("../tools/permission-checker.js");
const {
  clearAll,
  getEffectiveMode,
  hasActiveOverride,
  setConversationMode,
  setTimedMode,
} = await import("../runtime/conversation-approval-overrides.js");

import type { PermissionPrompter } from "../permissions/prompter.js";
import type { Tool, ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CONV_ID = "conv-override-test";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    trustClass: "guardian",
    isInteractive: true,
    conversationId: CONV_ID,
    ...overrides,
  } as ToolContext;
}

const TOOL = { name: "test_tool", description: "test" } as unknown as Tool;

function makePromptMock(
  decision: string,
): ReturnType<typeof mock> & { calls: unknown[][] } {
  return mock(() => Promise.resolve({ decision })) as never;
}

async function runCheck(params: {
  promptDecision?: string;
  context?: ToolContext;
}) {
  const promptMock = makePromptMock(params.promptDecision ?? "allow");
  const checker = new PermissionChecker({
    prompt: promptMock,
  } as unknown as PermissionPrompter);
  const decision = await checker.checkPermission(
    "test_tool",
    { arg: 1 },
    TOOL,
    params.context ?? makeContext(),
    "sandbox" as never,
    () => {},
    Date.now(),
    () => undefined,
  );
  return { decision, promptMock };
}

beforeEach(() => {
  clearAll();
  checkMock.mockImplementation(() =>
    Promise.resolve({ decision: "prompt", reason: "test prompt" }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("temporary approval overrides in PermissionChecker", () => {
  test("active conversation override auto-approves a plain prompt without prompting", async () => {
    setConversationMode(CONV_ID);
    const { decision, promptMock } = await runCheck({});
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("temporary_override");
    expect(promptMock).not.toHaveBeenCalled();
  });

  test("active timed override auto-approves a plain prompt without prompting", async () => {
    setTimedMode(CONV_ID);
    const { decision, promptMock } = await runCheck({});
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("temporary_override");
    expect(promptMock).not.toHaveBeenCalled();
  });

  test("deny rule beats an active override — deny is returned, no prompt, no auto-approve", async () => {
    setConversationMode(CONV_ID);
    checkMock.mockImplementation(() =>
      Promise.resolve({
        decision: "deny",
        reason: "Blocked by deny rule: test_tool:*",
      }),
    );
    const { decision, promptMock } = await runCheck({});
    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe("denied");
    expect(promptMock).not.toHaveBeenCalled();
  });

  test("checkpoint-forced prompt (autonomyAskEnforced) still fires under an active override", async () => {
    setConversationMode(CONV_ID);
    checkMock.mockImplementation(() =>
      Promise.resolve({
        decision: "prompt",
        reason: "category requires approval",
        autonomyAskEnforced: true,
      }),
    );
    const { decision, promptMock } = await runCheck({
      promptDecision: "allow",
    });
    // The user was prompted (checkpoint fired) and answered allow.
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("allow");
  });

  test("checkpoint-forced prompt denied under an active override stays denied", async () => {
    setTimedMode(CONV_ID);
    checkMock.mockImplementation(() =>
      Promise.resolve({
        decision: "prompt",
        reason: "category requires approval",
        autonomyAskEnforced: true,
      }),
    );
    const { decision, promptMock } = await runCheck({ promptDecision: "deny" });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(decision.allowed).toBe(false);
  });

  test("expired timed override returns to ask — the prompt is shown, nothing auto-allows", async () => {
    setTimedMode(CONV_ID, 1); // 1ms TTL
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { decision, promptMock } = await runCheck({ promptDecision: "deny" });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(decision.allowed).toBe(false);
  });

  test("voice-scoped invocation (callSessionId) keeps per-action prompts despite an active override", async () => {
    setConversationMode(CONV_ID);
    const { promptMock } = await runCheck({
      context: makeContext({ callSessionId: "call-1" }),
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test("voice execution channel keeps per-action prompts despite an active override", async () => {
    setConversationMode(CONV_ID);
    const { promptMock } = await runCheck({
      context: makeContext({ executionChannel: "live-voice" }),
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test("requireFreshApproval always prompts despite an active override", async () => {
    setConversationMode(CONV_ID);
    const { promptMock } = await runCheck({
      context: makeContext({ requireFreshApproval: true }),
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test("non-guardian trust class never consults the override", async () => {
    setConversationMode(CONV_ID);
    const { promptMock } = await runCheck({
      context: makeContext({ trustClass: "unknown" as never }),
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  test("allow_10m response approves the action and installs a timed override", async () => {
    const { decision, promptMock } = await runCheck({
      promptDecision: "allow_10m",
    });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("allow_10m");
    const mode = getEffectiveMode(CONV_ID);
    expect(mode?.kind).toBe("timed");
  });

  test("allow_conversation response approves the action and installs a conversation override", async () => {
    const { decision } = await runCheck({
      promptDecision: "allow_conversation",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("allow_conversation");
    const mode = getEffectiveMode(CONV_ID);
    expect(mode?.kind).toBe("conversation");
  });

  test("a grant decision from a voice-scoped context does NOT install an override", async () => {
    const { decision } = await runCheck({
      promptDecision: "allow_10m",
      context: makeContext({ callSessionId: "call-1" }),
    });
    // The action itself is still approved (the user answered the prompt)…
    expect(decision.allowed).toBe(true);
    // …but no override was installed for follow-up actions.
    expect(hasActiveOverride(CONV_ID)).toBe(false);
  });

  test("a grant decision under requireFreshApproval does NOT install an override", async () => {
    const { decision } = await runCheck({
      promptDecision: "allow_10m",
      context: makeContext({ requireFreshApproval: true }),
    });
    expect(decision.allowed).toBe(true);
    expect(hasActiveOverride(CONV_ID)).toBe(false);
  });

  test("plain allow response does not install any override", async () => {
    const { decision } = await runCheck({ promptDecision: "allow" });
    expect(decision.allowed).toBe(true);
    expect(hasActiveOverride(CONV_ID)).toBe(false);
  });
});
