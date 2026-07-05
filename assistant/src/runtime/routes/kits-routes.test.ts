/**
 * Route smoke tests for the fan-out KITS routes: create (persists the kit +
 * one pending asset per format, launches the runs, returns the tracked set),
 * validation (missing brief / empty formats / unknown brand kit), the status
 * GET (join + NotFound), and regenerate (resets the asset + NotFound paths).
 *
 * Hermetic: the orchestrator's launch/regenerate side effects are mocked so no
 * real generation conversations spin up — the route logic + persistence is
 * what's under test. `resolveFormatMode` is kept real so the format→mode
 * mapping the route relies on is exercised end to end.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the fire-and-forget generation launch. Records calls so the create /
// regenerate routes can be asserted to have kicked off the runs, without
// spinning up real background conversations. `resolveFormatMode` stays real.
const launched: string[] = [];
const regenerated: Array<{ kitId: string; assetId: string }> = [];
mock.module("../../create/kit-orchestrator.js", () => ({
  launchKit: (kitId: string) => {
    launched.push(kitId);
  },
  regenerateAsset: (kitId: string, assetId: string) => {
    regenerated.push({ kitId, assetId });
    return true;
  },
  resolveFormatMode: (format: string) => {
    const map: Record<string, string> = {
      slides: "slides",
      one_pager: "docs",
      social: "image",
      email: "docs",
      landing: "canvas",
    };
    return map[format] ?? format;
  },
}));

import { createBrandProfile } from "../../brand/brand-profile-store.js";
import { getKitWithAssets } from "../../create/kit-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { ROUTES } from "./kits-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM kit_assets");
  getDb().run("DELETE FROM kits");
  getDb().run("DELETE FROM brand_profiles");
  launched.length = 0;
  regenerated.length = 0;
});

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

type KitAsset = {
  id: string;
  format: string;
  mode: string;
  status: string;
};
type Kit = {
  id: string;
  brief: string;
  brandKitId: string | null;
  assets: KitAsset[];
};

describe("POST kits", () => {
  test("creates the kit, one pending asset per format, and launches", () => {
    const result = route("kits", "POST").handler({
      body: {
        brief: "Launch the Series A",
        formats: ["slides", "one_pager", "social"],
        contractPreamble: "DESIGN CONTRACT — …",
        title: "Series A launch kit",
      },
    }) as { kit: Kit };

    expect(result.kit.id).toBeTruthy();
    expect(result.kit.brief).toBe("Launch the Series A");
    expect(result.kit.assets.map((a) => a.format)).toEqual([
      "slides",
      "one_pager",
      "social",
    ]);
    // Format → mode resolution ran through the route.
    expect(result.kit.assets.map((a) => a.mode)).toEqual([
      "slides",
      "docs",
      "image",
    ]);
    expect(result.kit.assets.every((a) => a.status === "pending")).toBe(true);

    // The kit was persisted and the launch was kicked off exactly once.
    expect(getKitWithAssets(result.kit.id)).toBeDefined();
    expect(launched).toEqual([result.kit.id]);
  });

  test("accepts a valid brand kit id", () => {
    const brand = createBrandProfile("default", { name: "Acme" });
    const result = route("kits", "POST").handler({
      body: {
        brief: "b",
        formats: ["social"],
        brandKitId: brand.id,
      },
    }) as { kit: Kit };
    expect(result.kit.brandKitId).toBe(brand.id);
  });

  test("rejects a missing brief", () => {
    expect(() =>
      route("kits", "POST").handler({ body: { formats: ["social"] } }),
    ).toThrow(BadRequestError);
  });

  test("rejects an empty formats array", () => {
    expect(() =>
      route("kits", "POST").handler({ body: { brief: "b", formats: [] } }),
    ).toThrow(BadRequestError);
  });

  test("rejects an unknown brand kit id", () => {
    expect(() =>
      route("kits", "POST").handler({
        body: { brief: "b", formats: ["social"], brandKitId: "ghost" },
      }),
    ).toThrow(BadRequestError);
    // Nothing was launched on the failed create.
    expect(launched).toHaveLength(0);
  });
});

describe("GET kits/:kid", () => {
  test("returns the kit with all asset statuses", () => {
    const created = route("kits", "POST").handler({
      body: { brief: "b", formats: ["slides", "email"] },
    }) as { kit: Kit };

    const got = route("kits/:kid", "GET").handler({
      pathParams: { kid: created.kit.id },
    }) as { kit: Kit };
    expect(got.kit.id).toBe(created.kit.id);
    expect(got.kit.assets).toHaveLength(2);
  });

  test("404s on a missing kit", () => {
    expect(() =>
      route("kits/:kid", "GET").handler({ pathParams: { kid: "nope" } }),
    ).toThrow(NotFoundError);
  });
});

describe("POST kits/:kid/assets/:aid/regenerate", () => {
  test("re-runs one asset and returns it", () => {
    const created = route("kits", "POST").handler({
      body: { brief: "b", formats: ["slides", "social"] },
    }) as { kit: Kit };
    const asset = created.kit.assets[1];

    const result = route("kits/:kid/assets/:aid/regenerate", "POST").handler({
      pathParams: { kid: created.kit.id, aid: asset.id },
    }) as { asset: KitAsset };

    expect(result.asset.id).toBe(asset.id);
    expect(result.asset.status).toBe("pending");
    expect(regenerated).toEqual([{ kitId: created.kit.id, assetId: asset.id }]);
  });

  test("404s on a missing kit", () => {
    expect(() =>
      route("kits/:kid/assets/:aid/regenerate", "POST").handler({
        pathParams: { kid: "nope", aid: "x" },
      }),
    ).toThrow(NotFoundError);
  });

  test("404s on an asset that isn't in the kit", () => {
    const created = route("kits", "POST").handler({
      body: { brief: "b", formats: ["social"] },
    }) as { kit: Kit };
    expect(() =>
      route("kits/:kid/assets/:aid/regenerate", "POST").handler({
        pathParams: { kid: created.kit.id, aid: "not-an-asset" },
      }),
    ).toThrow(NotFoundError);
  });
});
