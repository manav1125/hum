/**
 * MCP `readOnlyHint` risk refinement (port of upstream f19059f77d).
 *
 * The hint is self-reported by the server, so it may only refine risk
 * DOWNWARD, and only for servers the user already trusts below the "high"
 * ceiling. Everything else keeps the server's configured default.
 */
import { describe, expect, test } from "bun:test";

import type { McpServerConfig } from "../config/schemas/mcp.js";
import type { McpServerManager } from "../mcp/manager.js";
import { RiskLevel } from "../permissions/types.js";
import { createMcpTool } from "../tools/mcp/mcp-tool-factory.js";

function serverConfig(defaultRiskLevel: "low" | "medium" | "high") {
  return {
    transport: { type: "stdio", command: "echo", args: [] },
    enabled: true,
    defaultRiskLevel,
    maxTools: 100,
  } as unknown as McpServerConfig;
}

const manager = {} as McpServerManager;

function toolWith(
  annotations: Record<string, unknown> | undefined,
  risk: "low" | "medium" | "high",
) {
  return createMcpTool(
    {
      name: "list_things",
      description: "Lists things",
      inputSchema: { type: "object", properties: {} },
      ...(annotations ? { annotations } : {}),
    },
    "srv",
    serverConfig(risk),
    manager,
  );
}

describe("MCP readOnlyHint risk refinement", () => {
  test("readOnlyHint lowers risk on a medium-trust server", () => {
    expect(toolWith({ readOnlyHint: true }, "medium").defaultRiskLevel).toBe(
      RiskLevel.Low,
    );
  });

  test("readOnlyHint never lowers a high-trust-ceiling server", () => {
    expect(toolWith({ readOnlyHint: true }, "high").defaultRiskLevel).toBe(
      RiskLevel.High,
    );
  });

  test("no annotations keeps the server default", () => {
    expect(toolWith(undefined, "medium").defaultRiskLevel).toBe(
      RiskLevel.Medium,
    );
  });

  test("readOnlyHint false keeps the server default", () => {
    expect(toolWith({ readOnlyHint: false }, "medium").defaultRiskLevel).toBe(
      RiskLevel.Medium,
    );
  });
});
