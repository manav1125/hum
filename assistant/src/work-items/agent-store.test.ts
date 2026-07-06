/**
 * Tests for the agent registry store: the migration + default seed (and its
 * idempotency), CRUD (hire / rename / re-charter / tier / cap / pause / retire),
 * and REAL per-agent spend attribution (usage → run conversation → assignee).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  countAgents,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentSpend,
  listAgents,
  updateAgent,
} from "./agent-store.js";
import { createWorkItem, updateWorkItem } from "./work-item-store.js";

initializeDb();

/** Re-seed the three defaults into an emptied table, mirroring the migration. */
function reseedDefaults(): void {
  const now = Date.now();
  const raw = getSqliteFrom(getDb());
  const insert = raw.prepare(
    `INSERT INTO agents (id, name, emoji, domain, charter, tier, cap_cents, paused, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  );
  insert.run("ops", "Ops", "⚙", "Operations", "Keep it moving", "3", now, now);
  insert.run("builder", "Builder", "▲", "Product", "Ship it", "2", now, now);
  insert.run("growth", "Growth", "✦", "Marketing", "Grow it", "2", now, now);
}

beforeEach(() => {
  getDb().run("DELETE FROM llm_usage_events");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM agents");
  reseedDefaults();
});

describe("migration + seed", () => {
  test("creates the agents table with its name index", () => {
    const raw = getSqliteFrom(getDb());
    const table = (
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(table).toEqual(["agents"]);

    const indexes = (
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("agents_name_idx");
  });

  test("the three default roles are present (Ops/Builder/Growth)", () => {
    const names = listAgents().map((a) => a.name);
    expect(names).toEqual(["Builder", "Growth", "Ops"]); // name-ordered
    const ops = getAgent("ops");
    expect(ops?.tier).toBe("3");
    expect(ops?.capCents).toBeNull();
    expect(ops?.paused).toBe(0);
  });

  test("the seed is idempotent — re-running does not duplicate defaults", () => {
    expect(countAgents()).toBe(3);
    // The migration is registered in the boot sequence; invoking initializeDb
    // again must not re-seed on a non-empty table.
    initializeDb();
    expect(countAgents()).toBe(3);
  });

  test("the seed does not resurrect a retired default", () => {
    deleteAgent("growth");
    expect(countAgents()).toBe(2);
    // A subsequent init sees a non-empty table and leaves it untouched.
    initializeDb();
    expect(getAgent("growth")).toBeUndefined();
    expect(countAgents()).toBe(2);
  });
});

describe("CRUD", () => {
  test("hire adds a role with defaults", () => {
    const finance = createAgent({
      name: "Finance",
      emoji: "$",
      domain: "Runway",
    });
    expect(finance.name).toBe("Finance");
    expect(finance.tier).toBe("1");
    expect(finance.capCents).toBeNull();
    expect(finance.paused).toBe(0);
    expect(getAgent(finance.id)?.name).toBe("Finance");
    expect(countAgents()).toBe(4);
  });

  test("rename / re-charter / change tier / set cap / pause persist", () => {
    const updated = updateAgent("builder", {
      name: "Product",
      charter: "Ship weekly",
      tier: "3",
      capCents: 5000,
      paused: 1,
    });
    expect(updated?.name).toBe("Product");
    expect(updated?.charter).toBe("Ship weekly");
    expect(updated?.tier).toBe("3");
    expect(updated?.capCents).toBe(5000);
    expect(updated?.paused).toBe(1);
    // Re-read confirms persistence, and updatedAt advanced.
    const reread = getAgent("builder");
    expect(reread?.name).toBe("Product");
    expect(reread?.updatedAt).toBeGreaterThanOrEqual(reread!.createdAt);
  });

  test("partial update leaves unset fields untouched", () => {
    const before = getAgent("ops")!;
    updateAgent("ops", { paused: 1 });
    const after = getAgent("ops")!;
    expect(after.paused).toBe(1);
    expect(after.name).toBe(before.name);
    expect(after.charter).toBe(before.charter);
    expect(after.tier).toBe(before.tier);
  });

  test("clearing the cap sets it back to null", () => {
    updateAgent("ops", { capCents: 9000 });
    expect(getAgent("ops")?.capCents).toBe(9000);
    updateAgent("ops", { capCents: null });
    expect(getAgent("ops")?.capCents).toBeNull();
  });

  test("retire removes the role", () => {
    deleteAgent("ops");
    expect(getAgent("ops")).toBeUndefined();
    expect(listAgents().map((a) => a.name)).toEqual(["Builder", "Growth"]);
  });

  test("tool scopes round-trip as a string array (JSON in tool_scopes)", () => {
    // Seeded rows have no scopes — unrestricted.
    expect(getAgent("ops")?.toolScopes).toBeNull();

    const updated = updateAgent("ops", {
      toolScopes: ["email", "calendar", "research", "files"],
    });
    expect(updated?.toolScopes).toEqual([
      "email",
      "calendar",
      "research",
      "files",
    ]);
    // Persisted as a JSON string in the column…
    const raw = getSqliteFrom(getDb())
      .query(`SELECT tool_scopes FROM agents WHERE id = 'ops'`)
      .get() as { tool_scopes: string | null };
    expect(JSON.parse(raw.tool_scopes!)).toEqual([
      "email",
      "calendar",
      "research",
      "files",
    ]);
    // …and parsed back on every read path.
    expect(getAgent("ops")?.toolScopes).toEqual([
      "email",
      "calendar",
      "research",
      "files",
    ]);
    expect(listAgents().find((a) => a.id === "ops")?.toolScopes).toEqual([
      "email",
      "calendar",
      "research",
      "files",
    ]);
  });

  test("clearing tool scopes sets back to null (unrestricted)", () => {
    updateAgent("ops", { toolScopes: ["email"] });
    expect(getAgent("ops")?.toolScopes).toEqual(["email"]);
    updateAgent("ops", { toolScopes: null });
    expect(getAgent("ops")?.toolScopes).toBeNull();
  });

  test("hire with tool scopes persists them; empty array is a valid restriction", () => {
    const scoped = createAgent({ name: "Scout", toolScopes: ["research"] });
    expect(getAgent(scoped.id)?.toolScopes).toEqual(["research"]);

    const lockdown = createAgent({ name: "Lockdown", toolScopes: [] });
    expect(getAgent(lockdown.id)?.toolScopes).toEqual([]);
  });

  test("malformed tool_scopes content reads as null (unrestricted, never throws)", () => {
    getSqliteFrom(getDb())
      .prepare(`UPDATE agents SET tool_scopes = 'not-json' WHERE id = 'ops'`)
      .run();
    expect(getAgent("ops")?.toolScopes).toBeNull();
  });
});

describe("spend attribution", () => {
  /** Insert a priced usage row on a conversation at a given time. */
  function seedUsage(
    conversationId: string,
    costUsd: number,
    createdAt: number,
  ): void {
    getSqliteFrom(getDb())
      .prepare(
        `INSERT INTO llm_usage_events
          (id, created_at, conversation_id, actor, provider, model,
           input_tokens, output_tokens, estimated_cost_usd, pricing_status)
         VALUES (?, ?, ?, 'main_agent', 'anthropic', 'claude', 100, 50, ?, 'priced')`,
      )
      .run(
        `u-${Math.random().toString(36).slice(2)}`,
        createdAt,
        conversationId,
        costUsd,
      );
  }

  /** A work item bound to a run conversation, assigned to `assignee`. */
  function seedRun(assignee: string | undefined, conversationId: string): void {
    const task = createTask({ title: "T", template: "Do it" });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Run",
      ...(assignee ? { assignee } : {}),
    });
    updateWorkItem(wi.id, { lastRunConversationId: conversationId });
  }

  test("attributes real per-agent spend from run conversations", () => {
    const now = Date.now();
    seedRun("Builder", "conv-b");
    seedRun("growth", "conv-g");
    seedUsage("conv-b", 1.25, now - 1000); // $1.25 → 125 cents
    seedUsage("conv-b", 0.5, now - 2000); //  $0.50 →  50 cents (same run)
    seedUsage("conv-g", 0.1, now - 3000); //  $0.10 →  10 cents

    const spend = getAgentSpend({ days: 7 });
    const byName = new Map(spend.byAgent.map((r) => [r.agent, r]));
    expect(byName.get("Builder")?.spentCents).toBe(175);
    expect(byName.get("Builder")?.runs).toBe(1);
    expect(byName.get("growth")?.spentCents).toBe(10);
    expect(spend.attributedCents).toBe(185);
  });

  test("null assignee attributes to 'cue', the house agent", () => {
    const now = Date.now();
    seedRun(undefined, "conv-x");
    seedUsage("conv-x", 0.3, now - 1000);
    const spend = getAgentSpend();
    const cue = spend.byAgent.find((r) => r.agent === "cue");
    expect(cue?.spentCents).toBe(30);
  });

  test("usage outside the window is excluded", () => {
    const now = Date.now();
    seedRun("Builder", "conv-b");
    seedUsage("conv-b", 5, now - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    const spend = getAgentSpend({ days: 7 });
    expect(spend.byAgent.find((r) => r.agent === "Builder")).toBeUndefined();
    expect(spend.attributedCents).toBe(0);
  });

  test("usage on non-run conversations is not attributed", () => {
    const now = Date.now();
    // A conversation that is NOT any work item's run conversation (owner chat).
    seedUsage("conv-chat", 9.99, now - 1000);
    const spend = getAgentSpend();
    expect(spend.attributedCents).toBe(0);
  });
});
