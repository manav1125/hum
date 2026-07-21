import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PLATFORM_BILLING_BASE,
  derivePlatformBillingUrl,
  platformBillingHost,
} from "@/lib/billing/platform-billing-url";

const FALLBACK = `${DEFAULT_PLATFORM_BILLING_BASE}/billing`;

describe("derivePlatformBillingUrl", () => {
  test("appends /billing to a configured platform base", () => {
    expect(derivePlatformBillingUrl("https://justcue.ai")).toBe(
      "https://justcue.ai/billing",
    );
  });

  test("strips trailing slashes before appending", () => {
    expect(derivePlatformBillingUrl("https://justcue.ai/")).toBe(
      "https://justcue.ai/billing",
    );
    expect(derivePlatformBillingUrl("https://justcue.ai///")).toBe(
      "https://justcue.ai/billing",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(derivePlatformBillingUrl("  https://justcue.ai  ")).toBe(
      "https://justcue.ai/billing",
    );
  });

  test("keeps a custom self-host platform base", () => {
    expect(derivePlatformBillingUrl("https://hq.example.com")).toBe(
      "https://hq.example.com/billing",
    );
  });

  test("falls back when the base URL is empty, null, or undefined", () => {
    expect(derivePlatformBillingUrl("")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl("   ")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl(null)).toBe(FALLBACK);
    expect(derivePlatformBillingUrl(undefined)).toBe(FALLBACK);
  });

  test("falls back on unparseable or non-http(s) values", () => {
    expect(derivePlatformBillingUrl("not a url")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl("ftp://example.com")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl("justcue.ai")).toBe(FALLBACK);
  });

  test("treats the daemon's internal vellum.ai defaults as unconfigured", () => {
    expect(derivePlatformBillingUrl("https://platform.vellum.ai")).toBe(
      FALLBACK,
    );
    expect(derivePlatformBillingUrl("https://staging-platform.vellum.ai")).toBe(
      FALLBACK,
    );
    expect(derivePlatformBillingUrl("https://dev-platform.vellum.ai")).toBe(
      FALLBACK,
    );
    expect(derivePlatformBillingUrl("https://vellum.ai")).toBe(FALLBACK);
  });

  test("treats loopback dev defaults as unconfigured", () => {
    expect(derivePlatformBillingUrl("http://localhost:8000")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl("http://127.0.0.1:8000")).toBe(FALLBACK);
    expect(derivePlatformBillingUrl("http://[::1]:8000")).toBe(FALLBACK);
  });

  test("does not fall back for hosts merely containing vellum.ai", () => {
    expect(derivePlatformBillingUrl("https://notvellum.ai")).toBe(
      "https://notvellum.ai/billing",
    );
    expect(derivePlatformBillingUrl("https://vellum.ai.example.com")).toBe(
      "https://vellum.ai.example.com/billing",
    );
  });
});

describe("platformBillingHost", () => {
  test("returns the hostname of a derived billing URL", () => {
    expect(platformBillingHost("https://justcue.ai/billing")).toBe(
      "justcue.ai",
    );
    expect(platformBillingHost("https://hq.example.com/billing")).toBe(
      "hq.example.com",
    );
  });

  test("falls back to the default host on unparseable input", () => {
    expect(platformBillingHost("not a url")).toBe("justcue.ai");
  });
});
