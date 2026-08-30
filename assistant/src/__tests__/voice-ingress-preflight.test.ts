import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockLoadConfig: () => unknown;
let mockGetIsPlatform: () => boolean;

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  loadConfig: () => mockLoadConfig(),
}));

mock.module("../config/env-registry.js", () => ({
  getIsPlatform: () => mockGetIsPlatform(),
}));

import { preflightVoiceIngress } from "../calls/voice-ingress-preflight.js";

describe("voice ingress preflight", () => {
  beforeEach(() => {
    mockLoadConfig = () => ({
      ingress: { enabled: true, publicBaseUrl: "https://example.com" },
    });
    mockGetIsPlatform = () => false;
  });

  test("returns success immediately for platform-callback deployments", async () => {
    mockGetIsPlatform = () => true;
    mockLoadConfig = () => ({ ingress: { enabled: false } });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("");
      expect(result.ingressConfig.ingress?.enabled).toBe(false);
    }
  });

  test("accepts public base URL for Twilio when configured", async () => {
    mockLoadConfig = () => ({
      ingress: {
        enabled: true,
        publicBaseUrl: "https://twilio.example.com/",
      },
    });

    const result = await preflightVoiceIngress();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicBaseUrl).toBe("https://twilio.example.com");
      expect(result.ingressConfig.ingress?.publicBaseUrl).toBe(
        "https://twilio.example.com",
      );
    }
  });
});
