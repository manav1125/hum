/**
 * Tests for the `classifyPreviewWorkItems` route (`POST
 * work-items/classify-preview`): definition shape, body validation, and the
 * pass-through to the auto-filer's `classifyTitlesForPreview` (whose own
 * hardening — cap, dedup, scorer-failure → [] — is covered in
 * `src/work-items/work-item-auto-file.test.ts`). The classifier is mocked at
 * the module boundary so no LLM provider is touched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockCalls: string[][] = [];
let mockResult: Array<{
  title: string;
  projectId: string | null;
  confidence: number;
}> = [];

mock.module("../../../work-items/work-item-auto-file.js", () => ({
  classifyTitlesForPreview: async (titles: string[]) => {
    mockCalls.push(titles);
    return mockResult;
  },
}));

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../work-items-routes.js";

function findRoute(opId: string) {
  const route = ROUTES.find((r) => r.operationId === opId);
  if (!route) throw new Error(`Route not found: ${opId}`);
  return route;
}

beforeEach(() => {
  mockCalls = [];
  mockResult = [];
});

describe("classifyPreviewWorkItems route", () => {
  test("is defined as POST work-items/classify-preview behind settings.read", () => {
    const route = findRoute("classifyPreviewWorkItems");
    expect(route.method).toBe("POST");
    expect(route.endpoint).toBe("work-items/classify-preview");
    // A read-only scoring query — no write scope required.
    expect(route.policy?.requiredScopes).toEqual(["settings.read"]);
  });

  test("passes titles through and returns {suggestions} in the wire shape", async () => {
    mockResult = [
      { title: "Fix the pager", projectId: "p1", confidence: 0.9 },
      { title: "Buy milk", projectId: null, confidence: 0 },
    ];
    const route = findRoute("classifyPreviewWorkItems");
    const result = await route.handler({
      body: { titles: ["Fix the pager", "Buy milk"] },
    });
    expect(mockCalls).toEqual([["Fix the pager", "Buy milk"]]);
    expect(result).toEqual({ suggestions: mockResult });
  });

  test("a scorer that suggests nothing yields an empty array, not an error", async () => {
    mockResult = [];
    const route = findRoute("classifyPreviewWorkItems");
    const result = await route.handler({ body: { titles: ["A task"] } });
    expect(result).toEqual({ suggestions: [] });
  });

  test("rejects a missing or non-array titles field with 400", async () => {
    const route = findRoute("classifyPreviewWorkItems");
    await expect(route.handler({ body: {} })).rejects.toThrow(BadRequestError);
    await expect(route.handler({})).rejects.toThrow(BadRequestError);
    await expect(
      route.handler({ body: { titles: "not an array" } }),
    ).rejects.toThrow(BadRequestError);
    expect(mockCalls).toHaveLength(0);
  });

  test("rejects non-string entries with 400", async () => {
    const route = findRoute("classifyPreviewWorkItems");
    await expect(
      route.handler({ body: { titles: ["ok", 42] } }),
    ).rejects.toThrow(BadRequestError);
    expect(mockCalls).toHaveLength(0);
  });
});
