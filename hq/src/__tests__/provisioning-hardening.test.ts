/**
 * 2026-07-19 alpha-readiness hardening of the provisioning flow:
 *   P0-2 — connectors.json (Composio) seeded onto the instance workspace
 *   P0-3 — shared-key fallback is loudly audited; managed budget defaults
 *          (hardStopEnabled + sized weekly caps) applied to the roster
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HqDb } from "../db.js";
import { PLANS } from "../plans.js";
import {
  applyDefaultBudgets,
  buildConnectorsJson,
  defaultAgentWeeklyCapCents,
  provisionCustomer,
} from "../provisioning.js";
import { MockDriver } from "../providers/mock-driver.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_COMPOSIO_API_KEY",
  "HQ_BUDGET_HARD_STOP_DEFAULT",
  "HQ_AGENT_WEEKLY_CAP_CENTS",
  "HQ_INSTANCE_DOMAIN",
  "CUE_TAVILY_API_KEY",
  "CUE_FIRECRAWL_API_KEY",
  "CUE_SERPER_API_KEY",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/**
 * Fake instance API: guardian/init + an agents roster that accepts budget
 * PATCHes. Captures every PATCH body for assertions.
 */
function fakeInstanceFetch(opts: { agents?: { id: string }[] } = {}) {
  const agents = opts.agents ?? [{ id: "ag-ops" }, { id: "ag-growth" }, { id: "ag-inbox" }];
  const patches: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/guardian/init")) {
      return Response.json({
        guardianPrincipalId: "vellum-principal-test-123",
        accessToken: "atk.test.token",
        accessTokenExpiresAt: Date.now() + 1000,
      });
    }
    if (method === "GET" && url.endsWith("/v1/agents")) {
      return Response.json({ agents });
    }
    if (method === "PATCH" && /\/v1\/agents\/[^/]+$/.test(url)) {
      patches.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ agent: { id: url.split("/").pop() } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, patches };
}

function setup(fetchImpl: typeof fetch) {
  const db = new HqDb(":memory:");
  const driver = new MockDriver();
  const deps = {
    db,
    driver,
    fetchImpl,
    healthTimeoutMs: 100,
    healthIntervalMs: 10,
  };
  return { db, driver, deps };
}

describe("connectors.json seeding (P0-2)", () => {
  test("with HQ_COMPOSIO_API_KEY the workspace file is written in the daemon's exact shape", async () => {
    process.env.HQ_COMPOSIO_API_KEY = "ak_platform_composio";
    const { fetchImpl, patches } = fakeInstanceFetch();
    const { db, driver, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "ada@example.com", name: "Ada" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.existing) throw new Error("expected fresh provision");

    const files = driver.workspaceFiles.get(outcome.instance.externalId);
    expect(files).toBeDefined();
    const raw = files!.get("connectors.json");
    expect(raw).toBeDefined();
    // The exact keys assistant/src/oauth/composio-oauth.ts readCreds() parses.
    expect(JSON.parse(raw!)).toEqual({
      composioApiKey: "ak_platform_composio",
      userId: customer.id,
    });
    expect(db.findLatestEvent("connectors_seeded", customer.id)).not.toBeNull();
    // Sanity: budget PATCHes also ran on this full pass.
    expect(patches.length).toBe(3);
  });

  test("without the key nothing is written and the skip is audited", async () => {
    const { fetchImpl } = fakeInstanceFetch();
    const { db, driver, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "bo@example.com", name: "Bo" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    expect(driver.workspaceFiles.size).toBe(0);
    const skipped = db.findLatestEvent("connectors_seed_skipped", customer.id);
    expect(skipped).not.toBeNull();
    expect(skipped!.dataJson).toContain("no_composio_key");
  });

  test("a seed failure is audited but never fails a healthy provision", async () => {
    process.env.HQ_COMPOSIO_API_KEY = "ak_platform_composio";
    const { fetchImpl } = fakeInstanceFetch();
    const { db, driver, deps } = setup(fetchImpl);
    driver.failWorkspaceWrites = true;
    const customer = db.createCustomer({ email: "cy@example.com", name: "Cy" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.existing) {
      expect(outcome.instance.state).toBe("live");
    }
    expect(db.findLatestEvent("connectors_seed_failed", customer.id)).not.toBeNull();
  });

  test("buildConnectorsJson emits exactly {composioApiKey, userId}", () => {
    expect(JSON.parse(buildConnectorsJson("k", "u"))).toEqual({
      composioApiKey: "k",
      userId: "u",
    });
  });
});

describe("LLM key fallback audit (P0-3)", () => {
  test("shared-key mode records the loud llm_key_shared_fallback event", async () => {
    process.env.OPENROUTER_SHARED_KEY = "sk-or-shared";
    const { fetchImpl } = fakeInstanceFetch();
    const { db, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "dee@example.com", name: "Dee" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    expect(db.findLatestEvent("llm_key_shared_fallback", customer.id)).not.toBeNull();
  });

  test("provisioned child-key mode does NOT fire the shared fallback", async () => {
    process.env.OPENROUTER_PROVISIONING_KEY = "pk_test";
    const base = fakeInstanceFetch();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/keys") {
        return Response.json({
          key: "sk-or-v1-child",
          data: { hash: "hash-1", name: "n", disabled: false, limit: 25, usage: 0 },
        });
      }
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const { db, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "eve@example.com", name: "Eve" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    expect(db.findLatestEvent("llm_key_shared_fallback", customer.id)).toBeNull();
    if (outcome.ok && !outcome.existing) {
      expect(db.getInstance(outcome.instance.id)!.openrouterKeyHash).toBe("hash-1");
    }
  });
});

describe("managed budget defaults (P0-3)", () => {
  test("provision flips every seeded agent to hardStopEnabled with a sized weekly cap", async () => {
    const { fetchImpl, patches } = fakeInstanceFetch();
    const { db, deps } = setup(fetchImpl);
    const customer = db.createCustomer({
      email: "fay@example.com",
      name: "Fay",
      plan: "chief_of_staff",
    });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);

    // chief_of_staff: 10000 credits → $25 COGS/month → $6.25/week → 625¢.
    const expectedCap = defaultAgentWeeklyCapCents(PLANS.chief_of_staff);
    expect(expectedCap).toBe(625);
    expect(patches.length).toBe(3);
    for (const patch of patches) {
      expect(patch.body).toEqual({ hardStopEnabled: true, capCents: expectedCap });
      expect(patch.auth).toBe("Bearer atk.test.token");
    }
    const applied = db.findLatestEvent("budget_defaults_applied", customer.id);
    expect(applied).not.toBeNull();
    expect(JSON.parse(applied!.dataJson)).toMatchObject({
      updated: 3,
      capCents: expectedCap,
    });
  });

  test("HQ_BUDGET_HARD_STOP_DEFAULT=0 opts out (audited as skipped)", async () => {
    process.env.HQ_BUDGET_HARD_STOP_DEFAULT = "0";
    const { fetchImpl, patches } = fakeInstanceFetch();
    const { db, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "gil@example.com", name: "Gil" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    expect(patches.length).toBe(0);
    expect(db.findLatestEvent("budget_defaults_skipped", customer.id)).not.toBeNull();
  });

  test("HQ_AGENT_WEEKLY_CAP_CENTS overrides the plan-derived cap", () => {
    process.env.HQ_AGENT_WEEKLY_CAP_CENTS = "1234";
    expect(defaultAgentWeeklyCapCents(PLANS.operator)).toBe(1234);
    delete process.env.HQ_AGENT_WEEKLY_CAP_CENTS;
    // operator: 30000 credits → $75/month COGS → 1875¢/week.
    expect(defaultAgentWeeklyCapCents(PLANS.operator)).toBe(1875);
    // Floor: never below $1.
    expect(
      defaultAgentWeeklyCapCents({ ...PLANS.assistant, monthlyCredits: 1 }),
    ).toBe(100);
  });

  test("applyDefaultBudgets retries an empty roster then reports it honestly", async () => {
    let listCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/v1/agents")) {
        listCalls += 1;
        return Response.json({ agents: [] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const outcome = await applyDefaultBudgets({
      instanceUrl: "http://inst.local",
      accessToken: "atk",
      planSpec: PLANS.assistant,
      fetchImpl,
      listAttempts: 3,
      listRetryDelayMs: 1,
    });
    expect(listCalls).toBe(3);
    expect(outcome).toEqual({ ok: false, reason: "agent_roster_empty" });
  });

  test("an unreachable agents API is audited as budget_defaults_failed", async () => {
    const base = fakeInstanceFetch();
    // guardian/init works; /v1/agents 404s (e.g. old image without the API).
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/agents")) return new Response("nope", { status: 404 });
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const { db, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "hal@example.com", name: "Hal" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true); // never fails the provision
    const failed = db.findLatestEvent("budget_defaults_failed", customer.id);
    expect(failed).not.toBeNull();
    expect(failed!.dataJson).toContain("agents_list_http_404");
  });
});
