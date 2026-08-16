/**
 * Whole-tool trust rules for classifier-less tools.
 *
 * Tools with a risk classifier (bash, file, web, skill, schedule) are already
 * governable by a trust rule scoped to a selector inside them. Tools without
 * one — browser, computer-use, MCP, connector tools — reach the classifier's
 * default branch, which knew only the tool registry's risk level. That made a
 * trust rule about such a tool inert: it would list in `trust list` and change
 * nothing.
 *
 * These tests pin the mechanism that closes that, and — just as importantly —
 * pin how narrow it is: one rule governs exactly the one tool it names, only
 * when the user authored it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import { riskClassificationRoutes } from "../ipc/risk-classification-handlers.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
  WHOLE_TOOL_PATTERN,
} from "../risk/trust-rule-cache.js";
import "./test-preload.js";

const classifyRiskHandler = riskClassificationRoutes.find(
  (r) => r.method === "classify_risk",
)!.handler;

async function classify(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await classifyRiskHandler(params)) as Record<string, unknown>;
}

/** How the assistant asks about a browser write op: medium in the registry. */
function browserWrite(tool: string): Record<string, unknown> {
  return { tool, registryDefaultRisk: "medium" };
}

describe("whole-tool trust rules", () => {
  let store: TrustRuleStore;

  beforeEach(async () => {
    resetGatewayDb();
    await initGatewayDb();
    store = new TrustRuleStore();
    // resetGatewayDb() closes the connection but the database file outlives
    // it, so rules written by an earlier test would otherwise leak into the
    // next one — and a leaked user rule is exactly what the seeded-default
    // test must not silently be reading.
    for (const rule of store.list({
      includeDeleted: true,
      origin: "user_defined",
    })) {
      store.remove(rule.id);
    }
  });

  afterEach(() => {
    resetTrustRuleCache();
    resetGatewayDb();
  });

  test("without a rule, a browser write op keeps its registry risk", async () => {
    initTrustRuleCache(store);

    const result = await classify(browserWrite("browser_click"));

    expect(result.risk).toBe("medium");
    expect(result.matchType).toBe("unknown");
  });

  test("a user rule lowers exactly the tool it names", async () => {
    store.create({
      tool: "browser_click",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "Clicking in an already-open page during unattended runs",
    });
    initTrustRuleCache(store);

    const clicked = await classify(browserWrite("browser_click"));
    expect(clicked.risk).toBe("low");
    expect(clicked.matchType).toBe("user_rule");
    expect(clicked.reason).toBe(
      "Clicking in an already-open page during unattended runs",
    );
  });

  test("a rule on one tool does not move its siblings", async () => {
    store.create({
      tool: "browser_click",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "click only",
    });
    initTrustRuleCache(store);

    // Same family, no rule of its own.
    expect((await classify(browserWrite("browser_type"))).risk).toBe("medium");
    // A completely unrelated classifier-less tool — the case that matters:
    // widening a browser tool must not widen anything that sends.
    expect(
      (
        await classify({
          tool: "gmail_send_email",
          registryDefaultRisk: "high",
        })
      ).risk,
    ).toBe("high");
    expect(
      (
        await classify({
          tool: "composio_send_message",
          registryDefaultRisk: "medium",
        })
      ).risk,
    ).toBe("medium");
  });

  test("a rule can also escalate a tool, not only relax it", async () => {
    store.create({
      tool: "browser_type",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "high",
      description: "typing is sensitive on this instance",
    });
    initTrustRuleCache(store);

    expect((await classify(browserWrite("browser_type"))).risk).toBe("high");
  });

  test("a seeded default can never widen a classifier-less tool", async () => {
    // Same shape as the user rule above, but seeded rather than authored —
    // the shape a future default-rule ship would take. Its own tool name, so
    // a seeded row (which soft-deletes rather than hard-deletes) cannot leak
    // into another test.
    store.upsertDefault({
      id: "default:browser_select_option:all",
      tool: "browser_select_option",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "seeded",
    });
    initTrustRuleCache(store);

    const result = await classify(browserWrite("browser_select_option"));
    expect(result.risk).toBe("medium");
    expect(result.matchType).toBe("unknown");
  });

  test("deleting the rule restores the registry risk", async () => {
    const rule = store.create({
      tool: "browser_click",
      pattern: WHOLE_TOOL_PATTERN,
      risk: "low",
      description: "temporary",
    });
    initTrustRuleCache(store);
    expect((await classify(browserWrite("browser_click"))).risk).toBe("low");

    store.remove(rule.id);
    initTrustRuleCache(store);

    expect((await classify(browserWrite("browser_click"))).risk).toBe("medium");
  });

  test("`*` is matched literally, not as a wildcard over other patterns", async () => {
    // A rule scoped to a selector inside the tool must not be read as a
    // whole-tool grant.
    store.create({
      tool: "browser_click",
      pattern: "https://airline.example/*",
      risk: "low",
      description: "one site",
    });
    initTrustRuleCache(store);

    expect((await classify(browserWrite("browser_click"))).risk).toBe("medium");
  });

  test("an uninitialized cache leaves the registry risk in place", async () => {
    resetTrustRuleCache();

    const result = await classify(browserWrite("browser_click"));
    expect(result.risk).toBe("medium");
  });
});
