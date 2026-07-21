/**
 * Connector-apps route contract: the curated fallback path (no Composio
 * credentials configured — the common self-host / fresh-instance case) must
 * always render a usable app list, honestly marked unconfigured. The
 * Composio-backed path is network-bound and exercised against real surfaces.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  recordConnectorFailure,
  resetConnectorHealthStoreForTest,
} from "../../oauth/connector-health-store.js";
import {
  resetConnectorAppsMemosForTest,
  ROUTES,
} from "./connector-apps-routes.js";
import { settleHealthRefreshForTest } from "./connector-health.js";
import { BadRequestError } from "./errors.js";

function route(operationId: string) {
  const def = ROUTES.find((r) => r.operationId === operationId);
  if (!def) throw new Error(`route ${operationId} not registered`);
  return def;
}

describe("connector-apps routes", () => {
  it("registers both routes with actor policies", () => {
    expect(route("listConnectorApps").method).toBe("GET");
    expect(route("connectConnectorApp").method).toBe("POST");
  });

  it("falls back to the curated list when unconfigured", async () => {
    const result = (await route("listConnectorApps").handler({
      queryParams: {},
    })) as {
      configured: boolean;
      source: string;
      apps: Array<{
        slug: string;
        name: string;
        connected: boolean;
        logoUrl?: string;
      }>;
    };
    expect(result.configured).toBe(false);
    expect(result.source).toBe("curated");
    expect(result.apps.length).toBeGreaterThanOrEqual(25);
    expect(result.apps.some((a) => a.slug === "gmail")).toBe(true);
    expect(result.apps.every((a) => a.connected === false)).toBe(true);
    // Every curated app carries a brand logo URL (Composio's public CDN).
    expect(
      result.apps.every(
        (a) => a.logoUrl === `https://logos.composio.dev/api/${a.slug}`,
      ),
    ).toBe(true);
  });

  it("filters the list with ?query=", async () => {
    const result = (await route("listConnectorApps").handler({
      queryParams: { query: "git" },
    })) as { apps: Array<{ slug: string }> };
    expect(result.apps.some((a) => a.slug === "github")).toBe(true);
    expect(result.apps.every((a) => a.slug !== "gmail")).toBe(true);
  });

  it("rejects connect without a slug, and explains when unconfigured", async () => {
    const connect = route("connectConnectorApp");
    await expect(connect.handler({ body: {} })).rejects.toThrow(
      BadRequestError,
    );
    await expect(connect.handler({ body: { slug: "gmail" } })).rejects.toThrow(
      /not configured/i,
    );
  });

  it("registers the refreshHealth query param on the list route", () => {
    const names = (route("listConnectorApps").queryParams ?? []).map(
      (q: { name: string }) => q.name,
    );
    expect(names).toContain("refreshHealth");
  });
});

// ---------------------------------------------------------------------------
// Configured path — Composio mocked at the fetch layer. Reality-shaped
// fixtures: an ACTIVE gmail account (the UI's "connected"), plus the EXPIRED
// abandoned-initiation noise rows Composio returns for the same user, which
// must NOT surface as connected apps or as attention.
// ---------------------------------------------------------------------------

describe("connector-apps routes (configured, mocked Composio)", () => {
  const ws = process.env.VELLUM_WORKSPACE_DIR ?? "";
  const cleanupFiles = [
    "connectors.json",
    "connector-apps-cache.json",
    "connector-health.json",
  ];
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await settleHealthRefreshForTest();
    resetConnectorHealthStoreForTest();
    resetConnectorAppsMemosForTest();
    for (const f of cleanupFiles) {
      const p = join(ws, f);
      if (existsSync(p)) rmSync(p);
    }
  });

  function configureComposio(): void {
    writeFileSync(
      join(ws, "connectors.json"),
      JSON.stringify({
        composioApiKey: "test-key",
        userId: "user-1",
        catalog: [],
      }),
    );
  }

  const toolkitsPayload = {
    items: [
      {
        slug: "gmail",
        name: "Gmail",
        meta: { categories: [{ name: "email" }] },
      },
      {
        slug: "slack",
        name: "Slack",
        meta: { categories: [{ name: "messaging" }] },
      },
      {
        slug: "notion",
        name: "Notion",
        meta: { categories: [{ name: "docs" }] },
      },
    ],
  };

  // What prod actually returns: ACTIVE rows for connected apps and EXPIRED
  // "Connection initiation did not complete" rows as noise. The route asks
  // for statuses=ACTIVE, so only ACTIVE rows come back here.
  const activeAccountsPayload = {
    items: [
      { id: "ca_gmail", toolkit: { slug: "gmail" }, is_disabled: false },
      { id: "ca_slack", toolkit: { slug: "slack" }, is_disabled: false },
    ],
  };

  function mockComposio(args: { slackProbeOk: boolean }): void {
    globalThis.fetch = (async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/toolkits")) {
        return new Response(JSON.stringify(toolkitsPayload));
      }
      if (url.includes("/connected_accounts")) {
        expect(url).toContain("statuses=ACTIVE");
        return new Response(JSON.stringify(activeAccountsPayload));
      }
      if (url.includes("/tools/execute/proxy")) {
        const body = JSON.parse(String(init?.body)) as {
          connected_account_id: string;
        };
        if (body.connected_account_id === "ca_slack" && !args.slackProbeOk) {
          // Slack's dead-token shape: HTTP 200 with ok:false.
          return new Response(
            JSON.stringify({
              data: { ok: false, error: "token_revoked" },
              status: 200,
            }),
          );
        }
        return new Response(
          JSON.stringify({ data: { ok: true }, status: 200 }),
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as unknown as typeof fetch;
  }

  async function listApps(refreshHealth?: string) {
    const result = (await route("listConnectorApps").handler({
      queryParams: refreshHealth !== undefined ? { refreshHealth } : {},
    })) as {
      configured: boolean;
      apps: Array<{
        slug: string;
        connected: boolean;
        health?: {
          status: string;
          lastSuccessAt?: string;
          lastErrorAt?: string;
          lastError?: string;
          checkedAt?: string;
        };
      }>;
    };
    return result;
  }

  it("marks connected apps, attaches health, and probes flip a dead Slack to attention", async () => {
    configureComposio();
    mockComposio({ slackProbeOk: false });

    // First list: connected flags come from ACTIVE accounts; health starts
    // unknown (no evidence yet) and the probe sweep is kicked in background.
    const first = await listApps("1");
    expect(first.configured).toBe(true);
    const gmail1 = first.apps.find((a) => a.slug === "gmail");
    const slack1 = first.apps.find((a) => a.slug === "slack");
    const notion1 = first.apps.find((a) => a.slug === "notion");
    expect(gmail1?.connected).toBe(true);
    expect(slack1?.connected).toBe(true);
    expect(notion1?.connected).toBe(false);
    expect(notion1?.health).toBeUndefined();
    expect(gmail1?.health?.status).toBe("unknown");

    // Let the background sweep land, then re-list: gmail verified ok,
    // slack (token_revoked) needs attention.
    await settleHealthRefreshForTest();
    const second = await listApps();
    const gmail2 = second.apps.find((a) => a.slug === "gmail");
    const slack2 = second.apps.find((a) => a.slug === "slack");
    expect(gmail2?.health?.status).toBe("ok");
    expect(gmail2?.health?.lastSuccessAt).toBeDefined();
    expect(slack2?.health?.status).toBe("attention");
    expect(slack2?.health?.lastError).toContain("token_revoked");
    expect(slack2?.health?.checkedAt).toBeDefined();
  });

  it("surfaces passive failure signals without any probe", async () => {
    configureComposio();
    mockComposio({ slackProbeOk: true });
    // A real connector call failed earlier (the passive path records it).
    recordConnectorFailure(
      "gmail",
      "Provider rejected the connection (HTTP 401) — reconnect to fix",
    );

    const result = await listApps(); // no refreshHealth → no forced probe
    const gmail = result.apps.find((a) => a.slug === "gmail");
    expect(gmail?.health?.status).toBe("attention");
    expect(gmail?.health?.lastError).toContain("401");
  });
});
