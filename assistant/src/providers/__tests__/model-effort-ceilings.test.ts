import { describe, expect, test } from "bun:test";

import { modelEffortCeilings, PROVIDER_CATALOG } from "../model-catalog.js";

describe("modelEffortCeilings", () => {
  test("maps exactly the models that declare maxEffort for a provider", () => {
    for (const provider of PROVIDER_CATALOG) {
      const ceilings = modelEffortCeilings(provider.id);
      const declared = provider.models.filter((m) => m.maxEffort != null);
      // Every declared ceiling is present with the right value…
      for (const model of declared) {
        expect(ceilings.get(model.id)).toBe(model.maxEffort);
      }
      // …and nothing else is (undeclared models inherit the provider default).
      expect(ceilings.size).toBe(declared.length);
    }
  });

  test("models without a declared ceiling are absent (inherit default)", () => {
    for (const provider of PROVIDER_CATALOG) {
      const ceilings = modelEffortCeilings(provider.id);
      for (const model of provider.models) {
        if (model.maxEffort == null) {
          expect(ceilings.has(model.id)).toBe(false);
        }
      }
    }
  });

  test("an unknown provider yields an empty map", () => {
    expect(modelEffortCeilings("no-such-provider").size).toBe(0);
  });
});
