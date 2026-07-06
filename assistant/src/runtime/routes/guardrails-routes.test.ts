/**
 * Round-trip tests for the Guardrails routes: the composed GET payload
 * (checkpoints with honest enforced flags, agents with real attributed spend
 * + model pin, ledger with acts/usage rollup, per-mission $, and named held
 * approvals) and checkpoint CRUD.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateCheckpointCache } from "../../guardrails/checkpoint-store.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createMission } from "../../missions/mission-store.js";
import { createTask } from "../../tasks/task-store.js";
import { recordAgentAct } from "../../work-items/agent-act-store.js";
import { createProject } from "../../work-items/project-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import {
  clear as clearPendingInteractions,
  register as registerPendingInteraction,
} from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { ROUTES } from "./guardrails-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM guardrail_checkpoints");
  getDb().run("DELETE FROM llm_usage_events");
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM agents");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM missions");
  invalidateCheckpointCache();
  clearPendingInteractions();
});

afterEach(() => {
  clearPendingInteractions();
});

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

function seedAgent(id: string, name: string, model: string | null): void {
  const now = Date.now();
  getSqliteFrom(getDb())
    .prepare(
      `INSERT INTO agents (id, name, tier, cap_cents, paused, model, created_at, updated_at)
       VALUES (?, ?, '2', 2000, 0, ?, ?, ?)`,
    )
    .run(id, name, model, now, now);
}

function seedUsage(conversationId: string, model: string, usd: number): void {
  const now = Date.now();
  getSqliteFrom(getDb())
    .prepare(
      `INSERT INTO llm_usage_events
        (id, created_at, conversation_id, actor, provider, model,
         input_tokens, output_tokens, estimated_cost_usd, pricing_status)
       VALUES (?, ?, ?, 'main_agent', 'openrouter', ?, 100, 50, ?, 'priced')`,
    )
    .run(
      `u-${Math.random().toString(36).slice(2)}`,
      now,
      conversationId,
      model,
      usd,
    );
}

describe("route registration", () => {
  test("all endpoints are scope-less (no assistants/:id prefix)", () => {
    for (const r of ROUTES) {
      expect(r.endpoint.startsWith("guardrails")).toBe(true);
      expect(r.endpoint).not.toContain("assistants");
    }
  });
});

describe("GET guardrails (composed read)", () => {
  test("composes checkpoints + agents-with-spend + ledger in one payload", () => {
    // Checkpoint (enforced) via the POST route.
    route("guardrails/checkpoints", "POST").handler({
      body: { template: "send_message", label: "Sending anything" },
      headers: {},
    });

    // Agent with a model pin + a work-item run with real usage attributed.
    seedAgent("growth", "Growth", "anthropic/claude-haiku-4.5");
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "campaign" });
    updateWorkItem(item.id, {
      assignee: "Growth",
      lastRunConversationId: "conv-run-1",
    });
    seedUsage("conv-run-1", "anthropic/claude-haiku-4.5", 0.5); // 50¢ attributed
    seedUsage("conv-chat", "anthropic/claude-sonnet-4.5", 1.0); // chat usage (rollup only)

    // One act in the ledger.
    recordAgentAct({
      kind: "run_completed",
      agent: "Growth",
      workItemId: item.id,
      estMinutesSaved: 10,
    });

    const result = route("guardrails", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      checkpoints: Array<{
        template: string;
        enforced: boolean;
        enforcedVia: string | null;
      }>;
      agents: Array<{
        name: string;
        model: string | null;
        spend: { spentCents: number; capCents: number | null; runs: number };
      }>;
      ledger: {
        recentActs: Array<{ agent: string; kind: string }>;
        summary: {
          actCount: number;
          reversedCount: number;
          heldCount: number;
          estMinutesSaved: number;
          totalCents: number;
          byModel: Array<{ model: string; costCents: number; share: number }>;
        };
      };
      window: { days: number; from: number; to: number };
    };

    // Checkpoints carry the honest enforcement flag.
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0].enforced).toBe(true);
    expect(result.checkpoints[0].enforcedVia).toContain("'send'");

    // Agent carries its pin + REAL attributed spend vs its cap.
    expect(result.agents).toHaveLength(1);
    const growth = result.agents[0];
    expect(growth.name).toBe("Growth");
    expect(growth.model).toBe("anthropic/claude-haiku-4.5");
    expect(growth.spend.spentCents).toBe(50);
    expect(growth.spend.capCents).toBe(2000);
    expect(growth.spend.runs).toBe(1);

    // Ledger: the act + the workspace-wide usage rollup (run + chat).
    expect(result.ledger.recentActs).toHaveLength(1);
    expect(result.ledger.summary.actCount).toBe(1);
    expect(result.ledger.summary.reversedCount).toBe(0);
    expect(result.ledger.summary.estMinutesSaved).toBe(10);
    expect(result.ledger.summary.totalCents).toBe(150);
    const byModel = result.ledger.summary.byModel;
    expect(byModel.map((m) => m.model)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(byModel[0].costCents).toBe(100);
    expect(byModel[1].costCents).toBe(50);
    expect(byModel[0].share).toBeCloseTo(100 / 150);
    expect(typeof result.ledger.summary.heldCount).toBe("number");

    expect(result.window.days).toBe(7);
  });

  test("empty workspace returns honest zeros, not fabrications", () => {
    const result = route("guardrails", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      checkpoints: unknown[];
      agents: unknown[];
      ledger: {
        heldItems: unknown[];
        summary: {
          actCount: number;
          totalCents: number;
          byMission: unknown[];
        };
      };
    };
    expect(result.checkpoints).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.ledger.summary.actCount).toBe(0);
    expect(result.ledger.summary.totalCents).toBe(0);
    expect(result.ledger.summary.byMission).toEqual([]);
    expect(result.ledger.heldItems).toEqual([]);
  });

  test("recent acts carry the per-act title/cost/model facts", () => {
    recordAgentAct({
      kind: "run_completed",
      agent: "Growth",
      title: "Draft the pricing one-pager",
      costCents: 37,
      model: "anthropic/claude-haiku-4.5",
    });

    const result = route("guardrails", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      ledger: {
        recentActs: Array<{
          title: string | null;
          costCents: number | null;
          model: string | null;
        }>;
      };
    };
    const [act] = result.ledger.recentActs;
    expect(act.title).toBe("Draft the pricing one-pager");
    expect(act.costCents).toBe(37);
    expect(act.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("byMission attributes $ through usage → run → item → project → mission", () => {
    const mission = createMission({ title: "Launch", outcome: "Ship v1" });
    const project = createProject({ title: "Site" });
    getDb().run(
      `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
    );
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({
      taskId: task.id,
      title: "Build landing page",
      projectId: project.id,
    });
    updateWorkItem(item.id, { lastRunConversationId: "conv-m1" });
    seedUsage("conv-m1", "anthropic/claude-haiku-4.5", 0.4); // 40¢ attributed

    // Chat usage and a projectless run don't reach any mission.
    seedUsage("conv-chat", "anthropic/claude-sonnet-4.5", 2.0);
    const orphan = createWorkItem({ taskId: task.id, title: "no project" });
    updateWorkItem(orphan.id, { lastRunConversationId: "conv-m2" });
    seedUsage("conv-m2", "anthropic/claude-haiku-4.5", 1.0);

    const result = route("guardrails", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      ledger: {
        summary: {
          byMission: Array<{
            missionId: string;
            missionTitle: string;
            costCents: number;
            runs: number;
          }>;
        };
      };
    };
    expect(result.ledger.summary.byMission).toEqual([
      {
        missionId: mission.id,
        missionTitle: "Launch",
        costCents: 40,
        runs: 1,
      },
    ]);
  });

  test("heldItems names held approvals — most recent first, capped at 5, agent-resolved", () => {
    // A run conversation binding so the held item resolves its agent.
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "Outreach" });
    updateWorkItem(item.id, {
      assignee: "Growth",
      lastRunConversationId: "conv-held",
    });

    const confirmation = (
      toolName: string,
      input: Record<string, unknown>,
    ) => ({
      toolName,
      input,
      riskLevel: "medium",
      allowlistOptions: [],
      scopeOptions: [],
    });

    // Six held confirmations, staggered so recency ordering is observable.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      registerPendingInteraction(`req-${i}`, {
        conversationId: "conv-chat",
        kind: "confirmation",
        confirmationDetails: confirmation("bash", { command: `cmd-${i}` }),
        registeredAt: base + i * 1000,
      });
    }
    registerPendingInteraction("req-newest", {
      conversationId: "conv-held",
      kind: "confirmation",
      confirmationDetails: confirmation("send_email", {
        recipient: "vc@example.com",
      }),
      registeredAt: base + 10_000,
    });
    // Non-confirmation interactions are not "held approvals".
    registerPendingInteraction("req-bash-proxy", {
      conversationId: "conv-chat",
      kind: "host_bash",
    });

    const result = route("guardrails", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      ledger: {
        heldItems: Array<{
          requestId: string;
          title: string;
          agent?: string;
          ageMs: number;
        }>;
        summary: { heldCount: number };
      };
    };

    // heldCount carries the full total; heldItems is capped at 5.
    expect(result.ledger.summary.heldCount).toBe(6);
    expect(result.ledger.heldItems).toHaveLength(5);

    // Most recent first, named after the tool + input hint, agent resolved
    // through the run-conversation binding.
    const [newest] = result.ledger.heldItems;
    expect(newest.requestId).toBe("req-newest");
    expect(newest.title).toBe("send email — vc@example.com");
    expect(newest.agent).toBe("Growth");
    expect(newest.ageMs).toBeGreaterThanOrEqual(0);

    // Owner-chat confirmations carry no agent; the oldest fell off the cap.
    const second = result.ledger.heldItems[1];
    expect(second.requestId).toBe("req-4");
    expect(second.title).toBe("bash — cmd-4");
    expect(second.agent).toBeUndefined();
    expect(result.ledger.heldItems.map((h) => h.requestId)).not.toContain(
      "req-0",
    );
  });
});

describe("checkpoint CRUD routes", () => {
  test("POST creates (201), GET lists, PATCH updates, DELETE removes", () => {
    const create = route("guardrails/checkpoints", "POST");
    expect(create.responseStatus).toBe("201");
    const { checkpoint } = create.handler({
      body: {
        template: "spend_over",
        label: "Over $25",
        thresholdCents: 2500,
        scope: "everywhere",
      },
      headers: {},
    }) as {
      checkpoint: {
        id: string;
        pattern: string;
        thresholdCents: number;
        enforced: boolean;
      };
    };
    expect(checkpoint.pattern).toBe("autonomy:money");
    expect(checkpoint.thresholdCents).toBe(2500);
    expect(checkpoint.enforced).toBe(true);

    const listed = route("guardrails/checkpoints", "GET").handler({
      headers: {},
    }) as { checkpoints: Array<{ id: string }> };
    expect(listed.checkpoints.map((c) => c.id)).toContain(checkpoint.id);

    const patched = route("guardrails/checkpoints/:id", "PATCH").handler({
      pathParams: { id: checkpoint.id },
      body: { enabled: false, label: "Over $25 (off)" },
      headers: {},
    }) as { checkpoint: { enabled: number; label: string } };
    expect(patched.checkpoint.enabled).toBe(0);
    expect(patched.checkpoint.label).toBe("Over $25 (off)");

    const deleted = route("guardrails/checkpoints/:id", "DELETE").handler({
      pathParams: { id: checkpoint.id },
      headers: {},
    }) as { success: boolean };
    expect(deleted.success).toBe(true);
    const after = route("guardrails/checkpoints", "GET").handler({
      headers: {},
    }) as { checkpoints: unknown[] };
    expect(after.checkpoints).toEqual([]);
  });

  test("POST validates template, label, and custom pattern", () => {
    const create = route("guardrails/checkpoints", "POST");
    expect(() =>
      create.handler({ body: { template: "bogus", label: "x" }, headers: {} }),
    ).toThrow(BadRequestError);
    expect(() =>
      create.handler({ body: { template: "send_message" }, headers: {} }),
    ).toThrow(BadRequestError);
    expect(() =>
      create.handler({
        body: { template: "custom", label: "needs a pattern" },
        headers: {},
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      create.handler({
        body: { template: "delete", label: "x", scope: "not-a-scope" },
        headers: {},
      }),
    ).toThrow(BadRequestError);
  });

  test("PATCH/DELETE 404 on a missing id", () => {
    expect(() =>
      route("guardrails/checkpoints/:id", "PATCH").handler({
        pathParams: { id: "nope" },
        body: { enabled: false },
        headers: {},
      }),
    ).toThrow(NotFoundError);
    expect(() =>
      route("guardrails/checkpoints/:id", "DELETE").handler({
        pathParams: { id: "nope" },
        headers: {},
      }),
    ).toThrow(NotFoundError);
  });
});
