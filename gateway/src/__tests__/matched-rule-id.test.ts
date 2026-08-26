/**
 * A classification a saved rule decided has to name the rule.
 *
 * `tool_invocations.matched_trust_rule_id` was added for this audit and had
 * never held a value. The gateway knew a rule had fired and returned only the
 * risk it produced, so the daemon could see that *some* rule matched and never
 * which one. On the owner's instance: 828 saved rules, and zero recorded uses
 * across roughly ten thousand invocations. A rules surface cannot say "last
 * used" or "used 40 times" from that, and design's A3 listing asks for both.
 *
 * The second test is the one that keeps the audit honest. A rule sets a base
 * risk, but the registry's arg rules can take the decision back afterwards —
 * and when they do, crediting the rule would attribute a level it did not set.
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import { BashRiskClassifier } from "../risk/bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry/index.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import "./test-preload.js";

let store: TrustRuleStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleStore();
});

afterEach(() => {
  resetTrustRuleCache();
  resetGatewayDb();
});

function classifier() {
  return new BashRiskClassifier(DEFAULT_COMMAND_REGISTRY, []);
}

describe("matched rule id", () => {
  test("a user rule that decides the risk names itself", async () => {
    const created = store.create({
      tool: "bash",
      pattern: "ls",
      risk: "high",
      description: "a rule the owner saved",
    });

    initTrustRuleCache(store);
    const result = await classifier().classify({
      command: "ls",
      toolName: "bash",
    });

    expect(result.matchType).toBe("user_rule");
    expect(result.matchedRuleId).toBe(created.id);
  });

  // Nothing but the registry decided it, so nothing may be credited.
  test("a registry decision carries no rule id", async () => {
    initTrustRuleCache(store);
    const result = await classifier().classify({
      command: "cat README.md",
      toolName: "bash",
    });

    expect(result.matchType).toBe("registry");
    expect(result.matchedRuleId).toBeUndefined();
  });
});
