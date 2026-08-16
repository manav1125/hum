/**
 * The "applied N times" figure as the Memory surface receives it.
 *
 * The rule this file exists to hold: **omit rather than fake.** A memory with
 * no recorded applications must come back with `accessCount: null`, so the
 * client can render nothing at all. The counter only started when migration
 * 329 landed, so a `0` on the wire would read to a user as "this memory has
 * never been useful" when the truth is "we started counting yesterday". Those
 * two must not look alike, which is why the wire value is null rather than 0.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

let memSqlite: Database;

const realDbModule = await import("../../../memory/db-connection.js");
const schema = await import("../../../memory/schema.js");
mock.module("../../../memory/db-connection.js", () => ({
  ...realDbModule,
  getMemoryDb: () => drizzle(memSqlite, { schema }),
  getSqliteFrom: (db: unknown) =>
    db && (db as { $client?: unknown }).$client
      ? (db as { $client: Database }).$client
      : memSqlite,
}));

const { migrateMemoryNodeInjectionEvents } =
  await import("../../../memory/migrations/329-memory-node-injection-events.js");
const { recordNodeInjectionEvents } =
  await import("../../../memory/graph/node-injection-events.js");
const { ROUTES } = await import("../memory-item-routes.js");

function findHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

afterAll(() => {
  mock.restore();
});

const NODES_DDL = /*sql*/ `
  CREATE TABLE IF NOT EXISTS memory_graph_nodes (
    id                    TEXT PRIMARY KEY,
    content               TEXT NOT NULL,
    type                  TEXT NOT NULL,
    created               INTEGER NOT NULL,
    last_accessed         INTEGER NOT NULL,
    last_consolidated     INTEGER NOT NULL,
    emotional_charge      TEXT NOT NULL,
    fidelity              TEXT NOT NULL DEFAULT 'vivid',
    confidence            REAL NOT NULL,
    significance          REAL NOT NULL,
    stability             REAL NOT NULL DEFAULT 14,
    reinforcement_count   INTEGER NOT NULL DEFAULT 0,
    last_reinforced       INTEGER NOT NULL,
    source_conversations  TEXT NOT NULL DEFAULT '[]',
    source_type           TEXT NOT NULL DEFAULT 'inferred',
    narrative_role        TEXT,
    part_of_story         TEXT,
    scope_id              TEXT NOT NULL DEFAULT 'default',
    event_date            INTEGER,
    image_refs            TEXT
  )
`;

function insertNode(id: string, content: string): void {
  const now = Date.now();
  memSqlite
    .prepare(
      `INSERT INTO memory_graph_nodes
        (id, content, type, created, last_accessed, last_consolidated,
         emotional_charge, fidelity, confidence, significance, stability,
         reinforcement_count, last_reinforced, source_conversations,
         source_type, scope_id)
       VALUES (?, ?, 'semantic', ?, ?, ?, '{"valence":0,"arousal":0}', 'vivid', 0.9, 0.5, 14,
               0, ?, '[]', 'stated', 'default')`,
    )
    .run(id, content, now, now, now, now);
}

beforeEach(() => {
  memSqlite = new Database(":memory:");
  memSqlite.exec(NODES_DDL);
  migrateMemoryNodeInjectionEvents(
    drizzle(new Database(":memory:"), { schema }),
    memSqlite,
  );
});

type ItemsResult = { items: Array<Record<string, unknown>> };
type ItemResult = { item: Record<string, unknown> };

async function list(): Promise<Array<Record<string, unknown>>> {
  const handler = findHandler("listMemoryItems");
  const result = (await handler({ queryParams: {} })) as ItemsResult;
  return result.items;
}

describe("accessCount on the wire", () => {
  test("a memory with no recorded applications sends null, not 0", async () => {
    insertNode("node-untouched", "Manav: prefers async updates");

    const items = await list();
    const item = items.find((i) => i.id === "node-untouched");

    // null — so the surface omits the line entirely. A 0 here would be
    // rendered as a verdict on a memory we simply have no history for.
    expect(item?.accessCount).toBeNull();
  });

  test("a memory that was applied sends the count", async () => {
    insertNode("node-used", "Manav: ships from the voice-replatform line");
    recordNodeInjectionEvents(["node-used"], 1_000);
    recordNodeInjectionEvents(["node-used"], 2_000);
    recordNodeInjectionEvents(["node-used"], 3_000);

    const items = await list();
    const item = items.find((i) => i.id === "node-used");

    expect(item?.accessCount).toBe(3);
  });

  test("counts do not bleed between memories", async () => {
    insertNode("node-a", "Manav: A");
    insertNode("node-b", "Manav: B");
    recordNodeInjectionEvents(["node-a"], 1_000);

    const items = await list();
    expect(items.find((i) => i.id === "node-a")?.accessCount).toBe(1);
    expect(items.find((i) => i.id === "node-b")?.accessCount).toBeNull();
  });

  test("the single-item read carries the same count as the list", async () => {
    insertNode("node-single", "Manav: single");
    recordNodeInjectionEvents(["node-single"], 1_000);
    recordNodeInjectionEvents(["node-single"], 2_000);

    const handler = findHandler("getMemoryItem");
    const result = (await handler({
      pathParams: { id: "node-single" },
    })) as ItemResult;

    expect(result.item.accessCount).toBe(2);
  });

  test("an unreadable event log omits the metric rather than failing the list", async () => {
    insertNode("node-a", "Manav: A");
    recordNodeInjectionEvents(["node-a"], 1_000);
    // The count is a decoration on the memory; losing it must never take the
    // memory itself off the screen.
    memSqlite.exec(`DROP TABLE memory_node_injection_events`);

    const items = await list();
    expect(items.find((i) => i.id === "node-a")?.accessCount).toBeNull();
    expect(items.length).toBe(1);
  });
});
