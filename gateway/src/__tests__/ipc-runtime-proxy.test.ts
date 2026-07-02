/**
 * Tests for the IPC runtime proxy's upstream-response marker.
 *
 * The marker distinguishes DAEMON-authored responses (success results and
 * IpcHandlerError statuses relayed from the daemon) from responses the
 * gateway authors itself (auth 401s, policy 403s, transport 502s). Only
 * gateway-authored 401s may feed the auth-failure rate limiter — the
 * client's edge token was already validated before the IPC call, so a
 * daemon 401 is not a client auth failure.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";

import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
// Import the REAL error classes before mocking so `instanceof` checks in
// the proxy still match the instances our mocked ipcCallAssistant throws.
import {
  IpcHandlerError,
  IpcTransportError,
  ipcSuggestTrustRule,
} from "../ipc/assistant-client.js";
import type { RouteSchemaPolicy } from "../ipc/route-schema-cache.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

// --- Mock the IPC transport ------------------------------------------------

type IpcCall = (
  operationId: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
let ipcCall: IpcCall = async () => ({ ok: true });

mock.module("../ipc/assistant-client.js", () => ({
  IpcHandlerError,
  IpcTransportError,
  ipcSuggestTrustRule,
  ipcCallAssistant: (op: string, params: Record<string, unknown>) =>
    ipcCall(op, params),
}));

// --- Mock the route schema cache so any /v1/* route matches ----------------

// null = "route known, no policy restrictions" (undefined would fail closed).
let cachedPolicy: RouteSchemaPolicy | null | undefined = null;

mock.module("../ipc/route-schema-cache.js", () => ({
  matchRoute: () => ({ operationId: "test.op", pathParams: {} }),
  getCachedRoutePolicy: () => cachedPolicy,
}));

const { tryIpcProxy } = await import("../http/routes/ipc-runtime-proxy.js");
const { UPSTREAM_RESPONSE_MARKER_HEADER } =
  await import("../http/middleware/auth.js");

// --- Helpers ----------------------------------------------------------------

function mintEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "actor:test-assistant:test-user",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintEdgeToken();

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: false,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

function ipcRequest(init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-vellum-proxy-server", "ipc");
  return new Request("http://localhost:7830/v1/tasks", { ...init, headers });
}

afterEach(() => {
  ipcCall = async () => ({ ok: true });
  cachedPolicy = null;
});

// --- Tests -------------------------------------------------------------------

describe("IPC runtime proxy upstream-response marker", () => {
  test("daemon IpcHandlerError 401 is relayed WITH the marker", async () => {
    ipcCall = async () => {
      throw new IpcHandlerError("Unauthorized", 401, "UNAUTHORIZED");
    };

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe("1");
  });

  test("daemon JSON success is relayed WITH the marker", async () => {
    ipcCall = async () => ({ items: [] });

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe("1");
    expect(await res!.json()).toEqual({ items: [] });
  });

  test("daemon empty result (204) carries the marker", async () => {
    ipcCall = async () => null;

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe("1");
  });

  test("daemon string result carries the marker", async () => {
    ipcCall = async () => "plain-text";

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe("1");
    expect(await res!.text()).toBe("plain-text");
  });

  test("gateway-authored auth 401 (missing Authorization) has NO marker", async () => {
    const res = await tryIpcProxy(
      ipcRequest(),
      makeConfig({ runtimeProxyRequireAuth: true }),
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
  });

  test("gateway-authored auth 401 (invalid edge token) has NO marker", async () => {
    const res = await tryIpcProxy(
      ipcRequest({ headers: { authorization: "Bearer not-a-valid-token" } }),
      makeConfig({ runtimeProxyRequireAuth: true }),
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
  });

  test("valid edge token + daemon 401 still carries the marker (auth required)", async () => {
    // The exact prod bug: a fully authenticated client whose request the
    // DAEMON rejects with 401 must not be treated as a client auth failure.
    ipcCall = async () => {
      throw new IpcHandlerError(
        "Forbidden by daemon gate",
        401,
        "UNAUTHORIZED",
      );
    };

    const res = await tryIpcProxy(
      ipcRequest({ headers: { authorization: `Bearer ${TOKEN}` } }),
      makeConfig({ runtimeProxyRequireAuth: true }),
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe("1");
  });

  test("gateway-authored policy 403 (missing policy entry) has NO marker", async () => {
    cachedPolicy = undefined; // fail-closed path authored by the gateway

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(res!.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
  });

  test("gateway-authored transport 502 has NO marker", async () => {
    ipcCall = async () => {
      throw new IpcTransportError("socket gone");
    };

    const res = await tryIpcProxy(ipcRequest(), makeConfig());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(502);
    expect(res!.headers.has(UPSTREAM_RESPONSE_MARKER_HEADER)).toBe(false);
  });
});
