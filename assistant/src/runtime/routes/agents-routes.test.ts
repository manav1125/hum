/**
 * Round-trip tests for the agent-registry routes: list (with the seeded
 * defaults), hire, get, patch (rename/re-charter/tier/cap/pause), retire,
 * NotFound on a missing id, BadRequest on an empty name, and the per-agent
 * spend route (real attribution from usage → run conversation → assignee).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { ROUTES } from "./agents-routes.js";
import { BadRequestError, NotFoundError } from "./errors.js";

initializeDb();

function reseedDefaults() {
  const now = Date.now();
  const insert = getSqliteFrom(getDb()).prepare(
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

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

describe("agent CRUD routes", () => {
  test("GET agents lists the seeded defaults, name-ordered", () => {
    const result = route("agents", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { agents: Array<{ name: string; tier: string }> };
    expect(result.agents.map((a) => a.name)).toEqual([
      "Builder",
      "Growth",
      "Ops",
    ]);
  });

  test("POST agents hires a role (201) and it persists", () => {
    const create = route("agents", "POST");
    expect(create.responseStatus).toBe("201");
    const { agent } = create.handler({
      body: { name: "Finance", emoji: "$", tier: "3" },
      headers: {},
    }) as { agent: { id: string; name: string; tier: string } };
    expect(agent.name).toBe("Finance");
    expect(agent.tier).toBe("3");

    const got = route("agents/:id", "GET").handler({
      pathParams: { id: agent.id },
      headers: {},
    }) as { agent: { name: string } };
    expect(got.agent.name).toBe("Finance");
  });

  test("POST agents rejects an empty name", () => {
    expect(() =>
      route("agents", "POST").handler({ body: { name: "  " }, headers: {} }),
    ).toThrow(BadRequestError);
  });

  test("PATCH agents/:id renames, re-charters, changes tier + cap + pause", () => {
    const { agent } = route("agents/:id", "PATCH").handler({
      pathParams: { id: "builder" },
      body: {
        name: "Product",
        charter: "Ship weekly",
        tier: "3",
        capCents: 5000,
        paused: true,
      },
      headers: {},
    }) as {
      agent: {
        name: string;
        charter: string;
        tier: string;
        capCents: number;
        paused: number;
      };
    };
    expect(agent.name).toBe("Product");
    expect(agent.charter).toBe("Ship weekly");
    expect(agent.tier).toBe("3");
    expect(agent.capCents).toBe(5000);
    expect(agent.paused).toBe(1);
  });

  test("PATCH agents/:id sets, normalizes, and clears tool scopes", () => {
    const patch = route("agents/:id", "PATCH");

    // Set — normalized (trim/lowercase) and deduped.
    const { agent } = patch.handler({
      pathParams: { id: "ops" },
      body: { toolScopes: ["  Email ", "calendar", "email", ""] },
      headers: {},
    }) as { agent: { toolScopes: string[] | null } };
    expect(agent.toolScopes).toEqual(["email", "calendar"]);

    // Exposed on reads (flows into GET guardrails via the agents spread).
    const got = route("agents/:id", "GET").handler({
      pathParams: { id: "ops" },
      headers: {},
    }) as { agent: { toolScopes: string[] | null } };
    expect(got.agent.toolScopes).toEqual(["email", "calendar"]);

    // Omitting the field leaves scopes untouched.
    const untouched = patch.handler({
      pathParams: { id: "ops" },
      body: { tier: "2" },
      headers: {},
    }) as { agent: { toolScopes: string[] | null } };
    expect(untouched.agent.toolScopes).toEqual(["email", "calendar"]);

    // Null clears the restriction.
    const cleared = patch.handler({
      pathParams: { id: "ops" },
      body: { toolScopes: null },
      headers: {},
    }) as { agent: { toolScopes: string[] | null } };
    expect(cleared.agent.toolScopes).toBeNull();
  });

  test("PATCH agents/:id rejects malformed tool scopes", () => {
    const patch = route("agents/:id", "PATCH");
    expect(() =>
      patch.handler({
        pathParams: { id: "ops" },
        body: { toolScopes: "email" },
        headers: {},
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      patch.handler({
        pathParams: { id: "ops" },
        body: { toolScopes: [42] },
        headers: {},
      }),
    ).toThrow(BadRequestError);
  });

  test("POST agents accepts tool scopes at hire", () => {
    const { agent } = route("agents", "POST").handler({
      body: { name: "Scout", toolScopes: ["Research"] },
      headers: {},
    }) as { agent: { toolScopes: string[] | null } };
    expect(agent.toolScopes).toEqual(["research"]);
  });

  test("PATCH agents/:id rejects an empty name", () => {
    expect(() =>
      route("agents/:id", "PATCH").handler({
        pathParams: { id: "ops" },
        body: { name: "  " },
        headers: {},
      }),
    ).toThrow(BadRequestError);
  });

  test("PATCH / GET / DELETE on a missing id throws NotFound", () => {
    for (const [endpoint, method, args] of [
      ["agents/:id", "GET", {}],
      ["agents/:id", "PATCH", { body: { name: "X" } }],
      ["agents/:id", "DELETE", {}],
    ] as const) {
      expect(() =>
        route(endpoint, method).handler({
          pathParams: { id: "nope" },
          headers: {},
          ...args,
        }),
      ).toThrow(NotFoundError);
    }
  });

  test("DELETE agents/:id retires the role", () => {
    const result = route("agents/:id", "DELETE").handler({
      pathParams: { id: "growth" },
      headers: {},
    }) as { id: string; success: boolean };
    expect(result.success).toBe(true);
    const list = route("agents", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { agents: Array<{ name: string }> };
    expect(list.agents.map((a) => a.name)).toEqual(["Builder", "Ops"]);
  });
});

describe("GET agents/spend", () => {
  function seedUsage(conversationId: string, costUsd: number) {
    getSqliteFrom(getDb())
      .prepare(
        `INSERT INTO llm_usage_events
          (id, created_at, conversation_id, actor, provider, model,
           input_tokens, output_tokens, estimated_cost_usd, pricing_status)
         VALUES (?, ?, ?, 'main_agent', 'anthropic', 'claude', 10, 5, ?, 'priced')`,
      )
      .run(
        `u-${Math.random().toString(36).slice(2)}`,
        Date.now() - 1000,
        conversationId,
        costUsd,
      );
  }

  function seedRun(assignee: string | undefined, conversationId: string) {
    const task = createTask({ title: "T", template: "Do it" });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Run",
      ...(assignee ? { assignee } : {}),
    });
    updateWorkItem(wi.id, { lastRunConversationId: conversationId });
  }

  test("returns real per-agent attributed spend in cents", () => {
    seedRun("Builder", "conv-b");
    seedRun(undefined, "conv-cue");
    seedUsage("conv-b", 1.2); // 120 cents
    seedUsage("conv-cue", 0.05); //   5 cents

    const result = route("agents/spend", "GET").handler({
      queryParams: { days: "7" },
      headers: {},
    }) as {
      byAgent: Array<{ agent: string; spentCents: number; runs: number }>;
      attributedCents: number;
    };
    const byName = new Map(result.byAgent.map((r) => [r.agent, r]));
    expect(byName.get("Builder")?.spentCents).toBe(120);
    expect(byName.get("cue")?.spentCents).toBe(5);
    expect(result.attributedCents).toBe(125);
  });

  test("empty ledger returns an honest zero (no fabricated split)", () => {
    const result = route("agents/spend", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { byAgent: unknown[]; attributedCents: number };
    expect(result.byAgent).toHaveLength(0);
    expect(result.attributedCents).toBe(0);
  });
});
