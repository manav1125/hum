/**
 * Regression: client `/v1/assistants/{id}/<route>` paths must propagate to the
 * daemon's flat `/v1/<route>` form through BOTH gateway transports — the HTTP
 * runtime proxy and the IPC runtime proxy.
 *
 * The bug this guards against: a daemon route works through one transport but
 * 404s through the other because only one of them strips the
 * `/v1/assistants/{id}` prefix. That is route-agnostic by construction — it
 * affects every route, including any future one — so the test exercises an OLD
 * route (`work-items`) alongside the two routes that surfaced the bug
 * (`next-move`, `activity`) and asserts they all behave identically.
 *
 * Both proxies share `toFlatDaemonPath`; the unit test below pins that helper
 * directly so the contract is locked even if a transport stops calling it.
 */

import { describe, test, expect, mock } from "bun:test";
import "../../__tests__/test-preload.js";

import { toFlatDaemonPath } from "./assistant-scoped-path.js";

// ---------------------------------------------------------------------------
// Shared rewrite helper — the single source of truth both proxies must use.
// ---------------------------------------------------------------------------

describe("toFlatDaemonPath", () => {
  test.each([
    ["/v1/assistants/abc123/work-items", "/v1/work-items"],
    ["/v1/assistants/abc123/next-move", "/v1/next-move"],
    ["/v1/assistants/abc123/activity", "/v1/activity"],
    // multi-segment + params survive the rewrite
    ["/v1/assistants/abc123/work-items/wi_1/run", "/v1/work-items/wi_1/run"],
    // already-flat paths pass through untouched
    ["/v1/work-items", "/v1/work-items"],
    ["/v1/next-move", "/v1/next-move"],
    // non-/v1 paths are not rewritten
    ["/healthz", "/healthz"],
  ])("%s -> %s", (input, expected) => {
    expect(toFlatDaemonPath(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// HTTP runtime proxy — mocks the upstream daemon and asserts the forwarded URL.
// ---------------------------------------------------------------------------

describe("HTTP runtime proxy forwards assistant-scoped paths flat", () => {
  const captured: { url: string } = { url: "" };

  mock.module("../../fetch.js", () => ({
    fetchImpl: (input: string | URL | Request) => {
      captured.url = typeof input === "string" ? input : input.toString();
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  }));

  let handler: ((req: Request, ip?: string) => Promise<Response>) | null = null;

  async function getHandler() {
    if (handler) return handler;
    const { initSigningKey } = await import("../../auth/token-service.js");
    initSigningKey(Buffer.alloc(32, 7));
    const { createRuntimeProxyHandler } = await import("./runtime-proxy.js");
    handler = createRuntimeProxyHandler({
      assistantRuntimeBaseUrl: "http://localhost:7821",
      runtimeProxyRequireAuth: false,
      runtimeTimeoutMs: 30000,
    } as unknown as import("../../config.js").GatewayConfig);
    return handler;
  }

  async function proxy(path: string) {
    captured.url = "";
    const h = await getHandler();
    const res = await h(
      new Request(`http://gateway${path}`, { method: "GET" }),
      "127.0.0.1",
    );
    return { status: res.status, upstreamUrl: captured.url };
  }

  test.each([
    ["/v1/assistants/abc123/work-items", "http://localhost:7821/v1/work-items"],
    ["/v1/assistants/abc123/next-move", "http://localhost:7821/v1/next-move"],
    ["/v1/assistants/abc123/activity", "http://localhost:7821/v1/activity"],
  ])("%s forwards to %s (200)", async (path, expected) => {
    const r = await proxy(path);
    expect(r.upstreamUrl).toBe(expected);
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// IPC runtime proxy — mocks the IPC client + route schema and asserts the
// resolved operationId. This is the transport the gateway is cutting over to.
// ---------------------------------------------------------------------------

describe("IPC runtime proxy resolves assistant-scoped paths", () => {
  class MockIpcHandlerError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = "IpcHandlerError";
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  class MockIpcTransportError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "IpcTransportError";
    }
  }

  const ROUTE_SCHEMA = [
    {
      operationId: "list_work_items",
      endpoint: "work-items",
      method: "GET",
      policy: {
        requiredScopes: ["settings.read"],
        allowedPrincipalTypes: ["actor"],
      },
    },
    {
      operationId: "get_next_move",
      endpoint: "next-move",
      method: "GET",
      policy: {
        requiredScopes: ["settings.read"],
        allowedPrincipalTypes: ["actor"],
      },
    },
    {
      operationId: "activity_list",
      endpoint: "activity",
      method: "GET",
      policy: {
        requiredScopes: ["settings.read"],
        allowedPrincipalTypes: ["actor"],
      },
    },
  ];

  const calledOps: string[] = [];
  const ipcCallAssistantMock = mock((method: string): Promise<unknown> => {
    if (method === "get_route_schema") return Promise.resolve(ROUTE_SCHEMA);
    calledOps.push(method);
    return Promise.resolve({ ok: true });
  });

  mock.module("../../ipc/assistant-client.js", () => ({
    ipcCallAssistant: ipcCallAssistantMock,
    IpcHandlerError: MockIpcHandlerError,
    IpcTransportError: MockIpcTransportError,
  }));

  // Auth is disabled in the config passed to tryIpcProxy below, so
  // validateEdgeToken is never reached — no need to mock token-exchange
  // (mocking it would clobber mintExchangeToken/mintServiceToken, which the
  // HTTP proxy in the sibling describe block imports from the same module).

  let ready: Promise<
    (req: Request, config: unknown) => Promise<Response | null>
  > | null = null;

  async function getTryIpc() {
    if (!ready) {
      ready = (async () => {
        const { refreshRouteSchema } =
          await import("../../ipc/route-schema-cache.js");
        await refreshRouteSchema();
        const mod = await import("./ipc-runtime-proxy.js");
        return mod.tryIpcProxy as unknown as (
          req: Request,
          config: unknown,
        ) => Promise<Response | null>;
      })();
    }
    return ready;
  }

  async function ipc(path: string) {
    calledOps.length = 0;
    const tryIpcProxy = await getTryIpc();
    const res = await tryIpcProxy(
      new Request(`http://gateway${path}`, {
        method: "GET",
        headers: { "x-vellum-proxy-server": "ipc" },
      }),
      { runtimeProxyRequireAuth: false },
    );
    return { status: res?.status ?? null, op: calledOps[0] ?? null };
  }

  test.each([
    ["/v1/assistants/abc123/work-items", "list_work_items"],
    ["/v1/assistants/abc123/next-move", "get_next_move"],
    ["/v1/assistants/abc123/activity", "activity_list"],
    // flat paths still resolve (no assistant prefix)
    ["/v1/work-items", "list_work_items"],
  ])("%s resolves to op %s (200)", async (path, expectedOp) => {
    const r = await ipc(path);
    expect(r.op).toBe(expectedOp);
    expect(r.status).toBe(200);
  });
});
