/**
 * Realtime-voice tool calls must leave a `tool_invocations` row.
 *
 * The defect this closes: the Gemini Live bridge built its own ToolExecutor
 * with no lifecycle handler, so NO realtime-voice tool call — executed,
 * errored, or denied — had ever been recorded in that table. On 2026-08-17 the
 * empty table was read as "voice called zero tools" and reported as fact; the
 * call had in fact asked for the user's Google Calendar and been auto-denied.
 *
 * These tests drive the REAL production path end to end: no `runRegistryTool`
 * seam, the real `ToolExecutor`, the real registry, the real audit listener,
 * and a real (test-workspace) database. The assertions are on the row's
 * contents — tool name, decision, risk level — because "a row exists" is the
 * claim that was already true for chat and false for voice.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Permission outcome is driven per-test. Spread the real module so the other
// exports (getCachedAssessment, generateScopeOptions, …) stay intact — a
// hand-written factory here would delete them process-wide.
let checkerDecision: "allow" | "prompt" | "deny" = "prompt";
let checkerRisk = "high";
const checkerActual = await import("../../permissions/checker.js");
mock.module("../../permissions/checker.js", () => ({
  ...checkerActual,
  classifyRisk: async () => ({ level: checkerRisk, reason: "test risk" }),
  check: async () => ({
    decision: checkerDecision,
    reason: "test policy says prompt",
  }),
}));

// The real reader does gateway IPC that has no socket in a test process.
// "low" is the shipped default background threshold — the value that makes a
// high-risk voice tool call deny, exactly as it did on prod.
const thresholdActual =
  await import("../../permissions/gateway-threshold-reader.js");
mock.module("../../permissions/gateway-threshold-reader.js", () => ({
  ...thresholdActual,
  getAutoApproveThreshold: async () => "low",
}));

const { getDb } = await import("../../memory/db-connection.js");
const { initializeDb } = await import("../../memory/db-init.js");
const { toolInvocations } = await import("../../memory/schema.js");
const { queryUnreportedToolExecutedEvents } =
  await import("../../memory/tool-executed-events-store.js");
const { registerTool, __resetRegistryForTesting } =
  await import("../../tools/registry.js");
const { RiskLevel } = await import("../../permissions/types.js");
const { executeGeminiLiveFunctionCall, GEMINI_LIVE_CALENDAR_EVENTS_TOOL } =
  await import("../gemini-live-tools.js");

initializeDb();

const CONVERSATION_ID = "conv-gemini-live-tool-audit";

/** Set when the registered calendar tool actually runs. */
let calendarToolRan = false;

registerTool({
  name: GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
  description: "Composio Google Calendar events.list (test double)",
  category: "mcp",
  defaultRiskLevel: RiskLevel.High,
  input_schema: { type: "object", properties: {} },
  execute: async () => {
    calendarToolRan = true;
    return {
      content: JSON.stringify({ items: [{ summary: "Standup" }] }),
      isError: false,
    };
  },
});

afterAll(() => {
  __resetRegistryForTesting();
});

function auditRows() {
  return getDb().select().from(toolInvocations).all();
}

describe("realtime voice tool calls land in tool_invocations", () => {
  beforeEach(() => {
    getDb().delete(toolInvocations).run();
    calendarToolRan = false;
    checkerDecision = "prompt";
    checkerRisk = "high";
  });

  test("a DENIED voice tool call produces a deny row (the event that was invisible)", async () => {
    // The prod shape being reproduced, from a real call at 12:33 on
    // 2026-08-17: a high-risk prompt-gated tool in a non-interactive voice
    // session is auto-denied by the permission checker.
    const out = await executeGeminiLiveFunctionCall(
      { id: "call-1", name: "get_calendar", args: {} },
      { conversationId: CONVERSATION_ID },
    );

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      toolName: GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
      decision: "denied",
      riskLevel: "high",
    });

    // The denial is real, not cosmetic: the tool never ran, and the model was
    // handed the needs-approval line rather than a fabricated calendar.
    expect(calendarToolRan).toBe(false);
    const response = out.response as { ok: boolean; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("needs the user's approval");
  });

  test("an EXECUTED voice tool call produces an allow row", async () => {
    checkerDecision = "allow";
    checkerRisk = "low";

    await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { conversationId: CONVERSATION_ID },
    );

    expect(calendarToolRan).toBe(true);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      toolName: GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
      decision: "allow",
      riskLevel: "low",
    });
  });

  test("an ERRORED voice tool call produces an error row", async () => {
    checkerDecision = "allow";
    checkerRisk = "low";

    // `web_search` is a declared voice function whose backing registry tool is
    // not registered in this process, so the executor's unknown-tool gate
    // fires. Same class of event as a dead MCP connector mid-call: the failure
    // the model then paraphrases aloud is now on the record too.
    await executeGeminiLiveFunctionCall(
      { name: "web_search", args: { query: "surf report canggu" } },
      { conversationId: CONVERSATION_ID },
    );

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      toolName: "web_search",
      decision: "error",
    });
    expect(rows[0].result).toContain("Unknown tool");
  });

  test("voice rows are audit-only: no off-device tool_executed projection", async () => {
    // Deliberate scope call. The telemetry columns attribute a tool execution
    // to the inference profile that drove it; the Gemini Live realtime model
    // has no entry in the `llm.callSites` attribution system, so there is
    // nothing truthful to report. NULL telemetry columns keep the local audit
    // row while the projection's `arg_bytes IS NOT NULL` filter excludes it —
    // the same mechanism that excludes usage-opted-out rows.
    checkerDecision = "allow";
    checkerRisk = "low";
    await executeGeminiLiveFunctionCall(
      { name: "get_calendar", args: {} },
      { conversationId: CONVERSATION_ID },
    );

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      argBytes: null,
      resultBytes: null,
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
    expect(queryUnreportedToolExecutedEvents(0, undefined, 100)).toHaveLength(
      0,
    );
  });
});
