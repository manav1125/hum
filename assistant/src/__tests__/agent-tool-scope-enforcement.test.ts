/**
 * Tests for Guardrails agent tool-scope enforcement on the conversation tool
 * pipeline (`ctx.toolScopeFilter`, set by the work-item runner on background
 * run conversations whose agent has `tool_scopes`).
 *
 * Covers:
 * - Resolver (`createResolveToolsCallback`): out-of-scope tools are dropped
 *   from the resolved wire definitions (core defs and projected skill tools),
 *   so the model never sees them; an absent filter changes nothing.
 * - Executor (`createToolExecutor`): a call to an out-of-scope tool returns
 *   an error tool_result WITHOUT invoking the tool's executor, including
 *   through the `skill_execute` indirection; in-scope calls execute normally.
 */

import { describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

const baseConfig = {
  tools: { exclude: [] as string[] },
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 600,
  },
  services: {},
  llm: { profiles: { speedy: { label: "Speedy" } } },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => baseConfig,
  loadConfig: () => baseConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: mock(() => {}),
  // `publish` included so this process-wide mock never breaks route tests
  // (they publish tasks_changed events) if bun runs the files together.
  assistantEventHub: {
    listClientsByCapability: () => [],
    publish: mock(async () => {}),
  },
}));

mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
  surfaceProxyResolver: mock(() =>
    Promise.resolve({ content: "", isError: false }),
  ),
}));

mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));

mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: mock(() => {}),
}));

mock.module("../memory/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
  isMultifileApp: mock(() => false),
  getAppsDir: mock(() => "/tmp/test-apps"),
  resolveAppIdByDirName: mock(() => null),
  resolveAppIdFromPath: mock(() => null),
}));

// Controls the skill tools the projection reports per resolver call.
let projectedSkillToolNames: string[] = [];

mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mock(() => ({
    allowedToolNames: new Set(projectedSkillToolNames),
    toolDefinitions: [],
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks are in place
// ---------------------------------------------------------------------------

import {
  createResolveToolsCallback,
  createToolExecutor,
  type SkillProjectionContext,
  type ToolSetupContext,
} from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_HISTORY: Message[] = [];

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
}

/** A scope filter blocking exactly the given tool names. */
function blockTools(...blocked: string[]): (name: string) => boolean {
  const set = new Set(blocked);
  return (name) => !set.has(name);
}

function makeProjectionCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set(["remember", "tool_b"]),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

function makeSetupCtx(
  overrides: Partial<ToolSetupContext> = {},
): ToolSetupContext {
  return {
    conversationId: "conv-test",
    currentRequestId: "req-1",
    workingDir: "/tmp/test",
    abortController: null,
    traceEmitter: { emit: () => {} },
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    ...overrides,
  };
}

/** Fake ToolExecutor that records every execute() invocation. */
function makeCapturingExecutor() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const executor = {
    execute: async (
      name: string,
      input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> => {
      calls.push({ name, input });
      return { content: "ok", isError: false };
    },
  };
  return { executor: executor as unknown as ToolExecutor, calls };
}

const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;

function makeToolFn(executor: ToolExecutor, ctx: ToolSetupContext) {
  return createToolExecutor(
    executor,
    noopPrompter,
    noopSecretPrompter,
    ctx,
    () => {},
  );
}

// ---------------------------------------------------------------------------
// Resolver — wire-level scope filtering
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — toolScopeFilter", () => {
  test("drops out-of-scope core defs and skill tools from the resolved set", () => {
    projectedSkillToolNames = ["messaging_send", "task_list_add"];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];
    const ctx = makeProjectionCtx({
      toolScopeFilter: blockTools("tool_b", "messaging_send"),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);

    expect(tools.map((t) => t.name)).toEqual(["remember"]);
    // The per-turn execution gate excludes filtered skill tools too.
    expect(ctx.allowedToolNames).toEqual(
      new Set(["remember", "task_list_add"]),
    );
  });

  test("absent filter resolves the full surface (regression)", () => {
    projectedSkillToolNames = ["messaging_send"];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];
    const ctx = makeProjectionCtx();
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);

    expect(tools.map((t) => t.name).sort()).toEqual(["remember", "tool_b"]);
    expect(ctx.allowedToolNames).toEqual(
      new Set(["remember", "tool_b", "messaging_send"]),
    );
  });

  test("scope filter composes with a subagent wire allowlist (both must pass)", () => {
    projectedSkillToolNames = [];
    const toolDefs = [makeToolDef("remember"), makeToolDef("tool_b")];
    const ctx = makeProjectionCtx({
      subagentAllowedTools: new Set(["remember", "tool_b"]),
      toolScopeFilter: blockTools("tool_b"),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    expect(resolve(EMPTY_HISTORY).map((t) => t.name)).toEqual(["remember"]);
  });
});

// ---------------------------------------------------------------------------
// Executor — execution-time rejection
// ---------------------------------------------------------------------------

describe("createToolExecutor — toolScopeFilter", () => {
  test("rejects an out-of-scope call without invoking the executor", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      toolScopeFilter: blockTools("messaging_send"),
    });
    const toolFn = makeToolFn(executor, ctx);

    const result = (await toolFn("messaging_send", {
      to: "someone",
    })) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside this agent's tool scopes");
    expect(calls).toHaveLength(0);
  });

  test("in-scope calls execute normally", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      toolScopeFilter: blockTools("messaging_send"),
    });
    const toolFn = makeToolFn(executor, ctx);

    const result = (await toolFn("remember", {
      content: "note",
    })) as ToolExecutionResult;

    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["remember"]);
  });

  test("gates the resolved inner tool of skill_execute, not the wrapper", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const ctx = makeSetupCtx({
      toolScopeFilter: blockTools("messaging_send"),
    });
    const toolFn = makeToolFn(executor, ctx);

    const rejected = (await toolFn("skill_execute", {
      tool: "messaging_send",
      input: { to: "someone" },
    })) as ToolExecutionResult;
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("outside this agent's tool scopes");
    expect(calls).toHaveLength(0);

    const allowed = (await toolFn("skill_execute", {
      tool: "task_list_add",
      input: {},
    })) as ToolExecutionResult;
    expect(allowed.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["task_list_add"]);
  });

  test("no filter → no gating (regression)", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor, makeSetupCtx());

    const result = (await toolFn("messaging_send", {})) as ToolExecutionResult;

    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["messaging_send"]);
  });
});
