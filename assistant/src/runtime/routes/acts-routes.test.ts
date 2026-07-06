/**
 * Round-trip tests for the act/reversal ledger routes: the summary totals +
 * per-agent breakdown (with ?agent and ?days filters), the recent-acts
 * listing (with the per-act cost/model/title facts), and the owner-initiated
 * reverse endpoint's honest per-kind behavior (perform the concrete unwind
 * or 409 — never fake success). The empty ledger returns an honest all-zero
 * summary.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  getAgentAct,
  recordAgentAct,
  reverseLatestActForWorkItem,
} from "../../work-items/agent-act-store.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { ROUTES } from "./acts-routes.js";
import { ConflictError, NotFoundError } from "./errors.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM tasks");
});

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

describe("GET acts/summary", () => {
  test("returns totals + per-agent breakdown; est counts only live acts", () => {
    recordAgentAct({
      kind: "run_completed",
      agent: "cue",
      estMinutesSaved: 10,
    });
    recordAgentAct({
      kind: "run_completed",
      agent: "cue",
      workItemId: "wi-r",
      estMinutesSaved: 15,
    });
    reverseLatestActForWorkItem("wi-r");
    recordAgentAct({
      kind: "run_completed",
      agent: "builder",
      estMinutesSaved: 8,
    });

    const result = route("acts/summary", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      acts: number;
      reversed: number;
      estMinutesSaved: number;
      byAgent: Array<{ agent: string; acts: number; estMinutesSaved: number }>;
    };
    expect(result.acts).toBe(3);
    expect(result.reversed).toBe(1);
    expect(result.estMinutesSaved).toBe(18);
    expect(result.byAgent).toHaveLength(2);
  });

  test("empty ledger returns an all-zero summary", () => {
    const result = route("acts/summary", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { acts: number; reversed: number; estMinutesSaved: number };
    expect(result.acts).toBe(0);
    expect(result.reversed).toBe(0);
    expect(result.estMinutesSaved).toBe(0);
  });

  test("?agent filters to one assignee", () => {
    recordAgentAct({ kind: "run_completed", agent: "cue", estMinutesSaved: 5 });
    recordAgentAct({
      kind: "run_completed",
      agent: "builder",
      estMinutesSaved: 5,
    });
    const result = route("acts/summary", "GET").handler({
      queryParams: { agent: "cue" },
      headers: {},
    }) as { acts: number };
    expect(result.acts).toBe(1);
  });
});

describe("GET acts", () => {
  test("lists newest-first and respects ?limit", () => {
    recordAgentAct({ kind: "run_completed", agent: "cue" });
    recordAgentAct({ kind: "output_produced", agent: "cue" });

    const all = route("acts", "GET").handler({
      queryParams: {},
      headers: {},
    }) as { acts: Array<{ kind: string }> };
    expect(all.acts).toHaveLength(2);
    expect(all.acts[0].kind).toBe("output_produced");

    const limited = route("acts", "GET").handler({
      queryParams: { limit: "1" },
      headers: {},
    }) as { acts: unknown[] };
    expect(limited.acts).toHaveLength(1);
  });

  test("exposes the per-act title, cost, and model facts", () => {
    recordAgentAct({
      kind: "run_completed",
      agent: "cue",
      title: "Draft the pricing one-pager",
      costCents: 42,
      model: "anthropic/claude-haiku-4.5",
    });
    recordAgentAct({ kind: "run_completed", agent: "cue" }); // pre-R2 style act

    const { acts } = route("acts", "GET").handler({
      queryParams: {},
      headers: {},
    }) as {
      acts: Array<{
        title: string | null;
        costCents: number | null;
        model: string | null;
      }>;
    };
    // Newest-first: the bare act, then the stamped one.
    expect(acts[1].title).toBe("Draft the pricing one-pager");
    expect(acts[1].costCents).toBe(42);
    expect(acts[1].model).toBe("anthropic/claude-haiku-4.5");
    // Unstamped acts stay honestly null.
    expect(acts[0].title).toBeNull();
    expect(acts[0].costCents).toBeNull();
    expect(acts[0].model).toBeNull();
  });
});

describe("POST acts/:id/reverse", () => {
  const reverse = (id: string) =>
    route("acts/:id/reverse", "POST").handler({
      pathParams: { id },
      headers: {},
    }) as {
      act: { id: string; reversed: number };
      unwound: { outputsDemoted: number; workItemReopened: boolean };
    };

  function seedDoneItemWithApprovedOutput() {
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "Draft memo" });
    updateWorkItem(item.id, { status: "done" });
    getDb().run(
      `INSERT INTO work_outputs (id, work_item_id, kind, title, review_state, created_at)
       VALUES ('out-1', '${item.id}', 'document', 'memo.md', 'approved', ${Date.now()})`,
    );
    return item;
  }

  test("run_completed act: reverses and performs the concrete unwind", () => {
    const item = seedDoneItemWithApprovedOutput();
    const act = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
      title: "Draft memo",
    })!;

    const result = reverse(act.id);
    expect(result.act.reversed).toBe(1);
    expect(result.unwound.outputsDemoted).toBe(1);
    expect(result.unwound.workItemReopened).toBe(true);
    expect(getAgentAct(act.id)!.reversed).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("awaiting_review");
  });

  test("409 for kinds with no concrete undo — never fake success", () => {
    const act = recordAgentAct({ kind: "schedule_fired" })!;
    expect(() => reverse(act.id)).toThrow(ConflictError);
    expect(getAgentAct(act.id)!.reversed).toBe(0);
  });

  test("409 when the act was already reversed", () => {
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "x" });
    const act = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
    })!;
    reverseLatestActForWorkItem(item.id);
    expect(() => reverse(act.id)).toThrow(ConflictError);
  });

  test("404 for an unknown act", () => {
    expect(() => reverse("missing")).toThrow(NotFoundError);
  });
});
