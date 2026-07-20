import { describe, expect, test } from "bun:test";

import { isSpaShellPath } from "../spa-shell-paths.js";

describe("isSpaShellPath", () => {
  test.each([
    "/onboarding",
    "/onboarding/welcome",
    "/onboarding/privacy",
    "/onboarding/deep/nested",
    "/welcome",
    "/welcome/",
    "/select-assistant",
    "/review-terms",
  ])("serves the SPA shell for %s", (pathname) => {
    expect(isSpaShellPath(pathname)).toBe(true);
  });

  test.each([
    // API + infra surfaces must keep their JSON/auth behavior.
    "/v1/assistants",
    "/auth/token",
    "/healthz",
    "/readyz",
    "/schema",
    "/",
    // /assistant/* is handled by the asset-aware serveSpaAsset path, not
    // the shell allowlist.
    "/assistant/hq",
    // Prefix look-alikes must not match.
    "/onboardingx",
    "/welcome-back",
    "/api/onboarding",
  ])("does NOT shell-serve %s", (pathname) => {
    expect(isSpaShellPath(pathname)).toBe(false);
  });
});
