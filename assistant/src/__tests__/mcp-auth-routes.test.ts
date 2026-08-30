import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

const mockReloadMcpServers = mock(async () => {});

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: () => mockReloadMcpServers(),
}));

const mockOrchestrateConnect = mock(
  async (_args: { serverId: string; transport: unknown }) => ({
    auth_url: "https://provider.example.com/authorize?state=abc",
  }),
);

mock.module("../mcp/mcp-auth-orchestrator.js", () => ({
  orchestrateMcpOAuthConnect: mockOrchestrateConnect,
}));

const mockGetMcpAuthState = mock((_serverId: string) => null as unknown);

mock.module("../mcp/mcp-auth-state.js", () => ({
  getMcpAuthState: mockGetMcpAuthState,
}));

const mockConfig = {
  mcp: {
    servers: {
      "my-server": {
        transport: { type: "sse", url: "https://mcp.example.com" },
        enabled: true,
        defaultRiskLevel: "high",
      },
    },
  },
};
// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
  loadRawConfig: () => mockConfig,
  saveRawConfig: () => {},
  // route-policy → config/env transitively imports `getConfig`; stub it
  // here so the mock surface matches what consumers expect.
  getConfig: () => mockConfig,
  getConfigReadOnly: () => mockConfig,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("mcp-auth-routes", () => {
  beforeEach(() => {
    mockOrchestrateConnect.mockClear();
    mockGetMcpAuthState.mockClear();
    mockGetMcpAuthState.mockImplementation(() => null);
    mockReloadMcpServers.mockClear(); // ← add this line
  });

  describe("POST internal/mcp/auth/start", () => {
    test("happy path returns { auth_url, state }", async () => {
      const startRoute = findRoute("internal_mcp_auth_start");
      const result = await startRoute.handler({
        body: { serverId: "my-server" },
      });

      expect(result).toEqual({
        auth_url: "https://provider.example.com/authorize?state=abc",
        state: "my-server",
      });
    });

    test("rejects unknown serverId with BadRequestError", async () => {
      const startRoute = findRoute("internal_mcp_auth_start");

      await expect(
        startRoute.handler({ body: { serverId: "unknown-server" } }),
      ).rejects.toMatchObject({
        name: "BadRequestError",
        message: expect.stringContaining("not configured"),
      });
    });

    test("wraps orchestrator error in InternalError", async () => {
      mockOrchestrateConnect.mockImplementationOnce(async () => {
        throw new Error("orchestrator blew up");
      });

      const startRoute = findRoute("internal_mcp_auth_start");

      await expect(
        startRoute.handler({ body: { serverId: "my-server" } }),
      ).rejects.toMatchObject({
        name: "InternalError",
        message: "orchestrator blew up",
      });
    });
  });

  describe("GET internal/mcp/auth/status/:serverId", () => {
    test("returns pending state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "pending",
        authUrl: "https://auth.example.com",
        expiresAt: Date.now() + 300_000,
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({
        status: "pending",
        auth_url: "https://auth.example.com",
      });
    });

    test("returns complete state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "complete",
        serverId: "my-server",
        completedAt: Date.now(),
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({ status: "complete" });
    });

    test("returns error state", async () => {
      mockGetMcpAuthState.mockImplementation(() => ({
        status: "error",
        error: "access_denied",
        failedAt: Date.now(),
      }));

      const statusRoute = findRoute("internal_mcp_auth_status");
      const result = await statusRoute.handler({
        pathParams: { serverId: "my-server" },
      });

      expect(result).toEqual({ status: "error", error: "access_denied" });
    });

    test("throws NotFoundError for unknown serverId", async () => {
      // mockGetMcpAuthState returns null by default (set in beforeEach)

      const statusRoute = findRoute("internal_mcp_auth_status");

      expect(() =>
        statusRoute.handler({ pathParams: { serverId: "unknown-server" } }),
      ).toThrow(
        expect.objectContaining({
          name: "NotFoundError",
        }),
      );
    });
  });

  describe("POST internal/mcp/reload", () => {
    test("happy path returns { ok: true } and kicks off reload", async () => {
      const reloadRoute = findRoute("internal_mcp_reload");
      const result = await reloadRoute.handler({ body: {} });

      expect(result).toEqual({ ok: true });
      // Flush the micro-task queue so the void promise runs
      await new Promise((r) => setTimeout(r, 0));
      expect(mockReloadMcpServers).toHaveBeenCalledTimes(1);
    });

    test("reload-throws-async still returns { ok: true } (fire-and-forget)", async () => {
      mockReloadMcpServers.mockImplementationOnce(async () => {
        throw new Error("reload failed");
      });

      const reloadRoute = findRoute("internal_mcp_reload");
      // Must not throw even though the reload promise rejects
      const result = await reloadRoute.handler({ body: {} });

      expect(result).toEqual({ ok: true });
    });
  });

  describe("POST internal/mcp/add", () => {
    function addedTransport(name: string) {
      const servers = mockConfig.mcp.servers as Record<
        string,
        { transport: Record<string, unknown> }
      >;
      return servers[name]?.transport;
    }

    test("stdio: env is written onto the transport", async () => {
      await findRoute("internal_mcp_add").handler({
        body: {
          name: "atlas-bridge",
          transportType: "stdio",
          command: "node",
          args: ["bridge.js"],
          env: { ATLAS_BRIDGE_SECRET: "s3cret", ATLAS_ENV: "production" },
        },
      });

      expect(addedTransport("atlas-bridge")).toEqual({
        type: "stdio",
        command: "node",
        args: ["bridge.js"],
        env: { ATLAS_BRIDGE_SECRET: "s3cret", ATLAS_ENV: "production" },
      });
    });

    test("stdio: env is omitted entirely when not supplied", async () => {
      await findRoute("internal_mcp_add").handler({
        body: {
          name: "plain-server",
          transportType: "stdio",
          command: "npx",
        },
      });

      const transport = addedTransport("plain-server");
      // Absent (not `env: {}`) — the schema reads a missing env as "inherit
      // the daemon environment", which is what a no-env server wants.
      expect(transport).not.toHaveProperty("env");
      expect(transport).toEqual({ type: "stdio", command: "npx", args: [] });
    });

    test("stdio: an empty env object does not add an env key", async () => {
      await findRoute("internal_mcp_add").handler({
        body: {
          name: "empty-env-server",
          transportType: "stdio",
          command: "npx",
          env: {},
        },
      });

      expect(addedTransport("empty-env-server")).not.toHaveProperty("env");
    });
  });
});
