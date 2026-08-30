/**
 * The autonomy-ledger hook inside `ToolExecutor` — the single chokepoint every
 * tool call passes through.
 *
 * These tests pin the two properties the ledger exists for:
 *   1. every CONSEQUENTIAL outcome is recorded (executed / parked / denied /
 *      failed) with honest approval provenance, and nothing else is;
 *   2. the ledger can NEVER affect the tool path — a store that throws leaves
 *      the tool result untouched.
 *
 * The store is mocked so the real classifier + description path runs and the
 * assertions see exactly the row that would have been persisted.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import type { Tool, ToolExecutionResult } from "../tools/types.js";

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 60,
  },
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: { enabled: false },
  permissions: {},
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };
let toolThrows: Error | undefined;
let checkDecision: { decision: string; reason: string } = {
  decision: "allow",
  reason: "allowed",
};

/** Rows the executor asked the ledger to persist. */
interface CapturedEntry {
  toolName: string;
  actionClass: string;
  summary: string;
  target: string | null;
  outcome: string;
  attended: boolean;
  approvedVia: string | null;
  reason?: string | null;
}
let captured: CapturedEntry[] = [];
let storeThrows = false;

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: "low" }),
  check: async () => checkDecision,
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
  getCachedAssessment: () => undefined,
}));

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
}));

mock.module("../ledger/autonomy-ledger-store.js", () => ({
  recordAutonomyLedgerEntry: (entry: CapturedEntry) => {
    if (storeThrows) throw new Error("ledger table is gone");
    captured.push(entry);
    return entry;
  },
  pruneAutonomyLedger: () => 0,
  listAutonomyLedger: () => [],
  getAutonomyLedgerSummary: () => ({}),
  LEDGER_RETENTION_DAYS: 180,
  LEDGER_MAX_ROWS: 20_000,
  __resetLedgerPruneCounterForTests: () => {},
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string): Tool | undefined => ({
    name,
    description: "test tool",
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: {},
    execute: async () => {
      if (toolThrows) throw toolThrows;
      return fakeToolResult;
    },
  }),
  getAllTools: () => [],
  getToolOwner: () => undefined,
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
    ...overrides,
  };
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

const SEND = {
  name: "gmail__GMAIL_SEND_EMAIL",
  input: { to: "partner@acme.com", subject: "Q3 partnership" },
};

beforeEach(() => {
  captured = [];
  storeThrows = false;
  toolThrows = undefined;
  fakeToolResult = { content: "ok", isError: false };
  checkDecision = { decision: "allow", reason: "allowed" };
});

describe("ToolExecutor → autonomy ledger", () => {
  test("stays silent for non-consequential tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    await executor.execute("file_read", { path: "README.md" }, makeContext());
    await executor.execute("web_search", { query: "x" }, makeContext());
    expect(captured).toHaveLength(0);
  });

  test("records an executed send with its recipient and approval provenance", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    const [row] = captured;
    expect(row.actionClass).toBe("send");
    expect(row.outcome).toBe("executed");
    expect(row.target).toBe("partner@acme.com");
    expect(row.attended).toBe(true);
    // Attended high-consequence actions force a fresh confirmation, so the
    // owner's own answer is what authorised this.
    expect(row.approvedVia).toBe("inline_card");
    expect(row.summary).toContain("partner@acme.com");
  });

  test("records the rogue-send shape: an unattended send parks, never executes", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: false }),
    );

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(1);
    const [row] = captured;
    expect(row.outcome).toBe("parked");
    expect(row.attended).toBe(false);
    // Nothing was authorised — the ledger must not claim otherwise.
    expect(row.approvedVia).toBeNull();
    expect(row.summary).toContain("needs your approval");
  });

  test("records a denial when the permission check refuses", async () => {
    checkDecision = { decision: "deny", reason: "Blocked by deny rule: send" };
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: true }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("denied");
    expect(captured[0].approvedVia).toBeNull();
  });

  test("records a failure when the tool throws", async () => {
    toolThrows = new Error("gmail 500");
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: true }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("failed");
  });

  test("records a failure when the tool reports its own error", async () => {
    fakeToolResult = { content: "rate limited", isError: true };
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: true }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe("failed");
  });

  test("a broken ledger never breaks the tool call", async () => {
    storeThrows = true;
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      SEND.name,
      SEND.input,
      makeContext({ isInteractive: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("ok");
    expect(captured).toHaveLength(0);
  });

  test("host file mutations are recorded even though the gate lets them run", async () => {
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "host_file_write",
      { path: "/Users/me/notes.md", content: "hi" },
      makeContext({ isInteractive: false }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].actionClass).toBe("host_file");
    expect(captured[0].outcome).toBe("executed");
    expect(captured[0].target).toBe("/Users/me/notes.md");
  });
});
