import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mock config loader — drives listMcpConnectedProviders ────────────
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

const {
  mcpServerKeyToProvider,
  listMcpConnectedProviders,
  isProviderMcpConnected,
} = await import("./mcp-connectors.js");

afterEach(() => {
  mockMcpServers = {};
});

describe("mcpServerKeyToProvider", () => {
  test("maps composio toolkit servers to canonical providers", () => {
    expect(mcpServerKeyToProvider("composio_gmail")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googlecalendar")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googledrive")).toBe("google");
    expect(mcpServerKeyToProvider("composio_googlesheets")).toBe("google");
    expect(mcpServerKeyToProvider("composio_slack")).toBe("slack");
    expect(mcpServerKeyToProvider("composio_github")).toBe("github");
    expect(mcpServerKeyToProvider("composio_linear")).toBe("linear");
    expect(mcpServerKeyToProvider("composio_airtable")).toBe("airtable");
    expect(mcpServerKeyToProvider("composio_hubspot")).toBe("hubspot");
    expect(mcpServerKeyToProvider("composio_notion")).toBe("notion");
  });

  test("the bare composio workbench backs no single account", () => {
    // It's a meta-connector (the remote tool workbench), not a linked account.
    expect(mcpServerKeyToProvider("composio")).toBeNull();
  });

  test("an unknown composio toolkit surfaces as its slug (never dropped)", () => {
    expect(mcpServerKeyToProvider("composio_stripe")).toBe("stripe");
  });

  test("a non-composio generic tool server is not a linked account", () => {
    expect(mcpServerKeyToProvider("filesystem")).toBeNull();
    expect(mcpServerKeyToProvider("")).toBeNull();
  });

  test("a non-composio server naming a known provider counts", () => {
    expect(mcpServerKeyToProvider("linear")).toBe("linear");
  });
});

describe("listMcpConnectedProviders", () => {
  test("reconciles the 11 prod servers into deduped providers", () => {
    // The real prod shape: 10 composio_* toolkits + the bare composio
    // workbench, all enabled. The 4 Google surfaces collapse to one "google".
    mockMcpServers = {
      composio_gmail: { enabled: true },
      composio_googlecalendar: { enabled: true },
      composio_googledrive: { enabled: true },
      composio_googlesheets: { enabled: true },
      composio_slack: { enabled: true },
      composio_github: { enabled: true },
      composio_linear: { enabled: true },
      composio_airtable: { enabled: true },
      composio_hubspot: { enabled: true },
      composio_notion: { enabled: true },
      composio: { enabled: true },
    };
    expect([...listMcpConnectedProviders()].sort()).toEqual([
      "airtable",
      "github",
      "google",
      "hubspot",
      "linear",
      "notion",
      "slack",
    ]);
  });

  test("an explicitly disabled server is excluded; missing enabled is on", () => {
    mockMcpServers = {
      composio_gmail: { enabled: false },
      composio_slack: {}, // enabled defaults to true
    };
    expect([...listMcpConnectedProviders()]).toEqual(["slack"]);
  });

  test("no MCP config degrades to an empty set (never throws)", () => {
    mockMcpServers = undefined;
    expect(listMcpConnectedProviders().size).toBe(0);
  });
});

describe("isProviderMcpConnected", () => {
  test("true for an MCP-covered provider, false for an absent one", () => {
    mockMcpServers = { composio_gmail: { enabled: true } };
    expect(isProviderMcpConnected("google")).toBe(true);
    expect(isProviderMcpConnected("GOOGLE")).toBe(true); // case-insensitive
    expect(isProviderMcpConnected("slack")).toBe(false);
  });
});
