/**
 * Tests for `hasPollableCredential` — the watcher engine's pre-poll gate.
 *
 * This is the gate that decides whether a watcher tick even attempts a fetch.
 * It used to ask only "is there a row in `oauth_connections`", which is the
 * wrong question on any install whose tools were connected through the
 * Connectors page: `resolveOAuthConnection` is Composio-first, so those
 * installs poll fine with an empty native table. Production had exactly that
 * shape — zero native connections, nine ACTIVE Composio toolkits — so every
 * watcher there would have skipped every poll forever.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let nativeConnections: string[] = [];
let activeToolkits: string[] | null = [];
let mcpProviders: string[] = [];

// Override only the three readers the gate consults; everything else in each
// module keeps its real export so unrelated importers still resolve.
const realOauthStore = await import("../../oauth/oauth-store.js");
mock.module("../../oauth/oauth-store.js", () => ({
  ...realOauthStore,
  getProvider: (key: string) => ({ providerKey: key }),
  listActiveConnectionsByProvider: (provider: string) =>
    nativeConnections.includes(provider) ? [{ id: `conn-${provider}` }] : [],
}));

const realStatus =
  await import("../../capabilities/composio-connection-status.js");
mock.module("../../capabilities/composio-connection-status.js", () => ({
  ...realStatus,
  getComposioConnectionStatus: () =>
    activeToolkits === null
      ? null
      : { active: new Set(activeToolkits), refreshedAt: Date.now() },
}));

const realMcp = await import("../../capabilities/mcp-connectors.js");
mock.module("../../capabilities/mcp-connectors.js", () => ({
  ...realMcp,
  isProviderMcpConnected: (provider: string) => mcpProviders.includes(provider),
}));

const {
  hasCredentialConnection,
  hasPollableCredential,
  isProviderAgentReachable,
} = await import("../credential-health-service.js");

beforeEach(() => {
  nativeConnections = [];
  activeToolkits = [];
  mcpProviders = [];
});

describe("hasPollableCredential", () => {
  test("is true for a Composio-only install (no native OAuth rows)", () => {
    activeToolkits = ["gmail", "googlecalendar", "slack"];

    expect(hasCredentialConnection("google")).toBe(false);
    expect(hasPollableCredential("google")).toBe(true);
  });

  test("is true for a native connection with no Composio at all", () => {
    nativeConnections = ["google"];
    activeToolkits = null;

    expect(hasPollableCredential("google")).toBe(true);
  });

  test("is false when the provider's toolkits are not in the active set", () => {
    // Composio is configured and reachable, but Google was disconnected —
    // this is the disconnect path: the engine skips (with backoff) rather
    // than calling the API and burning the circuit breaker.
    activeToolkits = ["slack", "notion"];

    expect(hasPollableCredential("google")).toBe(false);
  });

  test("is false when nothing at all is connected", () => {
    expect(hasPollableCredential("google")).toBe(false);
  });

  test("does NOT count a plain MCP server — that is not a pollable credential", () => {
    mcpProviders = ["linear"];

    // Reachable by the agent, but a REST poller has nothing to authenticate
    // with, so the gate must stay closed.
    expect(isProviderAgentReachable("linear")).toBe(true);
    expect(hasPollableCredential("linear")).toBe(false);
  });

  test("is false for a provider with no Composio toolkit mapping", () => {
    activeToolkits = ["gmail"];

    expect(hasPollableCredential("stripe")).toBe(false);
  });
});
