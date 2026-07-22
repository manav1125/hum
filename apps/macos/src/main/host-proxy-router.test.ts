import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs — must precede the router import
// ---------------------------------------------------------------------------

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("./device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

const mockGetGuardianAccessToken = mock(
  async (): Promise<
    | { ok: true; accessToken: string }
    | { ok: false; status: number; error: string }
  > => ({ ok: true, accessToken: "test-token" }),
);
mock.module("@vellumai/local-mode", () => ({
  getGuardianAccessToken: mockGetGuardianAccessToken,
  resolveConfigDir: () => "/tmp/test-config",
}));

// Minimal lockfile-watcher stub — capture the listener
let lockfileListener:
  | ((lockfile: import("@vellumai/local-mode/contract").Lockfile) => void)
  | null = null;
mock.module("./lockfile-watcher", () => ({
  onLockfileChange: (listener: typeof lockfileListener) => {
    lockfileListener = listener;
    return () => {
      lockfileListener = null;
    };
  },
  getWatchedLockfile: () => ({ assistants: [], activeAssistant: null }),
}));

// Stub electron-log. Warnings are captured: the events stream carries the
// assistant's whole event feed, and a router that warns on each one buries the
// log under every conversation — so "stays quiet" is a behaviour worth testing.
const loggedWarnings: string[] = [];
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: (...args: unknown[]) => {
        loggedWarnings.push(args.map(String).join(" "));
      },
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

// Stub session-token-store
let mockSessionToken: string | null = "test-session-token";
mock.module("./session-token-store", () => ({
  getSessionToken: () => mockSessionToken,
}));

const { setSelfHostActorTokenReader, __resetSelfHostActorTokenForTesting } =
  await import("./self-host-token");

const { HostProxySseClient } = await import("./host-proxy-sse");
const { HostProxyPoster } = await import("./host-proxy-poster");
const {
  installHostProxyBridge,
  setExecutor,
  removeExecutor,
  requestAssistantRoute,
  hasAssistantConnection,
  __testing,
} = await import("./host-proxy-router");

type Lockfile = import("@vellumai/local-mode/contract").Lockfile;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeCliResolver = async () => ({ command: "echo", baseArgs: [] });

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Mock globalThis.fetch for the /auth/token exchange (local gateway). Cloud
// connections resolve their org from the lockfile, so they make no fetch here.
const originalFetch = globalThis.fetch;
const mockGatewayTokenFetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/auth/token")) {
    return new Response(
      JSON.stringify({ token: "gateway-jwt", expiresAt: Date.now() + 60_000 }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return new Response("ok");
};
globalThis.fetch = mockGatewayTokenFetch as typeof globalThis.fetch;

/** Create a poster that captures the first POST body for assertions. */
function capturingPoster(): {
  poster: InstanceType<typeof HostProxyPoster>;
  body: () => Record<string, unknown> | null;
} {
  let postedBody: Record<string, unknown> | null = null;
  const fakeFetch = async (_url: unknown, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response("ok");
  };
  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer t" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { poster, body: () => postedBody };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-proxy-router", () => {
  afterEach(() => {
    __testing.reset();
    lockfileListener = null;
    mockGetGuardianAccessToken.mockReset();
    mockGetGuardianAccessToken.mockImplementation(async () => ({
      ok: true,
      accessToken: "test-token",
    }));
    mockSessionToken = "test-session-token";
    globalThis.fetch = mockGatewayTokenFetch as typeof globalThis.fetch;
    __resetSelfHostActorTokenForTesting();
    delete process.env.CUE_SERVER_URL;
  });

  // -- Local lifecycle ----------------------------------------------------

  describe("local lifecycle", () => {
    test("connects when an assistant with a gatewayPort appears", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      };
      lockfileListener?.(lockfile);
      await flush();

      expect(__testing.connections.has("a1")).toBe(true);
      const conn = __testing.connections.get("a1")!;
      expect(conn.sse).toBeInstanceOf(HostProxySseClient);
      expect(conn.poster).toBeInstanceOf(HostProxyPoster);
      expect(conn.fingerprint).toBe("local:9001");
    });

    test("disconnects when an assistant is retired", async () => {
      installHostProxyBridge(fakeCliResolver);

      // Appear
      lockfileListener?.({
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      });
      await flush();
      expect(__testing.connections.has("a1")).toBe(true);

      // Retire
      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();
      expect(__testing.connections.has("a1")).toBe(false);
    });

    test("ignores assistants without resources or runtimeUrl", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [{ assistantId: "no-resources" }],
        activeAssistant: null,
      });
      await flush();

      expect(__testing.connections.has("no-resources")).toBe(false);
    });

    test("does not duplicate connections on repeated lockfile updates", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      };

      lockfileListener?.(lockfile);
      await flush();
      const firstSse = __testing.connections.get("a1")!.sse;

      lockfileListener?.(lockfile);
      await flush();
      // Same instance — no duplicate connection
      expect(__testing.connections.get("a1")!.sse).toBe(firstSse);
    });

    test("teardown disconnects all and clears listener", async () => {
      const teardown = installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      });
      await flush();
      expect(__testing.connections.size).toBe(1);

      teardown();
      expect(__testing.connections.size).toBe(0);
      expect(lockfileListener).toBeNull();
    });

    test("does not connect when guardian token fetch fails", async () => {
      mockGetGuardianAccessToken.mockImplementation(async () => ({
        ok: false,
        status: 401,
        error: "expired",
      }));
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      });
      await flush();

      expect(__testing.connections.has("a1")).toBe(false);
    });
  });

  // -- Cloud lifecycle ----------------------------------------------------

  describe("cloud lifecycle", () => {
    test("connects when a cloud assistant with runtimeUrl appears", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(true);
      const conn = __testing.connections.get("cloud-1")!;
      expect(conn.sse).toBeInstanceOf(HostProxySseClient);
      expect(conn.poster).toBeInstanceOf(HostProxyPoster);
      expect(conn.fingerprint).toBe("cloud:https://platform.vellum.ai:");
    });

    test("stamps organizationId from the lockfile into the fingerprint", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-from-lockfile",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:org-from-lockfile",
      );
    });

    test("reconnects cloud assistant when organizationId changes", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-a",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-b",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.get("cloud-1")!.sse).not.toBe(firstSse);
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:org-b",
      );
    });

    test("skips cloud assistant when no session token is available", async () => {
      mockSessionToken = null;
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(false);
    });

    test("disconnects cloud assistant when removed from lockfile", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      expect(__testing.connections.has("cloud-1")).toBe(true);

      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();
      expect(__testing.connections.has("cloud-1")).toBe(false);
    });

    test("handles mixed local and cloud assistants", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "local-1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "local-1",
      });
      await flush();

      expect(__testing.connections.has("local-1")).toBe(true);
      expect(__testing.connections.has("cloud-1")).toBe(true);
      expect(__testing.connections.get("local-1")!.fingerprint).toBe(
        "local:9001",
      );
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:",
      );
    });

    test("reconnects cloud assistant when runtimeUrl changes", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://old.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://new.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(true);
      expect(__testing.connections.get("cloud-1")!.sse).not.toBe(firstSse);
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://new.vellum.ai:",
      );
    });

    test("ignores non-vellum cloud assistants without resources", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "custom-1",
            cloud: "custom",
            runtimeUrl: "https://my-server.com",
          },
        ],
        activeAssistant: "custom-1",
      });
      await flush();

      expect(__testing.connections.has("custom-1")).toBe(false);
    });

    test("does not duplicate cloud connections on repeated lockfile updates", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      };

      lockfileListener?.(lockfile);
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.(lockfile);
      await flush();
      expect(__testing.connections.get("cloud-1")!.sse).toBe(firstSse);
    });
  });

  // -- Self-host lifecycle -------------------------------------------------
  //
  // The regression these guard: a self-host install has NO lockfile entry, so
  // the router never opened a connection, the daemon never saw a `macos`
  // client, and every desktop capability (host_bash / host_cu / Desktop
  // control / Cue Live's routes) had nothing to target.

  describe("self-host lifecycle", () => {
    const SELF_HOST_KEY = __testing.SELF_HOST_CONNECTION_KEY;

    /** Point the app at an instance the way a connected install is. */
    function pointAtInstance(url: string | null): void {
      if (url === null) delete process.env.CUE_SERVER_URL;
      else process.env.CUE_SERVER_URL = url;
    }

    test("registers this Mac against the connected instance", async () => {
      const seen: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          headers: init.headers as Record<string, string>,
        });
        return new Response("ok");
      }) as unknown as typeof globalThis.fetch;

      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");

      await __testing.reconcileSelfHostConnection();
      await flush();

      const conn = __testing.connections.get(SELF_HOST_KEY)!;
      expect(conn).toBeDefined();
      expect(conn.fingerprint).toBe("selfhost:https://manav.justcue.app");
      expect(conn.target).toEqual({
        kind: "selfhost",
        assistantId: "self",
        baseUrl: "https://manav.justcue.app",
      });

      // The SSE subscribe is what registers the client. It must hit the
      // assistant-scoped events route, carry the actor token as a bearer, and
      // identify as the macos interface — that trio is what makes the daemon
      // list it under `capability=host_bash`.
      const events = seen.find((c) => c.url.includes("/events"))!;
      expect(events.url).toBe(
        "https://manav.justcue.app/v1/assistants/self/events",
      );
      expect(events.headers.Authorization).toBe("Bearer actor-jwt");
      expect(events.headers["X-Vellum-Interface-Id"]).toBe("macos");
      expect(events.headers["X-Vellum-Client-Id"]).toBe(MOCK_DEVICE_ID);
      expect(events.headers["X-Vellum-Machine-Name"]).toBeTruthy();
    });

    test("waits instead of connecting when the session has no token", async () => {
      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => null);

      await __testing.reconcileSelfHostConnection();
      await flush();

      // An unauthenticated connection would 401-loop while making the app
      // look connected — worse than staying dark until the renderer is ready.
      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(false);
    });

    test("does nothing when this install is not pointed at an instance", async () => {
      pointAtInstance(null);
      setSelfHostActorTokenReader(async () => "actor-jwt");

      await __testing.reconcileSelfHostConnection();
      await flush();

      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(false);
    });

    test("is idempotent — a second reconcile keeps the same connection", async () => {
      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");

      await __testing.reconcileSelfHostConnection();
      await flush();
      const first = __testing.connections.get(SELF_HOST_KEY)!.sse;

      await __testing.reconcileSelfHostConnection();
      await flush();

      expect(__testing.connections.get(SELF_HOST_KEY)!.sse).toBe(first);
    });

    test("reconnects when the instance changes", async () => {
      pointAtInstance("https://one.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");
      await __testing.reconcileSelfHostConnection();
      await flush();
      const first = __testing.connections.get(SELF_HOST_KEY)!.sse;

      pointAtInstance("https://two.justcue.app/assistant/");
      await __testing.reconcileSelfHostConnection();
      await flush();

      const conn = __testing.connections.get(SELF_HOST_KEY)!;
      expect(conn.sse).not.toBe(first);
      expect(conn.fingerprint).toBe("selfhost:https://two.justcue.app");
    });

    test("disconnects when the instance is cleared", async () => {
      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");
      await __testing.reconcileSelfHostConnection();
      await flush();
      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(true);

      process.env.CUE_SERVER_URL = "";
      await __testing.reconcileSelfHostConnection();
      await flush();

      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(false);
    });

    test("survives lockfile events — it is not a lockfile assistant", async () => {
      installHostProxyBridge(fakeCliResolver);
      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");
      await __testing.reconcileSelfHostConnection();
      await flush();

      // An empty lockfile prunes every lockfile-derived connection. The
      // self-host one must not be swept up with them.
      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();

      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(true);
    });

    test("installHostProxyBridge connects a self-host install on startup", async () => {
      pointAtInstance("https://manav.justcue.app/assistant/");
      setSelfHostActorTokenReader(async () => "actor-jwt");

      installHostProxyBridge(fakeCliResolver);
      await flush();

      expect(__testing.connections.has(SELF_HOST_KEY)).toBe(true);
    });
  });

  // -- Message dispatch ----------------------------------------------------

  describe("message dispatch", () => {
    test("routes request to registered executor", () => {
      const handled: string[] = [];
      setExecutor("host_bash", {
        handleRequest: (msg) => {
          handled.push(`req:${msg.requestId}`);
        },
        handleCancel: (msg) => {
          handled.push(`cancel:${msg.requestId}`);
        },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_bash_request", requestId: "r1" },
        poster,
      );
      __testing.dispatchMessage(
        { type: "host_bash_cancel", requestId: "r2" },
        poster,
      );

      expect(handled).toEqual(["req:r1", "cancel:r2"]);
      removeExecutor("host_bash");
    });

    test("routes file messages to file executor", () => {
      const handled: string[] = [];
      setExecutor("host_file", {
        handleRequest: (msg) => {
          handled.push(`req:${msg.requestId}`);
        },
        handleCancel: (msg) => {
          handled.push(`cancel:${msg.requestId}`);
        },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_file_request", requestId: "f1" },
        poster,
      );

      expect(handled).toEqual(["req:f1"]);
      removeExecutor("host_file");
    });

    test("posts stub error for unimplemented bash executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_bash_request", requestId: "r1" },
        poster,
      );
      await flush();

      expect(body()).not.toBeNull();
      expect(body()!.requestId).toBe("r1");
      expect(body()!.stderr).toBe("Executor not yet implemented");
      expect(body()!.exitCode).toBe(1);
    });

    test("posts stub error for unimplemented file executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_file_request", requestId: "f1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("f1");
      expect(body()!.isError).toBe(true);
    });

    test("posts stub error for unimplemented transfer executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_transfer_request", requestId: "t1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("t1");
      expect(body()!.isError).toBe(true);
      expect(body()!.errorMessage).toBe("Executor not yet implemented");
    });

    test("posts stub error for unimplemented browser executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage(
        { type: "host_browser_request", requestId: "b1" },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("b1");
      expect(body()!.isError).toBe(true);
    });

    test("ignores unknown message types without crashing", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      // Should not throw
      __testing.dispatchMessage(
        { type: "host_unknown_request", requestId: "u1" },
        poster,
      );

      // A host_* message we cannot route is a real defect — still logged.
      expect(loggedWarnings.join("\n")).toContain("unroutable host message");
    });

    test("stays silent on ordinary assistant events", () => {
      // The connection subscribes to the assistant's whole event feed. Every
      // conversation delta arrives here; warning on each one floods the log.
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () =>
          new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      loggedWarnings.length = 0;
      for (const type of [
        "assistant_thinking_delta",
        "tool_use_start",
        "tool_output_chunk",
        "usage_progress",
      ]) {
        __testing.dispatchMessage({ type }, poster);
      }

      expect(loggedWarnings).toEqual([]);
    });
  });

  // -- requestAssistantRoute (Cue Live's path to a daemon) -----------------

  describe("requestAssistantRoute", () => {
    test("reaches the CLOUD assistant when there is no local daemon", async () => {
      // The regression this guards: Cue Live only ever called the local
      // daemon. On a cloud-only install nothing was listening, the summon
      // returned null, and it surfaced as "look returned invalid payload" —
      // vision was dead on every such machine.
      const calls: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          headers: init.headers as Record<string, string>,
        });
        return new Response(JSON.stringify({ answer: "hi", points: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;

      __testing.connectCloudAssistant(
        "a1",
        "https://cloud.example.com",
        "org1",
      );
      const out = await requestAssistantRoute("/cuelive/look", { q: 1 });

      expect(out).toEqual({ answer: "hi", points: [] });
      // The SSE client connects on the same fetch stub; assert on the look call.
      const look = calls.filter((c) => c.url.includes("/cuelive/look"));
      expect(look).toHaveLength(1);
      expect(look[0].url).toBe(
        "https://cloud.example.com/v1/assistants/a1/cuelive/look",
      );
      expect(look[0].headers["X-Session-Token"]).toBe("test-session-token");
      expect(look[0].headers["Vellum-Organization-Id"]).toBe("org1");
    });

    test("reaches the SELF-HOST instance when there is no lockfile assistant", async () => {
      // Cue Live's /cuelive/* calls logged "no assistant connected" forever on
      // a self-host install, because only lockfile-derived connections existed.
      const calls: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          headers: init.headers as Record<string, string>,
        });
        return new Response(JSON.stringify({ answer: "hi" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;

      process.env.CUE_SERVER_URL = "https://manav.justcue.app/assistant/";
      setSelfHostActorTokenReader(async () => "actor-jwt");
      await __testing.reconcileSelfHostConnection();

      expect(hasAssistantConnection()).toBe(true);
      const out = await requestAssistantRoute("/cuelive/look", { q: 1 });

      expect(out).toEqual({ answer: "hi" });
      const look = calls.filter((c) => c.url.includes("/cuelive/look"));
      expect(look).toHaveLength(1);
      expect(look[0].url).toBe(
        "https://manav.justcue.app/v1/assistants/self/cuelive/look",
      );
      expect(look[0].headers.Authorization).toBe("Bearer actor-jwt");
    });

    test("returns null when nothing is connected", async () => {
      expect(await requestAssistantRoute("/cuelive/look", {})).toBeNull();
    });
  });

  // -- Executor registry ---------------------------------------------------

  describe("executor registry", () => {
    test("setExecutor and removeExecutor manage the registry", () => {
      const executor = {
        handleRequest: () => {},
        handleCancel: () => {},
      };

      setExecutor("host_bash", executor);
      expect(__testing.executors.has("host_bash")).toBe(true);

      removeExecutor("host_bash");
      expect(__testing.executors.has("host_bash")).toBe(false);
    });
  });
});
