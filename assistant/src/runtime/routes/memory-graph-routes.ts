/**
 * Backend-agnostic memory-graph topology routes.
 *
 * `GET /memory-graph` returns the assistant's memory as a canonical
 * {@link MemoryGraph} (nodes + edges), independent of which memory backend is
 * active. Today it is served from memory v2 (+ the v3-shadow edge layer); when
 * memory is fully pluginified the handler resolves the active backend instead
 * — the endpoint, its shape, and every client that consumes it stay put.
 * Backends without a graph return `{ supported: false }` (HTTP 200), which
 * clients render as a dedicated empty state rather than an error.
 *
 * Also here: `GET /memory/stats` (the cheap concept count + capability bit
 * that lets glanceable surfaces gate the graph entry point without building
 * the graph) and `POST /memory/remember` (append a user-authored fact to the
 * memory buffer; it surfaces immediately as a `pending` graph node).
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { handleRemember } from "../../memory/graph/tool-handlers.js";
import {
  getMemoryGraph,
  getMemoryGraphNode,
  isGraphSupported,
} from "../../memory/graph-topology/build-memory-graph.js";
import {
  findPendingEntryForContent,
  readPendingBufferEntries,
} from "../../memory/graph-topology/pending-buffer.js";
import {
  MemoryGraphNodeDetailSchema,
  MemoryGraphSchema,
} from "../../memory/graph-topology/types.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS,
} from "../../memory/jobs-store.js";
import { getPageIndex } from "../../memory/v2/page-index.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-graph-routes");

const READ_POLICY: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

/**
 * Coarse memory tier for `GET /memory/stats`. This fork has no live v3 tier —
 * the concept graph is built off the v2 substrate — so the buckets are:
 * `off` (the user's Memory opt-out), `v1` (legacy PKB engine), `v2` (the
 * concept-page engine the graph reads). `graph_supported` is exactly
 * `tier === "v2"` here.
 */
function memoryTier(): "off" | "v1" | "v2" {
  const config = getConfig();
  if (config.memory.enabled === false) {
    return "off";
  }
  return config.memory.v2.enabled ? "v2" : "v1";
}

/**
 * Nudge a consolidation run after a create so the just-buffered fact files
 * into concept pages promptly. Coalesced: an already-queued/running job is
 * reused rather than piling up queue depth (mirrors `runConsolidationNow`).
 */
function maybeEnqueueConsolidationForCreate(): void {
  try {
    if (hasActiveJobOfType("memory_v2_consolidate")) {
      return;
    }
    enqueueMemoryJob("memory_v2_consolidate", {
      trigger: MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS.manual,
    });
  } catch (err) {
    // The create already succeeded; the interval scheduler will pick the
    // entry up on its next pass, so a failed nudge is log-only.
    log.warn({ err }, "Failed to enqueue consolidation after memory create");
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getMemoryGraph",
    endpoint: "memory-graph",
    method: "GET",
    policy: READ_POLICY,
    summary: "Get the memory graph",
    description:
      "Return the assistant's memory as a backend-agnostic graph of nodes " +
      "(concepts, skills, capabilities) and edges (authored links and learned " +
      "associations). Returns supported=false when the active backend exposes " +
      "no graph.",
    tags: ["memory"],
    responseBody: MemoryGraphSchema,
    handler: () => getMemoryGraph(getConfig()),
  },
  {
    operationId: "getMemoryGraphNode",
    endpoint: "memory-graph-node",
    method: "GET",
    policy: READ_POLICY,
    summary: "Get a memory graph node's content",
    description:
      "Return the rendered markdown content of a single concept node by id, " +
      "for the graph's node-detail view. `found: false` when the node has no " +
      "readable page.",
    tags: ["memory"],
    queryParams: [
      {
        name: "id",
        schema: { type: "string" },
        description: "Node id from the graph payload (the concept-page slug).",
      },
    ],
    responseBody: MemoryGraphNodeDetailSchema,
    handler: ({ queryParams }) =>
      getMemoryGraphNode(getConfig(), queryParams?.id ?? ""),
  },
  {
    operationId: "getMemoryStats",
    endpoint: "memory/stats",
    method: "GET",
    policy: READ_POLICY,
    summary: "Get lightweight memory stats",
    description:
      "Return a cheap count of concept pages from the cached memory page " +
      "index, for glanceable surfaces like the identity Memory card. Counts " +
      "concept pages only and never builds the memory-concept graph. Also " +
      "reports graph_supported: whether the memory-concept graph is available " +
      "for this assistant (memory enabled and the v2 concept-page engine " +
      "live), so callers can gate the graph entry point without building the " +
      "graph, plus tier: the coarse memory tier explaining why the graph is " +
      "unavailable (off = the user's Memory opt-out, v1 = the legacy PKB " +
      "engine).",
    tags: ["memory"],
    responseBody: z.object({
      concepts: z.number().describe("Number of concept pages in memory"),
      graph_supported: z
        .boolean()
        .describe(
          "Whether the memory-concept graph is available (memory enabled and the v2 concept-page engine live)",
        ),
      tier: z
        .enum(["off", "v1", "v2", "v3"])
        .describe(
          "Coarse memory tier for this assistant; graph_supported is exactly tier === 'v2' in this fork",
        ),
    }),
    handler: async () => {
      const config = getConfig();
      const tier = memoryTier();
      if (!isGraphSupported(config)) {
        return { concepts: 0, graph_supported: false, tier };
      }
      const pageIndex = await getPageIndex(getWorkspaceDir());
      const concepts = pageIndex.entries.filter((e) => e.modifiedAt > 0).length;
      return { concepts, graph_supported: true, tier };
    },
  },
  {
    operationId: "createMemory",
    endpoint: "memory/remember",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a memory by remembering a fact",
    description:
      "Append a user-authored fact to the memory buffer via handleRemember. " +
      "The fact surfaces in the memory graph immediately as a pending node " +
      "(its id is returned so clients can navigate to it), and a " +
      "consolidation run is nudged (coalesced against active jobs) so it " +
      "files into concept pages promptly.",
    tags: ["memory"],
    requestBody: z.object({ content: z.string() }),
    responseBody: z.object({
      message: z.string(),
      success: z.boolean(),
      pendingNodeId: z
        .string()
        .optional()
        .describe(
          "Graph node id (`buffer:<hash>`) of the pending entry this create appended, for fly-to-node navigation. Absent when the buffer can't be re-read.",
        ),
    }),
    handler: async ({ body }) => {
      const parsed = z.object({ content: z.string() }).safeParse(body ?? {});
      if (!parsed.success) {
        throw new BadRequestError("content (string) is required");
      }
      if (parsed.data.content.trim().length === 0) {
        throw new BadRequestError("content (non-empty string) is required");
      }
      const config = getConfig();
      // No single source conversation for a create from the Memory surface —
      // an empty conversation id writes the entry without an origin marker.
      const result = handleRemember(
        { content: parsed.data.content },
        "",
        "",
        config,
      );
      if (!result.success) {
        return result;
      }
      maybeEnqueueConsolidationForCreate();

      // Resolve the pending graph-node id of the entry just appended so the
      // client can fly the map to it. Matched by this request's content
      // (normalized through the same buffer parse) rather than the buffer
      // tail, so a concurrently interleaved remember from another writer is
      // never reported as this one's entry. Best-effort — the create already
      // succeeded, so a read failure returns no id rather than an error.
      let pendingNodeId: string | undefined;
      try {
        const entries = await readPendingBufferEntries(getWorkspaceDir());
        pendingNodeId = findPendingEntryForContent(
          entries,
          parsed.data.content,
        )?.id;
      } catch (err) {
        log.warn({ err }, "Failed to resolve pending node id after create");
      }
      return pendingNodeId ? { ...result, pendingNodeId } : result;
    },
  },
];
