/**
 * Proof that the "applied N times" counter actually fires on a real
 * injection, rather than only in a unit test of its own writer.
 *
 * These drive `ConversationGraphMemory.prepareMemory` — the same entry point
 * the agent loop calls — with the v1 graph retrieval returning real nodes,
 * and assert that a row landed in `memory_node_injection_events`.
 *
 * ## Read this before extending the file
 *
 * The graph-node injection path runs ONLY when `memory.v2.enabled` is false.
 * With v2 on (which is the shipped default), `loadContextMemory` and
 * `retrieveForTurn` short-circuit to zero nodes and the whole v1 branch is
 * unreachable — concept pages drive per-turn injection, graph nodes drive the
 * Memory page (see the comment in `memory/indexer.ts`). So these tests pin
 * `v2.enabled: false`. That is not a testing convenience; it is the honest
 * scope of the counter as wired today, and the "v2 on" test below pins the
 * consequence so nobody reads a permanently-absent line as a bug in the
 * writer.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { Message } from "../../../providers/types.js";

mock.module("../../../util/logger.js", () => createMockLoggerModule());

// ---------------------------------------------------------------------------
// Retrieval seam — the ONLY thing stubbed. Spread the real module so the
// other exports survive for any file that runs after this one.
// ---------------------------------------------------------------------------

type ScoredNodeLike = { node: { id: string }; score: number };
let contextLoadNodes: ScoredNodeLike[] = [];
let contextLoadSerendipity: ScoredNodeLike[] = [];
let perTurnNodes: ScoredNodeLike[] = [];

const realRetriever = await import("../retriever.js");
mock.module("../retriever.js", () => ({
  ...realRetriever,
  loadContextMemory: async () => ({
    nodes: contextLoadNodes,
    serendipityNodes: contextLoadSerendipity,
    triggeredNodes: [],
    latencyMs: 1,
    metrics: null,
    queryVector: undefined,
    sparseVector: undefined,
    userQueryVector: undefined,
    userQuerySparseVector: undefined,
  }),
  retrieveForTurn: async () => ({
    nodes: perTurnNodes,
    latencyMs: 1,
    metrics: null,
    queryVector: undefined,
    sparseVector: undefined,
  }),
}));

// The block assembler reads full node content off the scored nodes; the
// counter runs before assembly, so a null block must NOT suppress the count.
// Stubbing image resolution keeps the test off the filesystem.
const realInjection = await import("../injection.js");
mock.module("../injection.js", () => ({
  ...realInjection,
  resolveInjectionImages: async () => new Map(),
}));

// ---------------------------------------------------------------------------
// Memory DB seam
// ---------------------------------------------------------------------------

let memSqlite: Database;
const realDbModule = await import("../../db-connection.js");
const schema = await import("../../schema.js");
mock.module("../../db-connection.js", () => ({
  ...realDbModule,
  getMemoryDb: () => drizzle(memSqlite, { schema }),
  getSqliteFrom: (db: unknown) =>
    db && (db as { $client?: unknown }).$client
      ? (db as { $client: Database }).$client
      : memSqlite,
}));

const { migrateMemoryNodeInjectionEvents } =
  await import("../../migrations/329-memory-node-injection-events.js");
const { ConversationGraphMemory } =
  await import("../conversation-graph-memory.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  memSqlite = new Database(":memory:");
  migrateMemoryNodeInjectionEvents(
    drizzle(new Database(":memory:"), { schema }),
    memSqlite,
  );
  contextLoadNodes = [];
  contextLoadSerendipity = [];
  perTurnNodes = [];
});

function scored(id: string, content = `a remembered thing (${id})`) {
  return {
    node: {
      id,
      content,
      type: "semantic",
      created: Date.now(),
      significance: 0.5,
      imageRefs: [],
      eventDate: null,
    },
    score: 0.9,
  } as unknown as ScoredNodeLike;
}

function makeConfig(v2Enabled: boolean): AssistantConfig {
  return applyNestedDefaults({
    memory: { enabled: true, v2: { enabled: v2Enabled } },
  }) as AssistantConfig;
}

function messages(
  text = "what did we decide about the launch date?",
): Message[] {
  return [{ role: "user", content: [{ type: "text" as const, text }] }];
}

function recorded(): Array<{ node_id: string; n: number }> {
  return memSqlite
    .query(
      `SELECT node_id, COUNT(*) AS n FROM memory_node_injection_events GROUP BY node_id ORDER BY node_id`,
    )
    .all() as Array<{ node_id: string; n: number }>;
}

/** `initialized = true` routes prepareMemory down the per-turn branch. */
function perTurnMemory(id: string) {
  const m = new ConversationGraphMemory(id);
  (m as unknown as { initialized: boolean }).initialized = true;
  return m;
}

describe("the counter fires on a real injection", () => {
  test("per-turn injection records one event per node", async () => {
    perTurnNodes = [scored("node-a"), scored("node-b")];
    const m = perTurnMemory("conv-per-turn");

    await m.prepareMemory(
      messages(),
      makeConfig(false),
      new AbortController().signal,
      () => {},
    );

    expect(recorded()).toEqual([
      { node_id: "node-a", n: 1 },
      { node_id: "node-b", n: 1 },
    ]);
  });

  test("a second turn adds to the count rather than replacing it", async () => {
    const m = perTurnMemory("conv-two-turns");
    const cfg = makeConfig(false);

    perTurnNodes = [scored("node-a")];
    await m.prepareMemory(
      messages(),
      cfg,
      new AbortController().signal,
      () => {},
    );
    perTurnNodes = [scored("node-a"), scored("node-c")];
    await m.prepareMemory(
      messages("and the budget?"),
      cfg,
      new AbortController().signal,
      () => {},
    );

    expect(recorded()).toEqual([
      { node_id: "node-a", n: 2 },
      { node_id: "node-c", n: 1 },
    ]);
  });

  test("context-load counts serendipity nodes too — the model saw them", async () => {
    contextLoadNodes = [scored("node-a")];
    contextLoadSerendipity = [scored("node-serendipity")];
    const m = new ConversationGraphMemory("conv-context-load");

    await m.prepareMemory(
      messages(),
      makeConfig(false),
      new AbortController().signal,
      () => {},
    );

    expect(recorded().map((r) => r.node_id)).toEqual([
      "node-a",
      "node-serendipity",
    ]);
  });

  test("retrieving nothing records nothing", async () => {
    perTurnNodes = [];
    const m = perTurnMemory("conv-empty");

    await m.prepareMemory(
      messages(),
      makeConfig(false),
      new AbortController().signal,
      () => {},
    );

    expect(recorded()).toEqual([]);
  });
});

describe("re-registration after compaction is not an application", () => {
  test("retrackCachedNodes does not inflate the count", async () => {
    perTurnNodes = [scored("node-a")];
    const m = perTurnMemory("conv-compaction");
    await m.prepareMemory(
      messages(),
      makeConfig(false),
      new AbortController().signal,
      () => {},
    );

    // Compaction re-registers the same nodes with the tracker. The model was
    // already looking at them — counting this would make a long conversation
    // inflate the number without the memory having been used again.
    m.retrackCachedNodes();
    m.retrackCachedNodes();
    m.reinjectCachedMemory(messages());

    expect(recorded()).toEqual([{ node_id: "node-a", n: 1 }]);
  });
});

describe("the shipped default", () => {
  test("memory.v2 makes graph retrieval return nothing, so nothing is counted", async () => {
    // Pins the scope of the counter as wired today, against the REAL
    // retriever captured before the stub above — not against the stub, which
    // would prove nothing. With v2 on, `loadContextMemory` short-circuits to
    // zero nodes: v2 routes concept pages, graph nodes drive the Memory page
    // (see the comment in `memory/indexer.ts`). No nodes retrieved means no
    // events written, and an absent count renders as no line at all — never
    // as "applied 0 times".
    const result = await realRetriever.loadContextMemory({
      scopeId: "default",
      recentSummaries: ["we talked about the launch"],
      userQuery: "what did we decide?",
      config: makeConfig(true),
      signal: new AbortController().signal,
    });

    expect(result.nodes).toEqual([]);
    expect(result.serendipityNodes).toEqual([]);
    expect(recorded()).toEqual([]);
  });
});
