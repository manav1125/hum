import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mutable mock state ────────────────────────────────────────────────
let mockMcpServers: Record<string, { enabled?: boolean }> | undefined = {};
let mockNativeRows: Array<{ provider: string }> = [];
let mockToolNames: string[] = [];
let dbThrows = false;

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...actualConfigLoader,
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

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualDbConnection = await import("../memory/db-connection.js");
mock.module("../memory/db-connection.js", () => ({
  ...actualDbConnection,
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

// Cached Composio ACTIVE-status source. Default "active" so the classic
// "MCP-backed providers show up" cases hold; individual tests override a slug
// to "broken"/"unknown" to model an initiated/expired or cold-cache account.
let mockToolkitStatus: Record<string, "active" | "broken" | "unknown"> = {};
let defaultStatus: "active" | "broken" | "unknown" = "active";

mock.module("./composio-connection-status.js", () => ({
  composioToolkitStatus: (slug: string) =>
    mockToolkitStatus[slug.toLowerCase()] ?? defaultStatus,
  kickComposioStatusRefresh: () => {},
}));

const { buildCapabilitySnapshot } = await import("./capability-snapshot.js");

afterEach(() => {
  mockMcpServers = {};
  mockNativeRows = [];
  mockToolNames = [];
  dbThrows = false;
  mockToolkitStatus = {};
  defaultStatus = "active";
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

describe("buildCapabilitySnapshot honesty — over-claim prevention", () => {
  // The incident: googlesheets ACTIVE but gmail `initiated`. Both map to
  // "google". "google" must NOT appear in `connectors` (hard linked accounts),
  // and must surface as an unverified integration the model verifies first.
  test("an initiated/expired Composio account is NOT a linked connector", () => {
    mockNativeRows = [];
    mockToolkitStatus = { googlesheets: "active", gmail: "broken" };
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_googlesheets: { enabled: true },
    };
    const snap = buildCapabilitySnapshot();
    expect(snap.connectors).not.toContain("google");
    expect(snap.unverifiedConnectors).toContain("google");
  });

  test("a genuinely ACTIVE Composio account IS a linked connector", () => {
    mockNativeRows = [];
    mockToolkitStatus = { slack: "active" };
    mockMcpServers = { composio_slack: { enabled: true } };
    const snap = buildCapabilitySnapshot();
    expect(snap.connectors).toContain("slack");
    expect(snap.unverifiedConnectors).not.toContain("slack");
  });

  test("an unverified integration adds a verify-before-relying capability line", () => {
    mockNativeRows = [];
    mockToolkitStatus = { gmail: "broken" };
    mockMcpServers = { composio_gmail: { enabled: true } };
    const snap = buildCapabilitySnapshot();
    expect(snap.unverifiedConnectors).toEqual(["google"]);
    expect(
      snap.lines.some(
        (l) => l.includes("NOT confirmed working") && l.includes("google"),
      ),
    ).toBe(true);
  });

  test("a native active token keeps the provider verified despite a broken Composio copy", () => {
    // Native google OAuth is authoritative — the account works even if the
    // Composio gmail connection is down, so it stays a linked connector.
    mockNativeRows = [{ provider: "google" }];
    mockToolkitStatus = { gmail: "broken" };
    mockMcpServers = { composio_gmail: { enabled: true } };
    const snap = buildCapabilitySnapshot();
    expect(snap.connectors).toContain("google");
    expect(snap.unverifiedConnectors).not.toContain("google");
  });

  test("cold cache: MCP providers are unverified, not asserted as linked", () => {
    mockNativeRows = [];
    defaultStatus = "unknown";
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_slack: { enabled: true },
    };
    const snap = buildCapabilitySnapshot();
    expect(snap.connectors).toEqual([]);
    expect(snap.unverifiedConnectors).toEqual(["google", "slack"]);
  });
});
