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
    //
    // This case is now held by TWO independent guards. The verb classifier
    // rates a send "high", and — proven here by forcing the old blanket back
    // on — the autonomy policy denies the class outright even when risk says
    // low. Until that second guard existed, this exact line read
    // `expect(decision.allowed).toBe(true)`.
    forcedRisk = "low";

    const decision = await decide("mcp__composio_gmail__GMAIL_SEND_EMAIL");

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("low");
    expect(decision.allowed === false && decision.content).toContain(
      'set to "ask"',
    );
  });

  test("the autonomy 'send → ask' policy is what stops it, independent of risk", async () => {
    // Worth stating plainly, because for a long time the opposite was true.
    // The autonomy classifier reads this tool as a send, and the owner's
    // policy for `send` is "ask", so DefaultApprovalPolicy returns a prompt
    // carrying `enforcedByAutonomyPolicy`. The guardian branch of
    // PermissionChecker — the one an unattended run takes — used to re-check
    // that prompt against the BACKGROUND THRESHOLD and consult risk only,
    // never looking at `autonomyAskEnforced`. Risk level was the ONLY thing
    // between a send and its execution, which is why a blanket low was a
    // live rogue-send hole rather than a theoretical one.
    //
    // Now the class is decisive on its own: low risk, high risk, either way.
    forcedRisk = "low";
    const atLowRisk = await decide(
      "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
    );
    expect(atLowRisk.allowed).toBe(false);
    expect(atLowRisk.riskLevel).toBe("low");

    // And with risk derived from the verb, still stopped — now for both
    // reasons at once.
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
  // Split by WHY each one is refused, because the two reasons are not
  // interchangeable and the deny text says so. A class the owner set to
  // "ask" is refused by the autonomy policy and would be refused at any risk
  // level; everything else is refused for being over the background risk
  // threshold, and would run if the threshold moved.
  const DENIED_BY_AUTONOMY_CLASS = [
    "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    "mcp__composio_slack__SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
    "mcp__composio_stripe__STRIPE_CREATE_REFUND",
  ];

  for (const tool of DENIED_BY_AUTONOMY_CLASS) {
    test(`${tool} is denied by the autonomy policy`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe("high");
      expect(decision.approvalReason).toBe("autonomy_policy_ask");
      expect(decision.allowed === false && decision.content).toContain(
        'set to "ask"',
      );
    });
  }

  // These three are refused by the risk tier alone, and the deny text says
  // so rather than claiming a policy that did not fire.
  //
  // The two DELETEs are the interesting pair, and they are here on purpose.
  // `classifyAutonomy` matches its delete verbs as a PREFIX of the tool-name
  // suffix (`delete_`, `remove_`, `archive_`), but Composio names an
  // operation app-first — the suffix is `GOOGLECALENDAR_DELETE_EVENT`, not
  // `DELETE_EVENT`. So no Composio delete reaches the delete class; they all
  // land in "other", which the owner has set to auto. Only the send and
  // money classes catch connector tools today, because those two match a
  // SEGMENT anywhere in the name rather than a prefix.
  //
  // Nothing is open as a result — the verb risk classifier rates these high
  // and the background threshold is low — but connector deletes are held by
  // risk alone, with no second guard behind it. That is the same single-leg
  // arrangement that made the send hole live, and it is worth closing in
  // `permissions/autonomy-class.ts` rather than leaving it to be rediscovered.
  const DENIED_BY_RISK_TIER = [
    "mcp__composio_googledrive__GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
    "mcp__composio_googlecalendar__GOOGLECALENDAR_DELETE_EVENT",
    "mcp__composio_googledrive__GOOGLEDRIVE_DELETE_FILE",
  ];

  for (const tool of DENIED_BY_RISK_TIER) {
    test(`${tool} is denied on risk, not class`, async () => {
      const decision = await decide(tool);

      expect(decision.allowed).toBe(false);
      expect(decision.riskLevel).toBe("high");
      expect(decision.approvalReason).toBe("no_interactive_client");
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
