/**
 * The autonomy policy binds in unattended runs — outcome test.
 *
 * The July rogue-send incident (a background run emailed a partner with no
 * approval) was closed four times over, at four different ranks. This is the
 * fifth, and it was the one actually load-bearing: the guardian
 * non-interactive auto-approve branch in `PermissionChecker` compared risk
 * against the background threshold and NEVER consulted `autonomyAskEnforced`.
 * The owner's `send → ask` policy therefore did nothing at all in an
 * unattended run. Risk level was the only thing between a send and its
 * execution — which is why a Composio server carrying a blanket
 * `defaultRiskLevel: "low"` was a live hole rather than a theoretical one,
 * and why closing it accidentally (migration 106, 2026-08-16, which moved
 * those servers to "high") was luck rather than a guarantee.
 *
 * Every test below forces risk to LOW, which is the exact condition that used
 * to make these calls succeed. If the guard is removed, they go green again
 * as allowed.
 *
 * The seam faked here is the gateway IPC transport, and only that. Everything
 * downstream — classifyRisk, check(), DefaultApprovalPolicy, the autonomy
 * classifier, and PermissionChecker itself — is the real code, at the real
 * thresholds and the real policy read off `cue-manav-prod`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import "../../__tests__/test-preload.js";

// ── Gateway IPC transport (the only seam) ────────────────────────────────────

/**
 * Manav's production thresholds. There is no row in `auto_approve_thresholds`
 * on his instance, so the gateway's GLOBAL_DEFAULTS apply. Re-read from
 * `cue-manav-prod` while writing this file.
 */
const PROD_THRESHOLDS = {
  interactive: "medium",
  autonomous: "low",
  headless: "none",
};

/**
 * Read from the same instance's `autonomy_category_policies` table. Note that
 * `publish` and `contact` have no rows there; the reader fills them from its
 * fail-closed defaults, which are also "ask".
 */
const PROD_AUTONOMY = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  other: "auto",
};

/**
 * Forced risk level. Every send/delete case here sets this to "low" — the
 * value that used to buy an unattended send a `guardian_auto_approve`.
 */
let forcedRisk: "low" | "medium" | "high" = "low";

const gatewayClientActual = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...gatewayClientActual,
  ipcClassifyRisk: async () => ({
    risk: forcedRisk,
    reason: `forced ${forcedRisk} for this test`,
    scopeOptions: [],
    matchType: "unknown",
  }),
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

/** The context a scheduled job, watcher or standing agent runs under. */
const UNATTENDED: ToolContext = {
  conversationId: "conv-standing-agent",
  isInteractive: false,
  trustClass: "guardian",
  workingDir: "/workspace",
} as unknown as ToolContext;

async function decideUnattended(
  toolName: string,
  input: Record<string, unknown> = {},
) {
  return new PermissionChecker(neverPrompts).checkPermission(
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
  forcedRisk = "low";
});

// ── The exact case that used to be allowed ───────────────────────────────────

describe("an unattended send is refused at any risk level", () => {
  test("GMAIL_SEND_EMAIL is denied even with its risk forced to low", async () => {
    // Before the guard: `allowed: true, decision: "guardian_auto_approve"`.
    const decision = await decideUnattended(
      "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    );

    expect(decision.allowed).toBe(false);
    // Low risk, and refused anyway. That is the whole point: the owner drew
    // the line at a class of action, not at a severity.
    expect(decision.riskLevel).toBe("low");
    expect(decision.approvalReason).toBe("autonomy_policy_ask");
    expect(decision.approvalMode).toBe("blocked");
  });

  test("a delete-class action is denied even with its risk forced to low", async () => {
    const decision = await decideUnattended("mcp__acme_crm__delete_record");

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("low");
    expect(decision.approvalReason).toBe("autonomy_policy_ask");
  });

  test("a destructive bash command is denied even with its risk forced to low", async () => {
    // The delete class is not only a connector concern — `classifyAutonomy`
    // reads the command itself for bash.
    const decision = await decideUnattended("bash", {
      command: "rm -rf /workspace/data",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("low");
    expect(decision.approvalReason).toBe("autonomy_policy_ask");
  });

  test("a money-class action is denied even with its risk forced to low", async () => {
    const decision = await decideUnattended(
      "mcp__composio_stripe__STRIPE_CREATE_REFUND",
    );

    expect(decision.allowed).toBe(false);
    expect(decision.approvalReason).toBe("autonomy_policy_ask");
  });
});

// ── What must keep working ───────────────────────────────────────────────────

describe("reads and drafts still run unattended", () => {
  // This is what the owner asked to have restored on 2026-08-16 after every
  // Composio connector went to a blanket "high" and stopped working. The
  // guard above must not take it away again.
  const STILL_ALLOWED = [
    "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST",
    "mcp__composio_gmail__GMAIL_FETCH_EMAILS",
    "mcp__composio_gmail__GMAIL_CREATE_EMAIL_DRAFT",
    "mcp__composio_googledrive__GOOGLEDRIVE_FIND_FILE",
    "mcp__composio__COMPOSIO_SEARCH_TOOLS",
  ];

  for (const tool of STILL_ALLOWED) {
    test(`${tool} is allowed`, async () => {
      const decision = await decideUnattended(tool);

      expect(decision.allowed).toBe(true);
      expect(decision.decision).toBe("allow");
    });
  }

  test("a non-destructive bash command is allowed", async () => {
    // Every guardian-auto-approved bash on the production instance is of this
    // shape: ls, grep, echo, status checks.
    const decision = await decideUnattended("bash", {
      command: "ls -lt /workspace/data | head -5",
    });

    expect(decision.allowed).toBe(true);
  });
});

// ── Interactive sessions are untouched ───────────────────────────────────────

describe("a person present still gets asked, not refused", () => {
  test("an interactive send prompts rather than being denied outright", async () => {
    let promptedFor: string | undefined;
    const recordingPrompter = {
      prompt: async (name: string) => {
        promptedFor = name;
        return { decision: "allow" as const };
      },
    } as unknown as PermissionPrompter;

    const decision = await new PermissionChecker(
      recordingPrompter,
    ).checkPermission(
      "mcp__composio_gmail__GMAIL_SEND_EMAIL",
      {},
      toolNamed("mcp__composio_gmail__GMAIL_SEND_EMAIL"),
      {
        conversationId: "conv-with-a-human",
        isInteractive: true,
        trustClass: "guardian",
        workingDir: "/workspace",
      } as unknown as ToolContext,
      "host",
      () => {},
      Date.now(),
      () => undefined,
    );

    // The human was asked, and their answer stood.
    expect(promptedFor).toBe("mcp__composio_gmail__GMAIL_SEND_EMAIL");
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.wasPrompted).toBe(true);
  });
});

// ── The two denials must not be confused in the logs ─────────────────────────

describe("the deny reason says which rule stopped it", () => {
  test("an autonomy-class denial does not read as a risk-threshold denial", async () => {
    const decision = await decideUnattended(
      "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    );

    expect(decision.allowed).toBe(false);
    const content = decision.allowed === false ? decision.content : "";

    // Names the class and the policy, and says plainly that risk was not the
    // reason — so nobody reading this later tries to fix it with a threshold.
    expect(content).toContain("send-class");
    expect(content).toContain('set to "ask"');
    expect(content).toContain("not a risk-threshold denial");
    // And it does not send the reader after a trust rule, which is evaluated
    // AFTER the autonomy mode and cannot override it.
    expect(content).not.toContain("add a trust rule");
  });

  test("a risk-threshold denial keeps its own distinct reason", async () => {
    // "other" class, so the autonomy policy has nothing to say; the risk tier
    // is what refuses it.
    forcedRisk = "high";
    const decision = await decideUnattended(
      "mcp__composio_googlecalendar__GOOGLECALENDAR_UPDATE_EVENT",
    );

    expect(decision.allowed).toBe(false);
    expect(decision.approvalReason).toBe("no_interactive_client");
    expect(decision.allowed === false && decision.content).toContain(
      "no interactive client is connected",
    );
  });

  test("the two denials carry different structured reasons", async () => {
    const send = await decideUnattended(
      "mcp__composio_gmail__GMAIL_SEND_EMAIL",
    );

    clearRiskCache();
    forcedRisk = "high";
    const risky = await decideUnattended(
      "mcp__composio_googledrive__GOOGLEDRIVE_MOVE_FILE",
    );

    expect(send.allowed).toBe(false);
    expect(risky.allowed).toBe(false);
    expect(send.approvalReason).not.toBe(risky.approvalReason);
  });
});
