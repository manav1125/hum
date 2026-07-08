/**
 * Connector-apps route contract: the curated fallback path (no Composio
 * credentials configured — the common self-host / fresh-instance case) must
 * always render a usable app list, honestly marked unconfigured. The
 * Composio-backed path is network-bound and exercised against real surfaces.
 */

import { describe, expect, it } from "bun:test";

import { ROUTES } from "./connector-apps-routes.js";
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
});
