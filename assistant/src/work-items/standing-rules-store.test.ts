/**
 * Tests for the standing auto-confirm rules store (the "Make it a rule"
 * persistence): CRUD + idempotency, and the pure matcher that the work-item
 * auto-run gate consults — including the literal-scope guards that keep a rule
 * from broadening autonomy beyond what it names.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  type AutoRunItemFacts,
  createStandingRule,
  deleteStandingRule,
  findAuthorizingStandingRule,
  getStandingRule,
  invalidateStandingRuleCache,
  listEnabledStandingRulesCached,
  listStandingRules,
  ruleAuthorizesAutoRun,
  ruleMatchesItem,
  updateStandingRule,
} from "./standing-rules-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM standing_rules");
  invalidateStandingRuleCache();
});

function facts(overrides: Partial<AutoRunItemFacts> = {}): AutoRunItemFacts {
  return {
    channel: null,
    sourceId: null,
    provenanceText: "",
    classes: ["other"],
    tools: [],
    blockedClasses: ["other"],
    ...overrides,
  };
}

describe("createStandingRule", () => {
  test("creates a rule with an auto-generated label + defaults", () => {
    const rule = createStandingRule({
      triggerType: "sender",
      triggerValue: "Rachel",
      sourceWorkItemId: "wi-1",
    });
    expect(rule.id).toBeTruthy();
    expect(rule.triggerType).toBe("sender");
    expect(rule.triggerValue).toBe("Rachel");
    expect(rule.action).toBe("auto_confirm");
    expect(rule.enabled).toBe(1);
    expect(rule.label).toBe("Auto-confirm anything from Rachel");
    expect(rule.sourceWorkItemId).toBe("wi-1");
    expect(listStandingRules()).toHaveLength(1);
  });

  test("is idempotent: same trigger + action returns the existing rule (no duplicate)", () => {
    const a = createStandingRule({ triggerType: "channel", triggerValue: "slack" });
    const b = createStandingRule({
      triggerType: "channel",
      triggerValue: "Slack", // different case — still the same rule
      sourceWorkItemId: "wi-9",
    });
    expect(b.id).toBe(a.id);
    expect(listStandingRules()).toHaveLength(1);
    // Provenance is refreshed to the latest source on the idempotent hit.
    expect(getStandingRule(a.id)!.sourceWorkItemId).toBe("wi-9");
  });

  test("rejects an invalid trigger type and an empty value", () => {
    expect(() =>
      createStandingRule({
        triggerType: "nonsense" as never,
        triggerValue: "x",
      }),
    ).toThrow();
    expect(() =>
      createStandingRule({ triggerType: "sender", triggerValue: "   " }),
    ).toThrow();
  });
});

describe("update / delete / cache", () => {
  test("toggling enabled off drops it from the cached enabled read", () => {
    const rule = createStandingRule({ triggerType: "channel", triggerValue: "slack" });
    expect(listEnabledStandingRulesCached().map((r) => r.id)).toEqual([rule.id]);
    updateStandingRule(rule.id, { enabled: 0 });
    // Mutation invalidates the cache — the disabled rule is gone immediately.
    expect(listEnabledStandingRulesCached()).toEqual([]);
  });

  test("delete removes the rule", () => {
    const rule = createStandingRule({ triggerType: "sender", triggerValue: "Rachel" });
    deleteStandingRule(rule.id);
    expect(getStandingRule(rule.id)).toBeUndefined();
    expect(listEnabledStandingRulesCached()).toEqual([]);
  });
});

describe("ruleMatchesItem", () => {
  test("channel rule matches WorkItem.sourceType and the 'via <channel>' provenance", () => {
    const rule = { triggerType: "channel" as const, triggerValue: "slack" };
    expect(ruleMatchesItem(rule, facts({ channel: "slack" }))).toBe(true);
    expect(ruleMatchesItem(rule, facts({ channel: "Slack" }))).toBe(true);
    expect(
      ruleMatchesItem(
        rule,
        facts({ provenanceText: "From: Rachel via slack — hi" }),
      ),
    ).toBe(true);
    expect(ruleMatchesItem(rule, facts({ channel: "email" }))).toBe(false);
  });

  test("sender rule matches the 'From: <name>' provenance and sourceId", () => {
    const rule = { triggerType: "sender" as const, triggerValue: "Rachel" };
    expect(
      ruleMatchesItem(
        rule,
        facts({ provenanceText: "From: Rachel Kim via slack — ping" }),
      ),
    ).toBe(true);
    expect(ruleMatchesItem(rule, facts({ sourceId: "rachel" }))).toBe(true);
    expect(
      ruleMatchesItem(rule, facts({ provenanceText: "From: Marco via slack" })),
    ).toBe(false);
  });

  test("category and tool rules match the item's classes / tools", () => {
    expect(
      ruleMatchesItem(
        { triggerType: "category", triggerValue: "delete" },
        facts({ classes: ["delete", "other"] }),
      ),
    ).toBe(true);
    expect(
      ruleMatchesItem(
        { triggerType: "tool", triggerValue: "web_fetch" },
        facts({ tools: ["web_fetch"] }),
      ),
    ).toBe(true);
  });
});

describe("ruleAuthorizesAutoRun (literal-scope guards)", () => {
  test("a sender rule clears whatever the policy would have asked for that sender", () => {
    const rule = {
      triggerType: "sender" as const,
      triggerValue: "Rachel",
      action: "auto_confirm" as const,
    };
    expect(
      ruleAuthorizesAutoRun(
        rule,
        facts({
          provenanceText: "From: Rachel via slack",
          classes: ["other"],
          blockedClasses: ["other"],
        }),
      ),
    ).toBe(true);
  });

  test("a category rule does NOT clear a block for a different category", () => {
    const rule = {
      triggerType: "category" as const,
      triggerValue: "draft",
      action: "auto_confirm" as const,
    };
    // Item is blocked on 'delete', not 'draft' — the draft rule must not authorize.
    expect(
      ruleAuthorizesAutoRun(
        rule,
        facts({ classes: ["draft", "delete"], blockedClasses: ["delete"] }),
      ),
    ).toBe(false);
    // When 'delete' is the only class and it's exactly what a 'delete' rule
    // names, that rule authorizes.
    expect(
      ruleAuthorizesAutoRun(
        { triggerType: "category", triggerValue: "delete", action: "auto_confirm" },
        facts({ classes: ["delete"], blockedClasses: ["delete"] }),
      ),
    ).toBe(true);
  });

  test("returns false when nothing is blocked (nothing to authorize)", () => {
    expect(
      ruleAuthorizesAutoRun(
        { triggerType: "sender", triggerValue: "Rachel", action: "auto_confirm" },
        facts({ provenanceText: "From: Rachel via slack", blockedClasses: [] }),
      ),
    ).toBe(false);
  });

  test("findAuthorizingStandingRule consults only enabled rules", () => {
    const rule = createStandingRule({ triggerType: "channel", triggerValue: "slack" });
    const f = facts({ channel: "slack", classes: ["other"], blockedClasses: ["other"] });
    expect(findAuthorizingStandingRule(f)?.id).toBe(rule.id);
    updateStandingRule(rule.id, { enabled: 0 });
    expect(findAuthorizingStandingRule(f)).toBeNull();
  });
});
