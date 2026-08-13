/**
 * End-to-end guard: a temporary approval override (allow_10m /
 * allow_conversation) must NEVER auto-approve a send/money/delete/publish/
 * contact-class action.
 *
 * The override suite in permission-checker-temporary-overrides.test.ts proves
 * the checker honours the `autonomyAskEnforced` flag, but it injects that flag
 * at the seam. This file closes the remaining link by driving the REAL chain
 * with no mock on the policy path:
 *
 *   classifyAutonomy(tool) → getAutonomyPolicy() → DefaultApprovalPolicy
 *     → PermissionCheckResult.autonomyAskEnforced
 *
 * It also pins the fail-closed premise the whole guarantee rests on: with the
 * gateway unreachable (the case in this test environment, and the case during
 * an outage in production), the policy reader must still answer "ask" for the
 * consequential categories. If someone ever defaults `send` to "auto", this
 * test fails — which is the point. A 10-minute grant re-opening the silent
 * outbound-send path is the guardian-bypass class behind the July rogue-send
 * incident.
 */
import { describe, expect, test } from "bun:test";

import { DefaultApprovalPolicy } from "../permissions/approval-policy.js";
import { classifyAutonomy } from "../permissions/autonomy-class.js";
import { getAutonomyPolicy } from "../permissions/autonomy-policy-reader.js";
import { RiskLevel } from "../permissions/types.js";

const CONSEQUENTIAL: string[] = [
  "send_email",
  "messaging_send",
  "delete_file",
  "money_transfer",
];

describe("temporary overrides cannot cover consequential autonomy classes", () => {
  test("the policy reader answers 'ask' for consequential classes when the gateway is unreachable", async () => {
    const policy = await getAutonomyPolicy();
    for (const category of [
      "send",
      "money",
      "delete",
      "publish",
      "contact",
      "other",
    ] as const) {
      expect(policy[category]).not.toBe("auto");
    }
  });

  for (const toolName of CONSEQUENTIAL) {
    test(`${toolName} resolves to an autonomy-enforced prompt, which the override path refuses to auto-approve`, async () => {
      const autonomyClass = classifyAutonomy(toolName, {});
      const policy = await getAutonomyPolicy();
      const autonomyMode = policy[autonomyClass];

      // The category is gated, so the policy must force a prompt regardless of
      // how permissive the risk threshold is.
      const decision = new DefaultApprovalPolicy().evaluate({
        riskLevel: RiskLevel.Low,
        toolName,
        isContainerized: false,
        isWorkspaceScoped: false,
        isSkillBundled: false,
        hasManifestOverride: false,
        // Deliberately the most permissive threshold available: an override
        // must not be reachable even when everything else would auto-approve.
        autoApproveUpTo: "high",
        hasSandboxAutoApprove: false,
        autonomyClass,
        autonomyMode,
      });

      expect(decision.decision).toBe("prompt");
      // This is the flag permission-checker.ts consults; when true the
      // temporary-override branch is skipped and a human answers the prompt.
      expect(decision.enforcedByAutonomyPolicy).toBe(true);
    });
  }
});
