/**
 * Per-customer Composio projects (2026-08-04 cross-tenant isolation fix).
 *
 * The bug this pins down: every instance was seeded with the SAME Composio
 * project key, and the `userId` written beside it is a partition label, not
 * an auth boundary. That key could list and proxy all 176 connected accounts
 * across 36 tenants; isolation depended entirely on Cue's own code attaching
 * `user_ids=<own>` to every call.
 *
 * The fix: HQ mints the customer their own Composio project (org-owner API)
 * and seeds a key scoped to it, so a foreign connected account is invisible
 * rather than merely filtered. These tests hold the two properties that
 * matter — the seeded key is per-customer, and a mint failure seeds NOTHING
 * rather than silently falling back to the shared org-wide key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createCustomerProject,
  deleteCustomerProject,
  regenerateProjectApiKey,
} from "../composio-projects.js";
import { HqDb } from "../db.js";
import { provisionCustomer } from "../provisioning.js";
import { MockDriver } from "../providers/mock-driver.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OPENROUTER_PROVISIONING_KEY",
  "OPENROUTER_SHARED_KEY",
  "HQ_COMPOSIO_API_KEY",
  "HQ_COMPOSIO_ORG_API_KEY",
  "HQ_COMPOSIO_API_BASE",
  "HQ_INSTANCE_DOMAIN",
];
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HQ_COMPOSIO_API_BASE = "https://composio.test/api/v3.1";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Call {
  url: string;
  method: string;
  orgKey: string | null;
  body: Record<string, unknown> | null;
}

/**
 * Fake Composio org API + fake instance API in one fetch. `scripted` lets a
 * test force a specific status for the project-create call.
 */
function fakeFetch(
  opts: {
    createStatus?: number;
    projectId?: string;
    /** null models Composio ignoring should_create_api_key. */
    apiKey?: string | null;
    listNames?: { id: string; name: string }[];
  } = {},
) {
  const calls: Call[] = [];
  const projectId = opts.projectId ?? "pr_customer_1";
  const apiKey =
    opts.apiKey === undefined ? "ak_scoped_to_one_project" : opts.apiKey;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      orgKey: new Headers(init?.headers).get("x-org-api-key"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    if (url.includes("/org/owner/project/new")) {
      const status = opts.createStatus ?? 200;
      if (status !== 200) {
        return Response.json(
          { error: { message: "project name already exists", status } },
          { status },
        );
      }
      return Response.json({ id: projectId, name: "cue-x", api_key: apiKey });
    }
    if (url.includes("/org/owner/project/list")) {
      return Response.json({ data: opts.listNames ?? [], next_cursor: null });
    }
    if (url.includes("/regenerate_api_key")) {
      return Response.json({
        api_key: { id: "k1", name: "cue", key: "ak_rotated", created_at: "" },
        message: "ok",
      });
    }
    if (/\/org\/owner\/project\/[^/?]+/.test(url) && method === "DELETE") {
      return Response.json({ success: true });
    }

    // ── instance-side API (guardian bootstrap + budget roster) ──
    if (url.endsWith("/v1/guardian/init")) {
      return Response.json({
        guardianPrincipalId: "vellum-principal-test",
        accessToken: "atk.test",
        accessTokenExpiresAt: Date.now() + 1000,
      });
    }
    // A non-empty roster matters: an empty one sends applyDefaultBudgets
    // into its retry/backoff loop and every test here would time out.
    if (url.endsWith("/v1/agents")) {
      return Response.json({ agents: [{ id: "ag-ops" }] });
    }
    if (method === "PATCH" && /\/v1\/agents\/[^/]+$/.test(url)) {
      return Response.json({ agent: { id: url.split("/").pop() } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function setup(fetchImpl: typeof fetch) {
  const db = new HqDb(":memory:");
  const driver = new MockDriver();
  return {
    db,
    driver,
    deps: { db, driver, fetchImpl, healthTimeoutMs: 100, healthIntervalMs: 10 },
  };
}

describe("composio-projects org API client", () => {
  test("createCustomerProject authenticates with the ORG key and asks for a key", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    const { fetchImpl, calls } = fakeFetch();

    const project = await createCustomerProject("cus_42", { fetchImpl });

    expect(project).toEqual({
      projectId: "pr_customer_1",
      apiKey: "ak_scoped_to_one_project",
    });
    const create = calls.find((c) => c.url.includes("/project/new"))!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe("https://composio.test/api/v3.1/org/owner/project/new");
    // The org key is the credential that mints projects — it must be sent as
    // x-org-api-key, and (crucially) it is never what we hand to the instance.
    expect(create.orgKey).toBe("ok_org_key");
    expect(create.body).toMatchObject({ should_create_api_key: true });
    // Names carry a random suffix so a crashed provision can never wedge
    // every later retry on a 409 name clash it has no way to clear.
    expect((create.body!.name as string).startsWith("cue-cus_42-")).toBe(true);
  });

  test("two mints for the same customer never collide on the project name", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    const { fetchImpl, calls } = fakeFetch();

    await createCustomerProject("cus_42", { fetchImpl });
    await createCustomerProject("cus_42", { fetchImpl });

    const names = calls
      .filter((c) => c.url.includes("/project/new"))
      .map((c) => c.body!.name as string);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  test("a project created without a key is binned rather than left stray", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    // Regeneration is 403 on this org, so a keyless project is unrecoverable.
    const { fetchImpl, calls } = fakeFetch({ apiKey: null });

    await expect(createCustomerProject("cus_42", { fetchImpl })).rejects.toThrow(
      /without an api_key/,
    );
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.includes("pr_customer_1"),
      ),
    ).toBe(true);
  });

  test("deleteCustomerProject revokes upstream grants, not just the project row", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    const { fetchImpl, calls } = fakeFetch();

    await deleteCustomerProject("pr_customer_1", { fetchImpl });

    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("/org/owner/project/pr_customer_1");
    // Without this the customer's Google/Slack refresh tokens keep working
    // at the provider after their instance is destroyed.
    expect(del.url).toContain("revoke_on_delete=true");
  });

  test("regenerateProjectApiKey reads the nested api_key.key", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    const { fetchImpl } = fakeFetch();
    expect(await regenerateProjectApiKey("pr_x", { fetchImpl })).toBe("ak_rotated");
  });

  test("without the org key the client refuses to call rather than guessing", async () => {
    const { fetchImpl, calls } = fakeFetch();
    await expect(createCustomerProject("cus_42", { fetchImpl })).rejects.toThrow(
      /HQ_COMPOSIO_ORG_API_KEY unset/,
    );
    expect(calls.length).toBe(0);
  });
});

describe("provisioning seeds a per-customer Composio key", () => {
  test("the instance receives its OWN project key, not the shared org key", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    process.env.HQ_COMPOSIO_API_KEY = "ak_SHARED_cross_tenant";
    const { fetchImpl } = fakeFetch();
    const { db, driver, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "ada@example.com", name: "Ada" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.existing) throw new Error("expected fresh provision");

    const raw = driver.workspaceFiles.get(outcome.instance.externalId)!.get(
      "connectors.json",
    )!;
    expect(JSON.parse(raw)).toEqual({
      composioApiKey: "ak_scoped_to_one_project",
      userId: customer.id,
    });
    // The fleet-wide credential must never reach a customer machine.
    expect(raw).not.toContain("ak_SHARED_cross_tenant");

    // The project id is persisted so teardown can revoke it later.
    const stored = db.getInstance(outcome.instance.id)!;
    expect(JSON.parse(stored.secretsJson).composioProjectId).toBe("pr_customer_1");

    const seeded = db.findLatestEvent("connectors_seeded", customer.id)!;
    expect(seeded.dataJson).toContain("per_customer_project");
    expect(db.findLatestEvent("composio_project_created", customer.id)).not.toBeNull();
  });

  test("FAIL-CLOSED: a mint failure seeds nothing, never the shared key", async () => {
    process.env.HQ_COMPOSIO_ORG_API_KEY = "ok_org_key";
    // The shared key is still configured — the point of this test is that its
    // presence must NOT rescue a failed mint by reintroducing the cross-tenant
    // credential. A dead connector is recoverable; an over-scoped key is not.
    process.env.HQ_COMPOSIO_API_KEY = "ak_SHARED_cross_tenant";
    const { fetchImpl } = fakeFetch({ createStatus: 500 });
    const { db, driver, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "bo@example.com", name: "Bo" });

    const outcome = await provisionCustomer(deps, customer);

    // The instance still comes up healthy — connectors are a best-effort step.
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.existing) {
      expect(outcome.instance.state).toBe("live");
    }
    expect(driver.workspaceFiles.size).toBe(0);
    const skipped = db.findLatestEvent("connectors_seed_skipped", customer.id)!;
    expect(skipped.dataJson).toContain("project_mint_failed");
    expect(
      db.findLatestEvent("composio_project_create_failed", customer.id),
    ).not.toBeNull();
  });

  test("legacy: with no org key the shared key still seeds, audited as such", async () => {
    process.env.HQ_COMPOSIO_API_KEY = "ak_SHARED_cross_tenant";
    const { fetchImpl } = fakeFetch();
    const { db, driver, deps } = setup(fetchImpl);
    const customer = db.createCustomer({ email: "cy@example.com", name: "Cy" });

    const outcome = await provisionCustomer(deps, customer);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.existing) throw new Error("expected fresh provision");

    const raw = driver.workspaceFiles.get(outcome.instance.externalId)!.get(
      "connectors.json",
    )!;
    expect(JSON.parse(raw).composioApiKey).toBe("ak_SHARED_cross_tenant");
    // Over-scoped instances must be queryable, not invisible.
    expect(
      db.findLatestEvent("connectors_seeded", customer.id)!.dataJson,
    ).toContain("shared_org_key");
    expect(
      JSON.parse(db.getInstance(outcome.instance.id)!.secretsJson)
        .composioProjectId,
    ).toBeUndefined();
  });
});
