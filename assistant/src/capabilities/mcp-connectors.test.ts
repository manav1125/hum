import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mock config loader — drives the enabled-server set ────────────────
let mockMcpServers: Record<string, { enabled?: boolean }> | undefined = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ mcp: { servers: mockMcpServers } }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// ── Mock the cached Composio ACTIVE-status source ─────────────────────
// Keyed by toolkit slug. Unlisted slugs default to `defaultStatus`, letting a
// test model "cold cache" (unknown) vs a known snapshot with active/broken.
let mockToolkitStatus: Record<string, "active" | "broken" | "unknown"> = {};
let defaultStatus: "active" | "broken" | "unknown" = "unknown";

mock.module("./composio-connection-status.js", () => ({
  composioToolkitStatus: (slug: string) =>
    mockToolkitStatus[slug.toLowerCase()] ?? defaultStatus,
}));

const {
  mcpServerKeyToProvider,
  mcpServerKeyToComposioToolkit,
  reconcileMcpConnectors,
  listMcpConnectedProviders,
  listMcpAttentionProviders,
  isProviderMcpConnected,
} = await import("./mcp-connectors.js");

afterEach(() => {
  mockMcpServers = {};
  mockToolkitStatus = {};
  defaultStatus = "unknown";
});

/** Every listed slug is ACTIVE; unlisted stay at the given default. */
function allActive(): void {
  defaultStatus = "active";
}

describe("mcpServerKeyToProvider", () => {
  test("maps composio toolkit servers to canonical providers", () => {
    expect(mcpServerKeyToProvider("composio_gmail")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googlecalendar")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googledrive")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googlesheets")).toBe("google");
    expect(mcpServerKeyToProvider("composio_slack")).toBe("slack");
    expect(mcpServerKeyToProvider("composio_github")).toBe("github");
  });

  test("the bare composio workbench backs no single account", () => {
    expect(mcpServerKeyToProvider("composio")).toBeNull();
  });

  test("an unknown composio toolkit surfaces as its slug (never dropped)", () => {
    expect(mcpServerKeyToProvider("composio_stripe")).toBe("stripe");
  });

  test("a non-composio generic tool server is not a linked account", () => {
    expect(mcpServerKeyToProvider("filesystem")).toBeNull();
    expect(mcpServerKeyToProvider("")).toBeNull();
  });
});

describe("mcpServerKeyToComposioToolkit", () => {
  test("returns the toolkit slug only for per-toolkit composio servers", () => {
    expect(mcpServerKeyToComposioToolkit("composio_gmail")).toBe("gmail");
    expect(mcpServerKeyToComposioToolkit("composio_googlesheets")).toBe(
      "googlesheets",
    );
  });

  test("the bare workbench and non-composio servers have no toolkit", () => {
    expect(mcpServerKeyToComposioToolkit("composio")).toBeNull();
    expect(mcpServerKeyToComposioToolkit("linear")).toBeNull();
    expect(mcpServerKeyToComposioToolkit("filesystem")).toBeNull();
  });
});

describe("reconcileMcpConnectors — honest ACTIVE reconciliation", () => {
  test("all enabled composio toolkits ACTIVE → all providers verified", () => {
    allActive();
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_googlecalendar: { enabled: true },
      composio_slack: { enabled: true },
      composio_github: { enabled: true },
      composio: { enabled: true },
    };
    const { verified, needsAttention } = reconcileMcpConnectors();
    expect([...verified].sort()).toEqual(["github", "google", "slack"]);
    expect(needsAttention.size).toBe(0);
  });

  // The core regression: the incident shape. googlesheets ACTIVE, gmail
  // `initiated` (broken). Both collapse to "google". Because one backing
  // toolkit is broken, "google" must NOT read as a guaranteed linked account.
  test("an initiated/expired toolkit keeps its provider OUT of verified", () => {
    mockToolkitStatus = {
      googlesheets: "active",
      gmail: "broken", // OAuth initiated, never completed
      googlecalendar: "active",
    };
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_googlesheets: { enabled: true },
      composio_googlecalendar: { enabled: true },
    };
    const { verified, needsAttention } = reconcileMcpConnectors();
    expect(verified.has("google")).toBe(false);
    expect(needsAttention.has("google")).toBe(true);
  });

  test("a genuinely ACTIVE provider reads as verified", () => {
    mockToolkitStatus = { slack: "active" };
    mockMcpServers = { composio_slack: { enabled: true } };
    const { verified, needsAttention } = reconcileMcpConnectors();
    expect(verified.has("slack")).toBe(true);
    expect(needsAttention.has("slack")).toBe(false);
  });

  test("cold cache (unknown status) → needs attention, never verified", () => {
    defaultStatus = "unknown";
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_slack: { enabled: true },
    };
    const { verified, needsAttention } = reconcileMcpConnectors();
    expect(verified.size).toBe(0);
    expect([...needsAttention].sort()).toEqual(["google", "slack"]);
  });

  test("a non-composio native MCP server is verified without Composio status", () => {
    // `linear` bare key names a provider and has no Composio dependency.
    defaultStatus = "unknown";
    mockMcpServers = { linear: { enabled: true } };
    const { verified } = reconcileMcpConnectors();
    expect(verified.has("linear")).toBe(true);
  });

  test("an explicitly disabled server is excluded entirely", () => {
    mockToolkitStatus = { gmail: "active", slack: "active" };
    mockMcpServers = {
      composio_gmail: { enabled: false },
      composio_slack: {}, // enabled defaults to true
    };
    const { verified } = reconcileMcpConnectors();
    expect(verified.has("google")).toBe(false);
    expect(verified.has("slack")).toBe(true);
  });

  test("no MCP config degrades to empty sets (never throws)", () => {
    mockMcpServers = undefined;
    const { verified, needsAttention } = reconcileMcpConnectors();
    expect(verified.size).toBe(0);
    expect(needsAttention.size).toBe(0);
  });
});

describe("listMcpConnectedProviders / listMcpAttentionProviders", () => {
  test("connected = verified only; attention = the rest", () => {
    mockToolkitStatus = { slack: "active", gmail: "broken" };
    mockMcpServers = {
      composio_slack: { enabled: true },
      composio_gmail: { enabled: true },
    };
    expect([...listMcpConnectedProviders()]).toEqual(["slack"]);
    expect([...listMcpAttentionProviders()]).toEqual(["google"]);
  });
});

describe("isProviderMcpConnected — agent reach", () => {
  test("true for a verified-active provider", () => {
    mockToolkitStatus = { gmail: "active" };
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(isProviderMcpConnected("google")).toBe(true);
    expect(isProviderMcpConnected("GOOGLE")).toBe(true); // case-insensitive
  });

  test("false once a backing toolkit is known-broken", () => {
    mockToolkitStatus = { gmail: "broken" };
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(isProviderMcpConnected("google")).toBe(false);
  });

  test("unknown status (cold cache) stays reachable — we won't claim nothing", () => {
    defaultStatus = "unknown";
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(isProviderMcpConnected("google")).toBe(true);
  });

  test("false for a provider with no enabled server at all", () => {
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(isProviderMcpConnected("slack")).toBe(false);
  });
});
