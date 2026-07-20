/**
 * Tests for per-turn wire tool pruning (`llm.toolPruning`) applied inside
 * `createResolveToolsCallback`, plus the underlying helpers in
 * `tools/tool-pruning.ts` and the `tool_search` discovery tool.
 *
 * Invariants under test:
 *  - Pruning removes non-activated MCP tool defs from the WIRE list only —
 *    `allowedToolNames` (the execution gate) still contains them.
 *  - Core tools and MCP meta tools (`COMPOSIO_*`-named) are never pruned.
 *  - `keepTools` entries (exact and `*`-suffix prefix) stay on the wire.
 *  - Activation is durable per conversation: a `<loaded_tool …/>` marker in
 *    a `tool_search` result, or a direct `tool_use` of the tool, keeps its
 *    schema on the wire on later rounds/turns.
 *  - Markers outside `tool_search` results are ignored.
 *  - `enabled: false` restores the pre-pruning wire set exactly (including
 *    withholding `tool_search` itself).
 *  - Subagent wire-allowlist runs and guardrails tool-scope runs skip
 *    pruning entirely.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { Message, ToolDefinition } from "../../providers/types.js";
import {
  __clearRegistryForTesting,
  registerMcpTools,
} from "../../tools/registry.js";
import {
  deriveConversationLoadedTools,
  isMcpMetaToolName,
  pruneWireToolDefs,
  TOOL_SEARCH_TOOL_NAME,
  type ToolPruningScanCache,
} from "../../tools/tool-pruning.js";
import { toolSearchTool } from "../../tools/tool-search.js";
import type { Tool } from "../../tools/types.js";
import { createResolveToolsCallback } from "../conversation-tool-setup.js";

type SkillProjectionContext =
  import("../conversation-tool-setup.js").SkillProjectionContext;
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

const GMAIL = "mcp__composio__GMAIL_SEND_EMAIL";
const GCAL = "mcp__composio__GOOGLECALENDAR_CREATE_EVENT";
const META = "mcp__composio__COMPOSIO_SEARCH_TOOLS";

function def(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: "object" } };
}

function mcpTool(name: string, description = name): Tool {
  return {
    name,
    description,
    input_schema: { type: "object" },
  } as unknown as Tool;
}

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set<string>(),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

function withPruningConfig(
  enabled: boolean,
  keepTools: string[] = [],
  exclude: string[] = [],
) {
  const stub: Partial<AssistantConfig> = {
    tools: { exclude },
    llm: { toolPruning: { enabled, keepTools } } as AssistantConfig["llm"],
  };
  return spyOn(configLoader, "getConfig").mockReturnValue(
    stub as AssistantConfig,
  );
}

function registerComposioTools(): void {
  registerMcpTools("composio", [
    mcpTool(GMAIL, "Send an email via Gmail"),
    mcpTool(GCAL, "Create a Google Calendar event"),
    mcpTool(META, "Search Composio tools"),
  ]);
}

/** History with a tool_search round whose result carries markers. */
function historyWithMarker(
  markerToolName: string,
  viaTool = TOOL_SEARCH_TOOL_NAME,
): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "send the email" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: viaTool, input: { query: "x" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: `Found 1 tool.\n1. ${markerToolName}\n   <loaded_tool id="${markerToolName}" />`,
        },
      ],
    },
  ];
}

let getConfigSpy: ReturnType<typeof withPruningConfig> | undefined;

beforeEach(() => {
  __clearRegistryForTesting();
});

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
  __clearRegistryForTesting();
});

// ---------------------------------------------------------------------------
// Helper-level tests
// ---------------------------------------------------------------------------

describe("isMcpMetaToolName", () => {
  test("recognizes Composio meta toolkit names", () => {
    expect(isMcpMetaToolName(META)).toBe(true);
    expect(isMcpMetaToolName("mcp__composio__COMPOSIO_EXECUTE_TOOL")).toBe(
      true,
    );
  });
  test("connector action tools and core tools are not meta", () => {
    expect(isMcpMetaToolName(GMAIL)).toBe(false);
    expect(isMcpMetaToolName("bash")).toBe(false);
  });
});

describe("deriveConversationLoadedTools", () => {
  test("collects tool_use names and tool_search markers", () => {
    const history = historyWithMarker(GMAIL);
    const loaded = deriveConversationLoadedTools(history);
    expect(loaded.has(GMAIL)).toBe(true);
    expect(loaded.has(TOOL_SEARCH_TOOL_NAME)).toBe(true);
  });

  test("honors markers from skill_search results (unified discovery)", () => {
    const history = historyWithMarker(GMAIL, "skill_search");
    const loaded = deriveConversationLoadedTools(history);
    expect(loaded.has(GMAIL)).toBe(true);
  });

  test("ignores markers in non-discovery results and in user text", () => {
    const history: Message[] = [
      ...historyWithMarker(GMAIL, "web_search"),
      {
        role: "user",
        content: [{ type: "text", text: `<loaded_tool id="${GCAL}" />` }],
      },
    ];
    const loaded = deriveConversationLoadedTools(history);
    expect(loaded.has(GMAIL)).toBe(false);
    expect(loaded.has(GCAL)).toBe(false);
  });

  test("incremental cache picks up appended rounds and survives rewrites", () => {
    const cache: ToolPruningScanCache = {
      messageCount: 0,
      firstMessage: undefined,
      names: new Set(),
    };
    const history = historyWithMarker(GMAIL);
    expect(deriveConversationLoadedTools(history, cache).has(GMAIL)).toBe(true);

    // Append a direct tool_use round — incremental scan must find it.
    history.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_2", name: GCAL, input: {} }],
    });
    const grown = deriveConversationLoadedTools(history, cache);
    expect(grown.has(GCAL)).toBe(true);

    // Compaction-style rewrite: new first message, shorter history.
    const rewritten: Message[] = [
      { role: "user", content: [{ type: "text", text: "summary" }] },
    ];
    const rescanned = deriveConversationLoadedTools(rewritten, cache);
    expect(rescanned.size).toBe(0);
  });
});

describe("pruneWireToolDefs", () => {
  test("disabled: returns defs unchanged minus tool_search", () => {
    registerComposioTools();
    const defs = [def("bash"), def(GMAIL), def(TOOL_SEARCH_TOOL_NAME)];
    const result = pruneWireToolDefs(defs, {
      enabled: false,
      keepTools: [],
      history: [],
    });
    expect(result.defs.map((d) => d.name)).toEqual(["bash", GMAIL]);
    expect(result.prunedCount).toBe(0);
  });

  test("sticky set keeps activations alive after history rewrite", () => {
    registerComposioTools();
    const sticky = new Set<string>();
    const defs = [def(GMAIL), def(GCAL)];
    const withHistory = pruneWireToolDefs(defs, {
      enabled: true,
      keepTools: [],
      history: historyWithMarker(GMAIL),
      stickyLoadedToolNames: sticky,
    });
    expect(withHistory.defs.map((d) => d.name)).toEqual([GMAIL]);

    // History compacted away — the sticky set still keeps GMAIL visible.
    const afterCompaction = pruneWireToolDefs(defs, {
      enabled: true,
      keepTools: [],
      history: [],
      stickyLoadedToolNames: sticky,
    });
    expect(afterCompaction.defs.map((d) => d.name)).toEqual([GMAIL]);
  });
});

// ---------------------------------------------------------------------------
// createResolveToolsCallback integration
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — wire tool pruning", () => {
  test("prunes non-activated MCP defs from the wire but not from allowedToolNames", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [
        def("bash"),
        def(TOOL_SEARCH_TOOL_NAME),
        def(GMAIL),
        def(GCAL),
        def(META),
      ],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);

    // Core + meta + discovery stay; connector actions are pruned.
    expect(wire).toContain("bash");
    expect(wire).toContain(META);
    expect(wire).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(wire).not.toContain(GMAIL);
    expect(wire).not.toContain(GCAL);

    // Execution gate still allows the pruned tools.
    expect(ctx.allowedToolNames?.has(GMAIL)).toBe(true);
    expect(ctx.allowedToolNames?.has(GCAL)).toBe(true);
    // Durable inventory keeps them too.
    expect(ctx.lastResolvedToolNames?.has(GMAIL)).toBe(true);
  });

  test("a tool_search marker activates the tool for subsequent rounds", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    const wire = resolver!(historyWithMarker(GMAIL)).map((d) => d.name);
    expect(wire).toContain(GMAIL);
    expect(wire).not.toContain(GCAL);
  });

  test("a directly-used tool stays on the wire", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME), def(GMAIL)],
      ctx,
    );
    const history: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_9", name: GMAIL, input: {} }],
      },
    ];
    expect(resolver!(history).map((d) => d.name)).toContain(GMAIL);
  });

  test("keepTools exact and wildcard entries stay on the wire", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true, [GCAL, "mcp__composio__GMAIL_*"]);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);
    expect(wire).toContain(GMAIL);
    expect(wire).toContain(GCAL);
  });

  test("disabled flag restores the full wire set without tool_search", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(false);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);
    expect(wire).toContain(GMAIL);
    expect(wire).toContain(GCAL);
    expect(wire).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  test("tool_search is withheld when no gated candidates exist", () => {
    // No MCP tools registered at all — nothing to discover.
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME)],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);
    expect(wire).toContain("bash");
    expect(wire).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  test("subagent wire allowlist skips pruning", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx({
      subagentAllowedTools: new Set(["bash", GMAIL]),
    });
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);
    expect(wire).toContain(GMAIL); // granted by the parent, not pruned
    expect(wire).not.toContain(GCAL); // outside the allowlist
  });

  test("guardrails tool-scope filter skips pruning", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx({
      toolScopeFilter: (name) => name !== GCAL,
    });
    const resolver = createResolveToolsCallback(
      [def("bash"), def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    const wire = resolver!([]).map((d) => d.name);
    expect(wire).toContain(GMAIL); // in scope — stays despite no activation
    expect(wire).not.toContain(GCAL); // dropped by the scope filter itself
  });

  test("sticky context set keeps an activation across a compaction rewrite", () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const ctx = makeCtx({
      toolPruningScanCache: {
        messageCount: 0,
        firstMessage: undefined,
        names: new Set<string>(),
      },
      wireLoadedToolNames: new Set<string>(),
    });
    const resolver = createResolveToolsCallback(
      [def(TOOL_SEARCH_TOOL_NAME), def(GMAIL), def(GCAL)],
      ctx,
    );
    expect(resolver!(historyWithMarker(GMAIL)).map((d) => d.name)).toContain(
      GMAIL,
    );
    // Post-compaction: history no longer carries the marker.
    const compacted: Message[] = [
      { role: "user", content: [{ type: "text", text: "summary" }] },
    ];
    expect(resolver!(compacted).map((d) => d.name)).toContain(GMAIL);
  });
});

// ---------------------------------------------------------------------------
// tool_search execute
// ---------------------------------------------------------------------------

describe("tool_search tool", () => {
  test("returns ranked matches with activation markers", async () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const result = await toolSearchTool.execute!({ query: "gmail send email" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(GMAIL);
    expect(result.content).toContain(`<loaded_tool id="${GMAIL}" />`);
    // The meta tool is not a gated candidate and must not be offered.
    expect(result.content).not.toContain(META);
  });

  test("no matches yields a helpful non-error message", async () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const result = await toolSearchTool.execute!({
      query: "quantum flux capacitor",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No connector tools matched");
  });

  test("no connector tools installed yields a non-error message", async () => {
    getConfigSpy = withPruningConfig(true);
    const result = await toolSearchTool.execute!({ query: "gmail" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No connector tools are installed");
  });

  test("missing query is an error", async () => {
    const result = await toolSearchTool.execute!({});
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skill_search connector section
// ---------------------------------------------------------------------------

describe("skill_search connector-tool section", () => {
  test("appends matching gated connector tools with markers when pruning is on", async () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(true);
    const { skillSearchTool } = await import("../../tools/skills/search.js");
    const result = await skillSearchTool.execute!({
      query: "gmail send email",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(GMAIL);
    expect(result.content).toContain(`<loaded_tool id="${GMAIL}" />`);
  });

  test("no connector section when pruning is off", async () => {
    registerComposioTools();
    getConfigSpy = withPruningConfig(false);
    const { skillSearchTool } = await import("../../tools/skills/search.js");
    const result = await skillSearchTool.execute!({
      query: "gmail send email",
    });
    expect(result.content ?? "").not.toContain("<loaded_tool");
  });
});
