/**
 * What a connector tool's verb buys it in an unattended run — outcome test.
 *
 * On 2026-08-16 migration 106 removed the auto-written `defaultRiskLevel:
 * "low"` from every auto-provisioned Composio server so the schema's
 * fail-closed `"high"` would apply. The justification was that this was inert
 * "because nothing auto-approves while the owner's threshold sits at its
 * default of none". That was wrong: an unset threshold means the gateway's
 * GLOBAL_DEFAULTS apply, and those are `interactive: medium` / `autonomous:
 * low` / `headless: none`. Only headless is Strict. Every Composio connector
 * — calendar, Gmail, Drive, Slack — went from working to denied in voice and
 * background runs.
 *
 * Risk for these tools no longer comes from the server at all. It comes from
 * the verb in the operation name, and this file proves what that produces at
 * the far end of the real decision path.
 *
 * The seam faked here is the gateway IPC transport, and only that. Risk is
 * computed by the REAL classifier — `classifyConnectorTool`, imported from the
 * gateway package — not by a table written for this test. Its routing (the
 * MCP-namespace gate, and a user-authored trust rule still winning over it) is
 * pinned next door in `gateway/src/__tests__/connector-verb-risk.test.ts`.
 * Everything downstream — classifyRisk, check(), DefaultApprovalPolicy, the
 * autonomy classifier, and the non-interactive branch of PermissionChecker —
 * is the real code.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import "../../__tests__/test-preload.js";

// ── Gateway IPC transport (the only seam) ────────────────────────────────────

/**
 * The gateway's real connector classifier. Imported dynamically for the same
 * reason everything below the mock is: nothing may be pulled in ahead of the
 * test preload, which is what points this process at a throwaway workspace.
 */
const { classifyConnectorTool } =
  await import("../../../../gateway/src/risk/connector-risk-classifier.js");

/**
 * Exactly what Manav's production gateway returns today: no row in
 * `auto_approve_thresholds`, so the gateway's GLOBAL_DEFAULTS apply. Re-read
 * from `cue-manav-prod` while writing this file, because the claim that this
 * was `none` is what caused the regression above.
 */
const PROD_THRESHOLDS = {
  interactive: "medium",
  autonomous: "low",
  headless: "none",
};

/** Read from the same instance's `autonomy_category_policies` table. */
const PROD_AUTONOMY = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  other: "auto",
};

/** Set by a test that wants the pre-fix behaviour instead of the classifier. */
let forcedRisk: "low" | "medium" | "high" | null = null;

const gatewayClientActual = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...gatewayClientActual,
  ipcClassifyRisk: async (params: { tool: string }) => {
    if (forcedRisk) {
      return {
        risk: forcedRisk,
        reason: `server default ${forcedRisk}`,
        scopeOptions: [],
        matchType: "unknown",
      };
    }
    const assessment = classifyConnectorTool(params.tool);
    return {
      risk: assessment.riskLevel,
      reason: assessment.reason,
      scopeOptions: [],
      matchType: assessment.matchType,
    };
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

/** The context a background run or a voice turn with no client runs under. */
const UNATTENDED: ToolContext = {
  conversationId: "conv-morning-brief",
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
  forcedRisk = null;
});

// ── The regression, reproduced ───────────────────────────────────────────────

describe("the regression this fixes", () => {
  test("a blanket server risk of high denied reading a calendar", async () => {
    // What the gateway returned for every Composio tool between 2026-08-16 and
    // this change: the server's `defaultRiskLevel`, straight through.
    forcedRisk = "high";

    const decision = await decide(
      "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.content).toContain(
      "no interactive client is connected",
    );
  });

  test("and a blanket server risk of low let a background run SEND MAIL", async () => {
    // What the gateway returned BEFORE 2026-08-16, from the provisioner's
    // auto-written `defaultRiskLevel: "low"`. Both blanket values are wrong;
    // the blanket is what is wrong.
    forcedRisk = "low";

    const decision = await decide("mcp__composio_gmail__GMAIL_SEND_EMAIL");

    // Allowed. Not prompted, not denied — allowed, unattended, no human.
    expect(decision.allowed).toBe(true);
    expect(decision.decision).toBe("guardian_auto_approve");
  });

  test("the autonomy 'send → ask' policy does not stop it, and never did", async () => {
    // Worth stating plainly because it is easy to assume otherwise. The
    // autonomy classifier DOES read this tool as a send, and the owner's
    // policy for `send` IS "ask", so DefaultApprovalPolicy returns a prompt
    // with `enforcedByAutonomyPolicy`. But the guardian branch of
    // PermissionChecker (the one an unattended run takes) re-checks that
    // prompt against the BACKGROUND THRESHOLD and consults risk only — it
    // does not look at `autonomyAskEnforced`, which only the temporary-
    // override branch further down honours.
    //
    // So in an unattended run, risk level is the ONLY thing between a send
    // and its execution. That is what makes the verb taxonomy load-bearing
    // rather than a second opinion, and it is why a blanket low was a live
    // rogue-send hole for four days rather than a theoretical one.
    forcedRisk = "low";
    expect(
      (
        await decide(
          "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
        )
      ).allowed,
    ).toBe(true);

    // With risk derived from the verb, the same call is stopped.
    forcedRisk = null;
    clearRiskCache(); // the checker memoizes classifications per tool+input
    expect(
      (
        await decide(
          "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
        )
      ).allowed,
    ).toBe(false);
  });
});

// ── Reads and drafts come back ───────────────────────────────────────────────

describe("what the owner asked for: reading and drafting run unattended", () => {
  const ALLOWED = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    "mcp__composio_gmail__GMAIL_FETCH_EMAILS",
    "mcp__composio_googledrive__GOOGLEDRIVE_FIND_FILE",
    "mcp__composio_slack__SLACK_FETCH_CONVERSATION_HISTORY",
    "mcp__composio__COMPOSIO_SEARCH_TOOLS",
    "mcp__composio_gmail__GMAIL_CREATE_EMAIL_DRAFT",
    "mcp__composio_googlecalendar__GOOGLECALENDAR_CREATE_EVENT",
  ];

  for (const tool of ALLOWED) {
    test(`${tool} is allowed`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(true);
      expect(decision.riskLevel).toBe("low");
      // Allowed on the ordinary risk-vs-threshold path — not by a temporary
      // override, a platform shortcut, or a prompt nobody could answer.
      expect(decision.decision).toBe("allow");
    });
  }
});

// ── The line: send and delete ────────────────────────────────────────────────

describe("the line the owner drew holds", () => {
  const DENIED = [
    "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
    "mcp__composio_googlecalendar__GOOGLECALENDAR_DELETE_EVENT",
    "mcp__composio_googledrive__GOOGLEDRIVE_DELETE_FILE",
    "mcp__composio_googledrive__GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
    "mcp__composio_stripe__STRIPE_CREATE_REFUND",
  ];

  for (const tool of DENIED) {
    test(`${tool} is denied`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe("high");
      expect(decision.allowed === false && decision.content).toContain(
        "no interactive client is connected",
      );
    });
  }
});

// ── Fail closed ──────────────────────────────────────────────────────────────

describe("a connector we have never classified cannot widen anything", () => {
  const UNRECOGNISED = [
    "mcp__composio_docusign__DOCUSIGN_ENVELOPE_RECIPIENTS_CORRECT",
    "mcp__composio_zoom__ZOOM_INSTANT_MEETING",
    "mcp__acme_crm__acmeQuietlyDoesSomething",
    // Real, and the busiest tool on this instance: the router executes an
    // operation named in its ARGUMENTS. From the name alone it could be any
    // of the sends above.
    "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
  ];

  for (const tool of UNRECOGNISED) {
    test(`${tool} is denied unattended`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe("high");
    });
  }
});

// ── The medium tier ──────────────────────────────────────────────────────────

describe("modifying something that exists does not run unattended", () => {
  const MODIFIES = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_UPDATE_EVENT",
    "mcp__composio_googledrive__GOOGLEDRIVE_MOVE_FILE",
  ];

  for (const tool of MODIFIES) {
    test(`${tool} is denied unattended`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe("medium");
    });
  }
});
