/**
 * The VentureVerse apps catalog route's contract.
 *
 * Pinned behaviors:
 *  - Flag OFF → 404 (NotFoundError), no fetch performed. The surface ships
 *    dark; a disabled flag must have zero side effects.
 *  - Remote catalog is paginated — every page is consumed and malformed /
 *    non-active items are skipped, never thrown on.
 *  - Every returned app carries the derived `slug` (`<id>-<kebab-name>`) and
 *    a `launchUrl` pointing at the VentureVerse shell — the client embeds
 *    that URL verbatim, so the derivation lives here, not in the client.
 *  - Remote unreachable + no cache → the curated static snapshot, reported
 *    as `source: "curated"` rather than passed off as live data.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/** Swapped per-test: whether the `ventureverse-apps` flag reads as ON. */
let flagEnabled = true;

const actualFlags = await import("../../config/assistant-feature-flags.js");
mock.module("../../config/assistant-feature-flags.js", () => ({
  ...actualFlags,
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "ventureverse-apps" ? flagEnabled : false,
}));

const actualLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => ({}),
}));

const { ROUTES, resetVentureverseAppsMemoForTest } =
  await import("./ventureverse-apps-routes.js");
const { NotFoundError } = await import("./errors.js");

const listRoute = ROUTES.find((r) => r.operationId === "listVentureverseApps")!;

type ListResponse = {
  source: "remote" | "curated";
  origin: string;
  apps: Array<{
    id: number;
    name: string;
    slug: string;
    category: string;
    launchUrl: string;
  }>;
};

async function list(
  queryParams: Record<string, string> = {},
): Promise<ListResponse> {
  return (await listRoute.handler({ queryParams } as never)) as ListResponse;
}

const realFetch = globalThis.fetch;

function page(
  apps: Array<Record<string, unknown>>,
  hasNext: boolean,
): Response {
  return Response.json({ data: { apps, has_next: hasNext } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  flagEnabled = true;
  resetVentureverseAppsMemoForTest();
  // The catalog cache is a workspace FILE as well as a module memo — drop
  // both, or a test that fetched successfully feeds the next test's read.
  const ws = process.env.VELLUM_WORKSPACE_DIR;
  if (ws) {
    rmSync(join(ws, "ventureverse-apps-cache.json"), { force: true });
  }
});

describe("listVentureverseApps", () => {
  test("404s with no fetch while the flag is off", async () => {
    flagEnabled = false;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return page([], false);
    }) as unknown as typeof fetch;

    await expect(list()).rejects.toBeInstanceOf(NotFoundError);
    expect(fetched).toBe(0);
  });

  test("consumes every remote page, derives slug + launchUrl", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("page=1")) {
        return page(
          [
            {
              id: 10,
              app_name: "Alchemy",
              description: "Legal analysis",
              category: { name: "Legal" },
              icon_url: "https://assets.ventureverse.com/a.png",
              app_url: "https://alchemy-legal.vercel.app/",
              status: "active",
            },
            // Non-active apps are not launchable and must be dropped.
            {
              id: 99,
              app_name: "Drafts Only",
              status: "draft",
            },
            // Malformed items are skipped, never thrown on.
            { app_name: "No id" },
          ],
          true,
        );
      }
      return page(
        [
          {
            id: 25,
            app_name: "Market Sizing Calculator",
            description: "TAM/SAM/SOM",
            category: { name: "Business Strategy" },
            status: "active",
          },
        ],
        false,
      );
    }) as unknown as typeof fetch;

    const res = await list();
    expect(res.source).toBe("remote");
    expect(res.origin).toBe("https://www.ventureverse.com");
    expect(calls).toHaveLength(2);
    expect(res.apps.map((a) => a.slug)).toEqual([
      "10-alchemy",
      "25-market-sizing-calculator",
    ]);
    expect(res.apps[0]!.launchUrl).toBe(
      "https://www.ventureverse.com/apps?launch=10-alchemy",
    );
  });

  test("falls back to the curated snapshot when remote is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await list();
    expect(res.source).toBe("curated");
    // The snapshot is the full 24-app catalog, launch-ready.
    expect(res.apps.length).toBeGreaterThanOrEqual(20);
    for (const app of res.apps) {
      expect(app.slug).toMatch(/^\d+-[a-z0-9-]+$/);
      expect(app.launchUrl).toContain("?launch=");
    }
  });

  test("query filters over name, category, and description", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const byName = await list({ query: "alchemy" });
    expect(byName.apps.map((a) => a.name)).toEqual(["Alchemy"]);

    const byCategory = await list({ query: "hiring" });
    expect(byCategory.apps.some((a) => a.name === "Rolesmith")).toBe(true);
  });
});
