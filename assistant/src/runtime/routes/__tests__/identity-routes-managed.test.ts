/**
 * Tests that the health/healthz routes expose `capabilities.managed`
 * reflecting the CUE_MANAGED env var (set by the HQ control plane on
 * managed instances). Clients use this flag to hide LLM-vendor
 * machinery, so the mapping env → responseBody must stay exact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { ROUTES } from "../identity-routes.js";
import type { RouteDefinition } from "../types.js";

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not found`);
  return route;
}

interface HealthPayload {
  status: string;
  capabilities: { memoryOptOut: boolean; managed: boolean };
}

const originalManaged = process.env.CUE_MANAGED;

beforeEach(() => {
  delete process.env.CUE_MANAGED;
});

afterEach(() => {
  if (originalManaged === undefined) {
    delete process.env.CUE_MANAGED;
  } else {
    process.env.CUE_MANAGED = originalManaged;
  }
});

describe("health capabilities.managed", () => {
  test("healthz reports managed: false when CUE_MANAGED is unset", async () => {
    const route = findRoute("healthz");
    const result = (await route.handler({})) as HealthPayload;
    expect(result.capabilities.managed).toBe(false);
  });

  test("healthz reports managed: true when CUE_MANAGED=1", async () => {
    process.env.CUE_MANAGED = "1";
    const route = findRoute("healthz");
    const result = (await route.handler({})) as HealthPayload;
    expect(result.capabilities.managed).toBe(true);
  });

  test("healthz treats CUE_MANAGED=0 as not managed", async () => {
    process.env.CUE_MANAGED = "0";
    const route = findRoute("healthz");
    const result = (await route.handler({})) as HealthPayload;
    expect(result.capabilities.managed).toBe(false);
  });

  test("health (non-alias) carries the same flag", async () => {
    process.env.CUE_MANAGED = "1";
    const route = findRoute("health");
    const result = (await route.handler({})) as HealthPayload;
    expect(result.capabilities.managed).toBe(true);
  });

  test("response validates against the route's responseBody schema", async () => {
    process.env.CUE_MANAGED = "1";
    const route = findRoute("healthz");
    const result = await route.handler({});
    // healthz declares a bare Zod schema (implicit application/json).
    const schema = route.responseBody;
    if (!(schema instanceof z.ZodType)) {
      throw new Error("healthz responseBody should be a bare Zod schema");
    }
    const parsed = schema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("healthz route stays scope-less so clients can read it pre-auth", () => {
    const route = findRoute("healthz");
    expect(route.policy).toBeNull();
  });
});
