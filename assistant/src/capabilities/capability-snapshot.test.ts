import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mutable mock state ────────────────────────────────────────────────
let mockMcpServers: Record<string, { enabled?: boolean }> | undefined = {};
let mockNativeRows: Array<{ provider: string }> = [];
let mockToolNames: string[] = [];
let dbThrows = false;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ mcp: { servers: mockMcpServers }, twilio: undefined }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

mock.module("../memory/schema/oauth.js", () => ({
  oauthConnections: { provider: "provider", status: "status" },
}));

mock.module("../memory/db-connection.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => {
            if (dbThrows) throw new Error("db down");
            return mockNativeRows;
          },
        }),
      }),
    }),
  }),
}));

mock.module("../tasks/tool-sanitizer.js", () => ({
  getRegisteredToolNames: () => mockToolNames,
}));

const { buildCapabilitySnapshot } = await import("./capability-snapshot.js");

afterEach(() => {
  mockMcpServers = {};
  mockNativeRows = [];
  mockToolNames = [];
  dbThrows = false;
});

describe("buildCapabilitySnapshot connectors reconciliation", () => {
  test("includes MCP-backed providers when native OAuth is empty", () => {
    // The prod scenario: oauth_connections is empty, everything via MCP.
    mockNativeRows = [];
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_slack: { enabled: true },
      composio_github: { enabled: true },
    };
    expect(buildCapabilitySnapshot().connectors).toEqual([
      "github",
      "google",
      "slack",
    ]);
  });

  test("de-dupes a provider connected both natively and via MCP", () => {
    mockNativeRows = [{ provider: "google" }, { provider: "slack" }];
    mockMcpServers = {
      composio_gmail: { enabled: true }, // google again
      composio_notion: { enabled: true }, // MCP-only
    };
    expect(buildCapabilitySnapshot().connectors).toEqual([
      "google",
      "notion",
      "slack",
    ]);
  });

  test("native-only providers still appear when MCP is empty", () => {
    mockNativeRows = [{ provider: "linear" }];
    mockMcpServers = {};
    expect(buildCapabilitySnapshot().connectors).toEqual(["linear"]);
  });

  test("a provider connected by NEITHER path is absent (honest)", () => {
    mockNativeRows = [{ provider: "google" }];
    mockMcpServers = { composio_slack: { enabled: true } };
    const connectors = buildCapabilitySnapshot().connectors;
    expect(connectors).not.toContain("github");
    expect(connectors).toEqual(["google", "slack"]);
  });

  test("native DB failure degrades to MCP-only rather than nothing", () => {
    dbThrows = true;
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(buildCapabilitySnapshot().connectors).toEqual(["google"]);
  });
});
