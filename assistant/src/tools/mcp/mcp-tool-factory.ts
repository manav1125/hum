import type { McpServerConfig } from "../../config/schemas/mcp.js";
import type { McpServerManager } from "../../mcp/manager.js";
import { RiskLevel } from "../../permissions/types.js";
import { toProviderSafeToolName } from "../provider-tool-name.js";
import { schemaDefinesProperty } from "../schema-transforms.js";
import { boundOutput } from "../shared/output-spill.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { recordComposioToolOutcome } from "./composio-tool-health.js";

const riskMap: Record<string, RiskLevel> = {
  low: RiskLevel.Low,
  medium: RiskLevel.Medium,
  high: RiskLevel.High,
};

/**
 * Create a namespaced tool name to prevent collisions across MCP servers
 * and with core/skill tools.
 */
function mcpToolName(serverId: string, toolName: string): string {
  return toProviderSafeToolName(`mcp__${serverId}__${toolName}`);
}

export interface McpToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP ToolAnnotations, self-reported by the server (hints, not truth). */
  annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
}

/**
 * Resolve the risk level a tool carries.
 *
 * `readOnlyHint` is self-reported by the server, so it only refines risk
 * DOWNWARD and only for servers the user already configured below the
 * high-trust ceiling. Servers left at the default "high" are unaffected,
 * and the hint never raises risk above the server default. (Port of
 * upstream f19059f77d.)
 */
function resolveRiskLevel(
  metadata: McpToolMetadata,
  serverConfig: McpServerConfig,
): RiskLevel {
  const serverRisk = riskMap[serverConfig.defaultRiskLevel] ?? RiskLevel.High;
  if (
    metadata.annotations?.readOnlyHint === true &&
    serverRisk !== RiskLevel.High
  ) {
    return RiskLevel.Low;
  }
  return serverRisk;
}

/**
 * Create a Tool object from MCP tool metadata.
 * The tool delegates execution to the McpServerManager.
 */
/**
 * Character bound on one MCP tool result before it is spilled to a file.
 *
 * Deliberately larger than the 20k shell bound: an MCP result is usually the
 * answer itself (a page, a record set) rather than a command's chatter, so
 * cutting it early costs more than it saves. It is still a bound — the point
 * is that there was none.
 */
const MAX_MCP_RESULT_CHARS = 60_000;

export function createMcpTool(
  metadata: McpToolMetadata,
  serverId: string,
  serverConfig: McpServerConfig,
  manager: McpServerManager,
): Tool {
  const namespacedName = mcpToolName(serverId, metadata.name);
  const riskLevel = resolveRiskLevel(metadata, serverConfig);
  const serverDefinesActivity = schemaDefinesProperty(
    metadata.inputSchema,
    "activity",
    { refBehavior: "assume-defined" },
  );

  return {
    name: namespacedName,
    description: metadata.description,
    category: "mcp",
    defaultRiskLevel: riskLevel,
    executionTarget: "host",

    input_schema: metadata.inputSchema as object,

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      try {
        // Strip injected activity before sending to MCP server
        const { activity: _activity, ...mcpInput } = input as Record<
          string,
          unknown
        > & {
          activity?: unknown;
        };
        const forwardInput = serverDefinesActivity ? input : mcpInput;
        const result = await manager.callTool(
          serverId,
          metadata.name,
          forwardInput,
          context.signal,
        );
        // Passive connector-health signal: a REAL tool execution is the best
        // evidence there is about a connection. An auth-shaped failure here
        // must immediately downgrade a stored "ok" (never throws, see module).
        recordComposioToolOutcome({
          serverId,
          input: forwardInput,
          content: result.content,
          isError: result.isError,
        });
        // An MCP server's result reached the model unbounded: one large
        // payload could spend the entire context window with nothing able to
        // stop it, and these are third-party servers whose response size we do
        // not control. Bound it and spill the rest so nothing is lost.
        const bounded = boundOutput(
          result.content,
          MAX_MCP_RESULT_CHARS,
          `mcp-${serverId}-${metadata.name}`,
        );
        return {
          content: bounded.content,
          isError: result.isError,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordComposioToolOutcome({
          serverId,
          input,
          content: message,
          isError: true,
        });
        return {
          content: `MCP tool execution failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Create Tool objects from all tools provided by an MCP server.
 */
export function createMcpToolsFromServer(
  tools: McpToolMetadata[],
  serverId: string,
  serverConfig: McpServerConfig,
  manager: McpServerManager,
): Tool[] {
  return tools.map((tool) =>
    createMcpTool(tool, serverId, serverConfig, manager),
  );
}
