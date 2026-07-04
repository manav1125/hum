import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Control the gateway-session seam so we can exercise both the
// gateway-auth (local / Cue self-host) branch and the platform-managed
// self-hosted branch of `getSelfHostedActorToken()` deterministically.
// Defaults to "disabled" so the pre-existing snapshot-path tests below are
// unaffected.
let gatewayAuthEnabled = false;
let liveGatewayToken: string | null = null;

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => gatewayAuthEnabled,
  getGatewayToken: () => liveGatewayToken,
}));

const {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} = await import("@/lib/self-hosted/connection");

describe("self-hosted connection slot", () => {
  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("starts with both slots null", () => {
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
  });

  test("round-trips url + token through the single setter", () => {
    setSelfHostedConnection({
      url: "https://example.ngrok-free.app",
      token: "token-xyz",
    });
    expect(getSelfHostedIngressUrl()).toBe("https://example.ngrok-free.app");
    expect(getSelfHostedActorToken()).toBe("token-xyz");
  });

  test("setting null clears both slots", () => {
    setSelfHostedConnection({
      url: "https://example.ngrok-free.app",
      token: "token-xyz",
    });
    setSelfHostedConnection(null);
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
  });

  test("either slot can be null independently while the other is set", () => {
    // Brief window after `is_local=true` flips but before the gateway
    // registers a public hostname — url stays null, token may already
    // be present.
    setSelfHostedConnection({ url: null, token: "token-only" });
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBe("token-only");

    // Brief window after hatch but before bootstrap_platform_actor_token
    // lands a value — ingress known, token still null.
    setSelfHostedConnection({
      url: "https://example.ngrok-free.app",
      token: null,
    });
    expect(getSelfHostedIngressUrl()).toBe("https://example.ngrok-free.app");
    expect(getSelfHostedActorToken()).toBeNull();
  });
});

describe("getSelfHostedActorToken — gateway-auth token freshness", () => {
  beforeEach(() => {
    gatewayAuthEnabled = false;
    liveGatewayToken = null;
    setSelfHostedConnection(null);
  });

  afterEach(() => {
    gatewayAuthEnabled = false;
    liveGatewayToken = null;
    setSelfHostedConnection(null);
  });

  test("platform-managed path: returns the snapshot, ignoring the live token", () => {
    // gateway-auth disabled (e.g. platform self-hosted) → the slot's
    // platform actor token is authoritative; a stray live token is ignored.
    liveGatewayToken = "should-be-ignored";
    setSelfHostedConnection({
      url: "https://gw.example",
      token: "platform-actor",
    });
    expect(getSelfHostedActorToken()).toBe("platform-actor");
  });

  test("gateway-auth path: prefers the live gateway token over a stale snapshot", () => {
    // This is the regression guard for the intermittent-logout bug: the
    // slot was primed once with a now-stale snapshot, but the gateway token
    // has rotated. Runtime-proxy + SSE requests must carry the fresh token.
    gatewayAuthEnabled = true;
    setSelfHostedConnection({
      url: "https://gw.example",
      token: "stale-snapshot",
    });
    liveGatewayToken = "fresh-rotated-token";
    expect(getSelfHostedActorToken()).toBe("fresh-rotated-token");
  });

  test("gateway-auth path: falls back to the snapshot before the first mint lands", () => {
    gatewayAuthEnabled = true;
    liveGatewayToken = null;
    setSelfHostedConnection({
      url: "https://gw.example",
      token: "snapshot-token",
    });
    expect(getSelfHostedActorToken()).toBe("snapshot-token");
  });

  test("gateway-auth path: null when neither a live token nor a snapshot exists", () => {
    gatewayAuthEnabled = true;
    liveGatewayToken = null;
    setSelfHostedConnection({ url: "https://gw.example", token: null });
    expect(getSelfHostedActorToken()).toBeNull();
  });
});
