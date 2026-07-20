/**
 * Per-turn wire tool-set pruning.
 *
 * The dominant share of every mainAgent prompt is tool JSON schemas — on a
 * connector-heavy instance the ~70 MCP (Composio) schemas alone are several
 * hundred KB per LLM call. This module withholds connector-origin (MCP) tool
 * schemas from the wire unless the conversation has already discovered or
 * used them, cutting prompt tokens (and prefill latency) by an order of
 * magnitude on typical turns.
 *
 * Contract:
 *  - Pruning affects ONLY the tool definitions sent to the provider. The
 *    executor allowlist (`allowedToolNames`) is computed from the unpruned
 *    set, so a gated tool invoked by name still executes.
 *  - Core (non-MCP) tools are never pruned.
 *  - MCP meta/discovery tools (Composio's `COMPOSIO_*` toolkit) are never
 *    pruned — they are the server-side discovery path.
 *  - A gated tool becomes wire-visible for the rest of the conversation once
 *    it is (a) named by a `<loaded_tool …/>` marker in a `tool_search`
 *    result, or (b) called (its name appears in a `tool_use` block in
 *    history). Both are derived from conversation history, so activation
 *    survives daemon restarts; an in-memory sticky set additionally keeps
 *    activations alive across compaction.
 *  - Config: `llm.toolPruning.enabled` (default true — set false for an
 *    instant rollback) and `llm.toolPruning.keepTools` (always-on-the-wire
 *    names; exact, or prefix when the entry ends with `*`).
 */

import type { Message, ToolDefinition } from "../providers/types.js";
import { getMcpToolDefinitions, getToolOwner } from "./registry.js";

/** Name of the discovery meta-tool that activates gated tools on demand. */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Tools whose results may carry `<loaded_tool …/>` activation markers.
 * `skill_search` is included because it is the model's first discovery
 * instinct — it appends matching gated connector tools (with markers) to its
 * results so either search path activates them.
 */
const MARKER_SOURCE_TOOL_NAMES = new Set([
  TOOL_SEARCH_TOOL_NAME,
  "skill_search",
]);

/**
 * Marker emitted in `tool_search` results for each activated tool. Mirrors
 * the `<loaded_skill …/>` marker contract used by the skill projection: the
 * marker rides conversation history, so activation is derived from the same
 * durable source on every turn (including after restart).
 */
export const LOADED_TOOL_MARKER_RE = /<loaded_tool\s+id="([^"]+)"\s*\/>/g;

/** Render the activation marker for one tool name. */
export function loadedToolMarker(name: string): string {
  return `<loaded_tool id="${name}" />`;
}

/**
 * Whether a keep-list entry matches a tool name. Entries are exact names,
 * or prefixes when the entry ends with `*`.
 */
function matchesKeepEntry(name: string, entry: string): boolean {
  if (entry.endsWith("*")) return name.startsWith(entry.slice(0, -1));
  return name === entry;
}

/**
 * Whether an MCP tool is a server-provided discovery/meta tool that must
 * stay on the wire. MCP tool names are `mcp__<serverId>__<toolName>`;
 * Composio's meta toolkit (COMPOSIO_SEARCH_TOOLS, COMPOSIO_GET_TOOL_SCHEMAS,
 * COMPOSIO_EXECUTE_TOOL, COMPOSIO_MANAGE_CONNECTIONS, …) uses a `COMPOSIO_`
 * bare-name prefix, unlike the per-connector action tools (`GMAIL_*`,
 * `GITHUB_*`, …).
 */
export function isMcpMetaToolName(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const bare = sep >= 0 ? rest.slice(sep + 2) : rest;
  return bare.startsWith("COMPOSIO_");
}

/**
 * Whether a tool is eligible for pruning: MCP-origin, not a meta/discovery
 * tool, and not on the configured keep list. Ownership is read from the
 * registry (the single source of truth) rather than inferred from the name
 * prefix alone.
 */
export function isPrunableWireTool(
  name: string,
  keepTools: readonly string[],
): boolean {
  if (getToolOwner(name)?.kind !== "mcp") return false;
  if (isMcpMetaToolName(name)) return false;
  if (keepTools.some((entry) => matchesKeepEntry(name, entry))) return false;
  return true;
}

/**
 * All currently registered MCP tools that wire pruning would gate — the
 * discovery candidate pool shared by `tool_search` and `skill_search`.
 * Already-activated tools are included (re-finding one is harmless and
 * re-emits its marker).
 */
export function collectGatedConnectorToolDefs(
  keepTools: readonly string[],
): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const def of getMcpToolDefinitions()) {
    const name = def.name;
    if (!name || !isPrunableWireTool(name, keepTools)) continue;
    out.push({ name, description: def.description ?? "" });
  }
  return out;
}

/**
 * Bare (un-namespaced) MCP tool name — `mcp__composio__GMAIL_SEND_EMAIL` →
 * `GMAIL_SEND_EMAIL`. Display/ranking helper; activation markers and calls
 * always use the full namespaced name.
 */
export function bareMcpToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep >= 0 ? rest.slice(sep + 2) : rest;
}

/**
 * Conversation-scoped incremental cache for the history scan, mirroring the
 * skill projection's cache shape: history is append-only within a
 * conversation, so when the message count grew and the first message is
 * unchanged only the delta is scanned. Compaction (first-message identity
 * change or shrink) triggers a full rescan.
 */
export interface ToolPruningScanCache {
  messageCount: number;
  firstMessage: Message | undefined;
  names: Set<string>;
}

/** Collect activated tool names from a slice of history into `out`. */
function scanMessagesForLoadedTools(
  messages: readonly Message[],
  markerSourceUseIds: Set<string>,
  out: Set<string>,
): void {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        // Any tool the conversation already called stays wire-visible.
        out.add(block.name);
        if (MARKER_SOURCE_TOOL_NAMES.has(block.name)) {
          markerSourceUseIds.add(block.id);
        }
      } else if (block.type === "tool_result") {
        // Markers are only honored from discovery-tool results so arbitrary
        // tool output or user text cannot force-activate tools (mirrors the
        // skill_load-only rule for <loaded_skill> markers).
        if (!markerSourceUseIds.has(block.tool_use_id)) continue;
        if (!block.content) continue;
        for (const match of block.content.matchAll(LOADED_TOOL_MARKER_RE)) {
          out.add(match[1]);
        }
      }
    }
  }
}

/**
 * Derive the set of tool names activated by this conversation's history:
 * every `tool_use` name plus every `<loaded_tool …/>` marker inside a
 * `tool_search` result. When `cache` is provided, unchanged history returns
 * the cached set and appended history is scanned incrementally.
 */
export function deriveConversationLoadedTools(
  history: readonly Message[],
  cache?: ToolPruningScanCache,
): Set<string> {
  const fullScan = (): Set<string> => {
    const names = new Set<string>();
    const useIds = new Set<string>();
    // Two passes so a marker in a result that precedes its tool_use ordering
    // edge case never matters: collect discovery-tool use ids first.
    for (const msg of history) {
      for (const block of msg.content) {
        if (
          block.type === "tool_use" &&
          MARKER_SOURCE_TOOL_NAMES.has(block.name)
        ) {
          useIds.add(block.id);
        }
      }
    }
    scanMessagesForLoadedTools(history, useIds, names);
    return names;
  };

  if (!cache) return fullScan();

  if (
    cache.firstMessage === history[0] &&
    cache.messageCount === history.length
  ) {
    return cache.names;
  }

  if (
    cache.firstMessage === history[0] &&
    cache.messageCount < history.length
  ) {
    // Incremental: re-derive discovery-tool use ids over the full history (a
    // delta's tool_result may reference a tool_use from an earlier round),
    // then scan only the delta for additions.
    const useIds = new Set<string>();
    for (const msg of history) {
      for (const block of msg.content) {
        if (
          block.type === "tool_use" &&
          MARKER_SOURCE_TOOL_NAMES.has(block.name)
        ) {
          useIds.add(block.id);
        }
      }
    }
    scanMessagesForLoadedTools(
      history.slice(cache.messageCount),
      useIds,
      cache.names,
    );
    cache.messageCount = history.length;
    return cache.names;
  }

  // History shrank or was rewritten (compaction) — full rescan.
  const names = fullScan();
  cache.messageCount = history.length;
  cache.firstMessage = history[0];
  cache.names = names;
  return names;
}

export interface PruneWireToolDefsOptions {
  /** `llm.toolPruning.enabled` — false returns the defs unchanged (minus tool_search). */
  enabled: boolean;
  /** `llm.toolPruning.keepTools`. */
  keepTools: readonly string[];
  /** Conversation history for activation derivation. */
  history: readonly Message[];
  /** Optional incremental scan cache (conversation-scoped). */
  scanCache?: ToolPruningScanCache;
  /**
   * Conversation-scoped sticky activation set. Unioned with the history
   * scan and updated in place, so activations survive compaction (which
   * rewrites history and would otherwise drop them) for the conversation's
   * in-memory lifetime.
   */
  stickyLoadedToolNames?: Set<string>;
}

export interface PruneWireToolDefsResult {
  defs: ToolDefinition[];
  /** Number of definitions withheld from the wire this round. */
  prunedCount: number;
  /** Number of definitions that were pruning-eligible before activation. */
  gatedCandidateCount: number;
}

/**
 * Apply wire pruning to a resolved tool-definition list.
 *
 * With pruning disabled, behavior is byte-identical to the pre-pruning
 * daemon: every def is sent and the `tool_search` meta-tool is withheld
 * (it has nothing to discover). With pruning enabled, prunable defs that
 * the conversation has not activated are withheld; `tool_search` itself is
 * withheld when there are no gated candidates at all (nothing to find).
 */
export function pruneWireToolDefs(
  defs: ToolDefinition[],
  options: PruneWireToolDefsOptions,
): PruneWireToolDefsResult {
  const dropToolSearch = (list: ToolDefinition[]): ToolDefinition[] =>
    list.filter((d) => d.name !== TOOL_SEARCH_TOOL_NAME);

  if (!options.enabled) {
    return {
      defs: dropToolSearch(defs),
      prunedCount: 0,
      gatedCandidateCount: 0,
    };
  }

  const gatedCandidateCount = defs.filter(
    (d) =>
      d.name !== undefined && isPrunableWireTool(d.name, options.keepTools),
  ).length;
  if (gatedCandidateCount === 0) {
    // No connector tail on this instance — pruning is a no-op and the
    // discovery tool would be dead weight.
    return { defs: dropToolSearch(defs), prunedCount: 0, gatedCandidateCount };
  }

  const loaded = deriveConversationLoadedTools(
    options.history,
    options.scanCache,
  );
  const sticky = options.stickyLoadedToolNames;
  if (sticky) {
    for (const name of loaded) sticky.add(name);
  }
  const active = sticky ?? loaded;

  const kept = defs.filter((d) => {
    const name = d.name;
    if (name === undefined) return true;
    if (!isPrunableWireTool(name, options.keepTools)) return true;
    return active.has(name);
  });

  return {
    defs: kept,
    prunedCount: defs.length - kept.length,
    gatedCandidateCount,
  };
}
