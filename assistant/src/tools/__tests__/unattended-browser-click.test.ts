/**
 * Unattended browser clicking — outcome test.
 *
 * A background task can see a page but not press its button: `browser_click`
 * is Medium risk, the background auto-approve threshold is Low, and a
 * background run has no client to answer a prompt, so the checker auto-denies.
 * Reads (`browser_navigate`, `browser_snapshot`, `browser_extract`) are Low
 * and go through. The first describe block below is that denial, reproduced.
 *
 * The fix is a whole-tool trust rule (`{tool, pattern:"*"}`) that the gateway
 * now honours for tools with no risk classifier, lowering that one tool to
 * Low. This file asserts the thing that actually matters — the DECISION the
 * permission checker reaches for an unattended guardian run — rather than the
 * presence of a rule.
 *
 * The seam faked here is the gateway IPC transport, and only that: the values
 * it returns are the ones the real gateway produces, pinned next door in
 * `gateway/src/__tests__/whole-tool-trust-rule.test.ts` (classification) and
 * read from Manav's production gateway DB (thresholds `interactive: medium`
 * / `autonomous: low` / `headless: none`, autonomy `other: auto`). Everything
 * downstream — classifyRisk, check(), DefaultApprovalPolicy, the autonomy
 * classifier, and the non-interactive branch of PermissionChecker — is the
 * real code.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import "../../__tests__/test-preload.js";

// ── Gateway IPC transport (the only seam) ────────────────────────────────────

interface FakeClassification {
  risk: "low" | "medium" | "high";
  reason: string;
  matchType: "user_rule" | "registry" | "unknown";
}

/** Tool name → what the gateway's classifier returns for it. */
let classifications: Record<string, FakeClassification> = {};

/** Exactly what Manav's production gateway returns today. */
const PROD_THRESHOLDS = {
  interactive: "medium",
  autonomous: "low",
  headless: "none",
};
const PROD_AUTONOMY = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  other: "auto",
};

const gatewayClientActual = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...gatewayClientActual,
  ipcClassifyRisk: async (params: { tool: string }) => {
    const hit = classifications[params.tool];
    if (!hit) throw new Error(`test did not stub a risk for ${params.tool}`);
    return { ...hit, scopeOptions: [] };
  },
  ipcCall: async (method: string) => {
    if (method === "get_global_thresholds") return PROD_THRESHOLDS;
    if (method === "get_autonomy_policies") return PROD_AUTONOMY;
    if (method === "get_conversation_threshold") return null;
    return undefined;
  },
}));

// ── Imports after the seam is in place ───────────────────────────────────────

import { clearRiskCache } from "../../permissions/checker.js";
import { _clearGlobalCacheForTesting } from "../../permissions/gateway-threshold-reader.js";
import type { PermissionPrompter } from "../../permissions/prompter.js";
import { PermissionChecker } from "../permission-checker.js";
import type { Tool, ToolContext } from "../types.js";

// ── Harness ──────────────────────────────────────────────────────────────────

/** A prompter that fails loudly: an unattended run must never reach it. */
const neverPrompts = {
  prompt: () => {
    throw new Error("an unattended run must never surface a prompt");
  },
} as unknown as PermissionPrompter;

function toolNamed(name: string): Tool {
  return { name, executionTarget: "host" } as unknown as Tool;
}

/** The context a scheduled/background task runs under: guardian, no client. */
const UNATTENDED: ToolContext = {
  conversationId: "conv-cx784-checkin",
  isInteractive: false,
  trustClass: "guardian",
  workingDir: "/workspace",
} as unknown as ToolContext;

async function decide(toolName: string, input: Record<string, unknown> = {}) {
  const checker = new PermissionChecker(neverPrompts);
  return checker.checkPermission(
    toolName,
    input,
    toolNamed(toolName),
    UNATTENDED,
    "host",
    () => {},
    Date.now(),
    () => undefined,
  );
}

beforeEach(() => {
  clearRiskCache();
  _clearGlobalCacheForTesting();
  classifications = {};
});

// ── The failure, reproduced ──────────────────────────────────────────────────

describe("before the rule exists", () => {
  test("an unattended browser_click is denied", async () => {
    classifications.browser_click = {
      risk: "medium",
      reason: "Unknown tool: browser_click",
      matchType: "unknown",
    };

    const decision = await decide("browser_click", { element_id: "e14" });

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("medium");
    expect(decision.allowed === false && decision.content).toContain(
      "no interactive client is connected",
    );
  });

  test("the reads that always worked still work", async () => {
    classifications.browser_snapshot = {
      risk: "low",
      reason: "Unknown tool: browser_snapshot",
      matchType: "unknown",
    };

    expect((await decide("browser_snapshot")).allowed).toBe(true);
  });
});

// ── The outcome the rule buys ────────────────────────────────────────────────

describe("with the whole-tool rule in place", () => {
  const WRITE_OPS = ["browser_click", "browser_type", "browser_press_key"];

  for (const op of WRITE_OPS) {
    test(`an unattended ${op} is allowed`, async () => {
      classifications[op] = {
        risk: "low",
        reason: `${op} — unattended browser interaction`,
        matchType: "user_rule",
      };

      const decision = await decide(op, { element_id: "e14", text: "MG" });

      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe("low");
      // Allowed on the ordinary risk-vs-threshold path — not by a temporary
      // override, a platform shortcut, or a prompt nobody could answer.
      expect(decision.decision).toBe("allow");
    });
  }
});

// ── Nothing else moved ───────────────────────────────────────────────────────

describe("the rest of the medium-risk surface is untouched", () => {
  // Each of these is a Medium-risk tool the rule does not name. They must
  // still auto-deny unattended, exactly as they did before — a background run
  // emailing a partner unprompted is the failure this scoping exists to
  // avoid.
  const STILL_DENIED = [
    "host_file_write",
    "host_bash",
    "mcp__gmail__send_email",
    "browser_fill_credential",
  ];

  for (const name of STILL_DENIED) {
    test(`${name} is still denied unattended`, async () => {
      classifications[name] = {
        risk: "medium",
        reason: "medium risk",
        matchType: "unknown",
      };

      const decision = await decide(name, {});

      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.content).toContain(
        "no interactive client is connected",
      );
    });
  }

  test("a High-risk tool is denied even if a rule tried to name it", async () => {
    // A whole-tool rule can lower a tool to Low, so the ceiling is worth
    // pinning: nothing here lets High risk through unattended.
    classifications.some_dangerous_tool = {
      risk: "high",
      reason: "high risk",
      matchType: "user_rule",
    };

    expect((await decide("some_dangerous_tool")).allowed).toBe(false);
  });
});
