/**
 * Route tests for `GET /memory-graph` and `GET /memory/stats` against a
 * seeded temp workspace.
 *
 * The load-bearing assertions encode this fork's gate decision: the graph is
 * served off the memory v2 concept-page substrate (not a v3 tier), so with
 * memory v2 live the graph must report `supported: true` / `backend:
 * "memory-v2"` and stats must report `graph_supported: true` / `tier: "v2"` —
 * a v3-tier gate would ship the whole surface dead. The unsupported branch
 * (memory off) must stay a success-shaped 200 payload, never an error.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../config/types.js";

const realLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => makeMockLogger(),
}));

/** Swapped per-test to steer the memory gate. */
let memoryConfig: { enabled?: boolean; v2: { enabled: boolean } } = {
  enabled: true,
  v2: { enabled: true },
};

const realLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => ({ memory: memoryConfig }) as unknown as AssistantConfig,
}));

/** Per-test temp workspace, threaded through the platform seam. */
let workspaceDir = "";
const realPlatform = await import("../../util/platform.js");
mock.module("../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () => workspaceDir,
}));

const { ROUTES } = await import("./memory-graph-routes.js");
const { writePage } = await import("../../memory/v2/page-store.js");
const { invalidatePageIndex } = await import("../../memory/v2/page-index.js");
const { invalidateEdgeIndex } = await import("../../memory/v2/edge-index.js");

const graphRoute = ROUTES.find((r) => r.endpoint === "memory-graph")!;
const nodeRoute = ROUTES.find((r) => r.endpoint === "memory-graph-node")!;
const statsRoute = ROUTES.find((r) => r.endpoint === "memory/stats")!;

interface GraphResponse {
  backend: string | null;
  supported: boolean;
  nodes: Array<{ id: string; label: string; kind?: string; summary?: string }>;
  edges: Array<{ source: string; target: string; kind?: string }>;
}

interface StatsResponse {
  concepts: number;
  graph_supported: boolean;
  tier: string;
}

async function seedPage(
  slug: string,
  body: string,
  frontmatter: { summary?: string } = {},
): Promise<void> {
  await writePage(workspaceDir, {
    slug,
    frontmatter: {
      edges: [],
      ref_files: [],
      ref_urls: [],
      ...frontmatter,
    },
    body,
  });
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memory-graph-routes-"));
  memoryConfig = { enabled: true, v2: { enabled: true } };
  invalidatePageIndex();
  invalidateEdgeIndex();
});

afterEach(() => {
  invalidatePageIndex();
  invalidateEdgeIndex();
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("GET /memory-graph", () => {
  test("returns a supported memory-v2 graph with concept nodes and link edges", async () => {
    await seedPage("people/alice", "Works with [[projects/apollo]] daily.", {
      summary: "Alice, a colleague",
    });
    await seedPage("projects/apollo", "The apollo project.");

    const res = (await graphRoute.handler({})) as GraphResponse;

    expect(res.supported).toBe(true);
    expect(res.backend).toBe("memory-v2");
    const ids = res.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["people/alice", "projects/apollo"]);
    const alice = res.nodes.find((n) => n.id === "people/alice")!;
    expect(alice.kind).toBe("concept");
    expect(alice.label).toBe("Alice");
    expect(alice.summary).toBe("Alice, a colleague");
    // The wikilink produced a directed static edge.
    expect(res.edges).toContainEqual(
      expect.objectContaining({
        source: "people/alice",
        target: "projects/apollo",
        kind: "link",
      }),
    );
  });

  test("renders pending buffer entries as pending nodes edged to hinted pages", async () => {
    await seedPage("people/alice", "A colleague.");
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(
      join(workspaceDir, "memory", "buffer.md"),
      "- [Jul 20, 3:15 PM] Follow up with [[people/alice]] about the offsite\n",
    );

    const res = (await graphRoute.handler({})) as GraphResponse;

    const pending = res.nodes.find((n) => n.kind === "pending");
    expect(pending).toBeDefined();
    expect(pending!.id.startsWith("buffer:")).toBe(true);
    expect(res.edges).toContainEqual(
      expect.objectContaining({
        source: pending!.id,
        target: "people/alice",
        kind: "pending",
      }),
    );

    // The node detail endpoint resolves the pending id back to its fact.
    const detail = (await nodeRoute.handler({
      queryParams: { id: pending!.id },
    })) as { found: boolean; title?: string; content?: string };
    expect(detail.found).toBe(true);
    expect(detail.title).toBe("Pending memory");
    expect(detail.content).toContain("Follow up with");
  });

  test("memory off → success-shaped unsupported payload, not an error", async () => {
    memoryConfig = { enabled: false, v2: { enabled: true } };
    const res = (await graphRoute.handler({})) as GraphResponse;
    expect(res).toEqual({
      backend: null,
      supported: false,
      nodes: [],
      edges: [],
    });
  });

  test("v2 disabled (legacy v1 engine) → unsupported", async () => {
    memoryConfig = { enabled: true, v2: { enabled: false } };
    const res = (await graphRoute.handler({})) as GraphResponse;
    expect(res.supported).toBe(false);
  });
});

describe("GET /memory/stats", () => {
  test("counts concept pages and reports tier v2 with graph_supported true", async () => {
    await seedPage("people/alice", "A colleague.");
    await seedPage("projects/apollo", "The apollo project.");

    const res = (await statsRoute.handler({})) as StatsResponse;

    expect(res.concepts).toBe(2);
    expect(res.graph_supported).toBe(true);
    expect(res.tier).toBe("v2");
  });

  test("memory off → tier off, graph unsupported, zero count", async () => {
    memoryConfig = { enabled: false, v2: { enabled: true } };
    const res = (await statsRoute.handler({})) as StatsResponse;
    expect(res).toEqual({ concepts: 0, graph_supported: false, tier: "off" });
  });

  test("v2 disabled → tier v1, graph unsupported", async () => {
    memoryConfig = { enabled: true, v2: { enabled: false } };
    const res = (await statsRoute.handler({})) as StatsResponse;
    expect(res).toEqual({ concepts: 0, graph_supported: false, tier: "v1" });
  });

  test("an empty (but enabled) corpus is a real zero, still supported", async () => {
    const res = (await statsRoute.handler({})) as StatsResponse;
    expect(res.concepts).toBe(0);
    expect(res.graph_supported).toBe(true);
    expect(res.tier).toBe("v2");
  });
});
