/**
 * tool_search — model-facing discovery for wire-pruned connector tools.
 *
 * When per-turn tool pruning is enabled (`llm.toolPruning.enabled`), the
 * schemas of MCP/connector tools (Gmail, Calendar, Drive, Notion, Slack,
 * Linear, GitHub, … via Composio or any configured MCP server) are withheld
 * from LLM requests until the conversation needs them. This tool is the
 * discovery path: keyword search over the gated tail; every returned match
 * carries a `<loaded_tool …/>` marker that activates the tool for the rest
 * of the conversation (its full schema is on the wire from the next step).
 *
 * Ranking reuses the deterministic token-overlap scorer from `skill_search`
 * — no embeddings, no LLM calls, no network.
 */

import { getConfig } from "../config/loader.js";
import { RiskLevel } from "../permissions/types.js";
import { getLogger } from "../util/logger.js";
import { registerTool } from "./registry.js";
import {
  rankSkillSearchCandidates,
  type SkillSearchCandidate,
} from "./skills/search.js";
import {
  bareMcpToolName,
  collectGatedConnectorToolDefs,
  loadedToolMarker,
  TOOL_SEARCH_TOOL_NAME,
} from "./tool-pruning.js";
import type { ToolDefinition, ToolExecutionResult } from "./types.js";

const log = getLogger("tool-search");

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

/** First line of a description, truncated for the result listing. */
function oneLine(text: string, maxLength = 200): string {
  const line = text.split("\n")[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export const toolSearchTool = {
  name: TOOL_SEARCH_TOOL_NAME,

  description:
    'Search the assistant\'s installed connector/integration tools (Gmail, Google Calendar, Drive, Sheets, Notion, Slack, Linear, GitHub, Airtable, HubSpot, and any other connected service) that are hidden from your visible toolset to keep requests small. Matching tools are ACTIVATED for this conversation — their full schemas become available on your next step and you can then call them directly by name. Use this whenever the user asks for an action on a connected external service and no matching tool is visible: search here BEFORE claiming the capability is unavailable or falling back to a manual approach. Query with a few descriptive words naming the service and the action (e.g. "gmail send email", "calendar create event", "notion create page").',

  category: "skills",

  executionTarget: "sandbox",

  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Keywords naming the service and action you need (e.g. "gmail send email", "linear create issue").',
      },
      limit: {
        type: "number",
        description: `Maximum number of tools to return and activate (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ["query"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = input.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return {
        content: "Error: query is required and must be a non-empty string",
        isError: true,
      };
    }

    let limit = DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const raw = Number(input.limit);
      if (!Number.isFinite(raw) || raw < 1) {
        return {
          content: `Error: limit must be a number between 1 and ${MAX_LIMIT}`,
          isError: true,
        };
      }
      limit = Math.min(Math.floor(raw), MAX_LIMIT);
    }

    let keepTools: readonly string[] = [];
    try {
      keepTools = getConfig().llm.toolPruning.keepTools;
    } catch {
      // Config not loaded (test contexts) — treat the keep list as empty.
    }

    // Candidates: every currently registered MCP tool that pruning would
    // gate. Already-activated tools are included too — re-finding a tool is
    // harmless and re-emits its marker.
    const candidates: SkillSearchCandidate[] = [];
    const descriptionByName = new Map<string, string>();
    for (const { name, description } of collectGatedConnectorToolDefs(
      keepTools,
    )) {
      descriptionByName.set(name, description);
      candidates.push({
        id: name,
        name: bareMcpToolName(name),
        displayName: bareMcpToolName(name).replaceAll("_", " "),
        description,
        availability: "installed",
      });
    }

    if (candidates.length === 0) {
      return {
        content:
          "No connector tools are installed on this instance. For other capabilities, use skill_search.",
        isError: false,
      };
    }

    const ranked = rankSkillSearchCandidates(candidates, query, limit);
    if (ranked.length === 0) {
      return {
        content:
          `No connector tools matched "${query.trim()}" across ${candidates.length} installed connector tools. ` +
          'Try different keywords naming the service (e.g. "gmail", "calendar", "notion") and the action. ' +
          "For non-connector capabilities, use skill_search instead.",
        isError: false,
      };
    }

    log.debug(
      { query: query.trim(), matched: ranked.map((r) => r.candidate.id) },
      "tool_search activated connector tools",
    );

    const lines: string[] = [
      `Found ${ranked.length} connector tool${ranked.length === 1 ? "" : "s"} matching "${query.trim()}". They are now ACTIVE for this conversation — full schemas are available from your next step; call them directly by name. Prefer calling a matching connector tool over loading setup skills or debugging OAuth: the connector executes against the account connected to this assistant and will report its own error if the service is not connected.`,
      "",
    ];
    ranked.forEach((result, index) => {
      const name = result.candidate.id;
      lines.push(`${index + 1}. ${name}`);
      const description = descriptionByName.get(name) ?? "";
      if (description) lines.push(`   ${oneLine(description)}`);
      lines.push(`   ${loadedToolMarker(name)}`);
    });

    return { content: lines.join("\n"), isError: false };
  },
} satisfies ToolDefinition;
registerTool(toolSearchTool);
