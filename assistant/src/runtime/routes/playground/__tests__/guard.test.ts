import { describe, expect, mock, test } from "bun:test";

let _playgroundEnabled = true;

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => _playgroundEnabled,
}));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../../../../config/loader.js");
mock.module("../../../../config/loader.js", () => ({
  ...actualConfigLoader,
  getConfig: () => ({}),
}));

import { RouteError } from "../../errors.js";
import { assertPlaygroundEnabled } from "../guard.js";
import { ROUTES } from "../index.js";

describe("assertPlaygroundEnabled", () => {
  test("throws a RouteError with playground_disabled code when the flag is disabled", () => {
    _playgroundEnabled = false;
    try {
      assertPlaygroundEnabled();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      const re = err as RouteError;
      expect(re.statusCode).toBe(404);
      expect(re.code).toBe("playground_disabled");
      expect(re.message).toBe("Compaction playground is not enabled");
    } finally {
      _playgroundEnabled = true;
    }
  });

  test("does not throw when the flag is enabled", () => {
    _playgroundEnabled = true;
    expect(() => assertPlaygroundEnabled()).not.toThrow();
  });
});

describe("playground ROUTES", () => {
  test("registers routes regardless of flag state (guard runs per-request)", () => {
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  test("registers the inject-failures playground route", () => {
    expect(
      ROUTES.some(
        (r) =>
          r.endpoint ===
            "conversations/:id/playground/inject-compaction-failures" &&
          r.method === "POST",
      ),
    ).toBe(true);
  });

  test("registers the seed-conversation endpoint", () => {
    const endpoints = ROUTES.map((r) => `${r.method} ${r.endpoint}`);
    expect(endpoints).toContain("POST playground/seed-conversation");
  });
});
