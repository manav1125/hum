/**
 * Tests for the act/reversal ledger store: the migration, the minutes-saved
 * heuristic, act capture from a completed run (with mission denormalization
 * and cost/model/title stamping), reversal marking, the owner-initiated
 * active reversal, and the summary math + per-agent breakdown.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createMission } from "../missions/mission-store.js";
import { createTask } from "../tasks/task-store.js";
import {
  computeRunCostAndModel,
  estimateRunMinutesSaved,
  getActsSummary,
  getAgentAct,
  listRecentActs,
  recordActForCompletedRun,
  recordAgentAct,
  reverseAct,
  reverseLatestActForWorkItem,
  RUN_MINUTES_SAVED_HEURISTIC,
} from "./agent-act-store.js";
import { createProject } from "./project-store.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
} from "./work-item-store.js";
import { createWorkOutput, getWorkOutput } from "./work-output-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM missions");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM work_outputs");
  getDb().run("DELETE FROM llm_usage_events");
  getDb().run("DELETE FROM tasks");
});

function seedUsage(conversationId: string, model: string, usd: number): void {
  const now = Date.now();
  getSqliteFrom(getDb())
    .prepare(
      /*sql*/ `INSERT INTO llm_usage_events
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

describe("migration", () => {
  test("creates the agent_acts table with its indexes", () => {
    const raw = getSqliteFrom(getDb());
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_acts'`,
      )
      .all() as Array<{ name: string }>;
    expect(table.map((r) => r.name)).toEqual(["agent_acts"]);

    const indexes = (
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_acts'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("agent_acts_agent_created_idx");
    expect(indexes).toContain("agent_acts_created_idx");
  });
});

describe("estimateRunMinutesSaved", () => {
  test("credits the flat base for a trivial hands-off run", () => {
    expect(estimateRunMinutesSaved({ toolsUsed: [], outputCount: 0 })).toBe(
      RUN_MINUTES_SAVED_HEURISTIC.base,
    );
  });

  test("adds the research bonus for web tool-mix", () => {
    expect(
      estimateRunMinutesSaved({ toolsUsed: ["web_search"], outputCount: 0 }),
    ).toBe(
      RUN_MINUTES_SAVED_HEURISTIC.base + RUN_MINUTES_SAVED_HEURISTIC.research,
    );
  });

  test("adds the execution bonus for hands-on tool-mix", () => {
    expect(
      estimateRunMinutesSaved({ toolsUsed: ["bash"], outputCount: 0 }),
    ).toBe(
      RUN_MINUTES_SAVED_HEURISTIC.base + RUN_MINUTES_SAVED_HEURISTIC.execution,
    );
  });

  test("adds the deliverables bonus when the run produced an output", () => {
    expect(estimateRunMinutesSaved({ toolsUsed: [], outputCount: 2 })).toBe(
      RUN_MINUTES_SAVED_HEURISTIC.base +
        RUN_MINUTES_SAVED_HEURISTIC.deliverables,
    );
  });

  test("caps a research-and-build run at the ceiling", () => {
    // base 5 + research 5 + execution 5 + deliverables 10 = 25 == cap.
    expect(
      estimateRunMinutesSaved({
        toolsUsed: ["web_search", "bash", "file_edit"],
        outputCount: 3,
      }),
    ).toBe(RUN_MINUTES_SAVED_HEURISTIC.cap);
  });
});

describe("recordActForCompletedRun", () => {
  test("records a run_completed act with mission denormalized + estimate", () => {
    const mission = createMission({ title: "M", outcome: "O" });
    const project = createProject({ title: "Fundraise" });
    getDb().run(
      `UPDATE projects SET mission_id = '${mission.id}' WHERE id = '${project.id}'`,
    );

    const act = recordActForCompletedRun(
      {
        id: "wi-1",
        title: "Draft the pricing one-pager",
        projectId: project.id,
        assignee: "builder",
      },
      { toolsUsed: ["web_search"], outputCount: 1 },
    );
    expect(act).not.toBeNull();
    expect(act!.kind).toBe("run_completed");
    expect(act!.agent).toBe("builder");
    expect(act!.workItemId).toBe("wi-1");
    expect(act!.missionId).toBe(mission.id);
    expect(act!.title).toBe("Draft the pricing one-pager");
    expect(act!.reversed).toBe(0);
    expect(act!.reversedAt).toBeNull();
    // base 5 + research 5 + deliverables 10 = 20.
    expect(act!.estMinutesSaved).toBe(20);
  });

  test("unlinked work item (no project) records with null mission + cue agent", () => {
    const act = recordActForCompletedRun(
      { id: "wi-2", title: "t", projectId: null, assignee: null },
      { toolsUsed: [], outputCount: 0 },
    );
    expect(act!.missionId).toBeNull();
    expect(act!.agent).toBe("cue");
    expect(act!.estMinutesSaved).toBe(RUN_MINUTES_SAVED_HEURISTIC.base);
  });

  test("stamps the run's real cost + dominant model from the run conversation", () => {
    seedUsage("conv-run", "anthropic/claude-haiku-4.5", 0.02);
    seedUsage("conv-run", "anthropic/claude-haiku-4.5", 0.03);
    seedUsage("conv-run", "anthropic/claude-sonnet-4.5", 0.01);
    seedUsage("conv-other", "gpt-5", 9.99); // other conversation — excluded

    const act = recordActForCompletedRun(
      { id: "wi-c", title: "Costed run", projectId: null, assignee: null },
      { toolsUsed: [], outputCount: 0, runConversationId: "conv-run" },
    );
    // 2 + 3 + 1 = 6¢ total; haiku dominates by summed cost.
    expect(act!.costCents).toBe(6);
    expect(act!.model).toBe("anthropic/claude-haiku-4.5");

    // The stamped values persist and read back.
    const stored = getAgentAct(act!.id)!;
    expect(stored.costCents).toBe(6);
    expect(stored.model).toBe("anthropic/claude-haiku-4.5");
    expect(stored.title).toBe("Costed run");
  });

  test("no usage rows → cost/model stay null (unknown, not zero)", () => {
    const act = recordActForCompletedRun(
      { id: "wi-n", title: "t", projectId: null, assignee: null },
      { toolsUsed: [], outputCount: 0, runConversationId: "conv-empty" },
    );
    expect(act!.costCents).toBeNull();
    expect(act!.model).toBeNull();

    // No run conversation at all → same honest nulls.
    const noConv = recordActForCompletedRun(
      { id: "wi-n2", title: "t", projectId: null, assignee: null },
      { toolsUsed: [], outputCount: 0 },
    );
    expect(noConv!.costCents).toBeNull();
    expect(noConv!.model).toBeNull();
  });
});

describe("computeRunCostAndModel", () => {
  test("breaks model ties by call count", () => {
    seedUsage("conv-tie", "model-a", 0.05);
    seedUsage("conv-tie", "model-b", 0.025);
    seedUsage("conv-tie", "model-b", 0.025);
    const { costCents, model } = computeRunCostAndModel("conv-tie");
    expect(costCents).toBe(10);
    expect(model).toBe("model-b"); // equal cost, more calls
  });
});

describe("reverseLatestActForWorkItem", () => {
  test("flips the newest not-yet-reversed act and no-ops when already reversed", () => {
    recordAgentAct({ kind: "run_completed", workItemId: "wi-3" });
    expect(reverseLatestActForWorkItem("wi-3")).toBe(true);

    const [act] = listRecentActs();
    expect(act.reversed).toBe(1);
    expect(act.reversedAt).not.toBeNull();

    // Second reversal has no live act to flip.
    expect(reverseLatestActForWorkItem("wi-3")).toBe(false);
  });

  test("targets the latest act, leaving older reversed acts alone", () => {
    recordAgentAct({ kind: "run_completed", workItemId: "wi-4" });
    reverseLatestActForWorkItem("wi-4");
    // A redo produced a fresh act; a later rejection reverses only that one.
    recordAgentAct({ kind: "run_completed", workItemId: "wi-4" });
    expect(reverseLatestActForWorkItem("wi-4")).toBe(true);

    const acts = listRecentActs();
    expect(acts).toHaveLength(2);
    expect(acts.every((a) => a.reversed === 1)).toBe(true);
  });

  test("returns false for an unknown work item", () => {
    expect(reverseLatestActForWorkItem("missing")).toBe(false);
  });
});

describe("reverseAct (owner-initiated active reversal)", () => {
  function seedCompletedItem(status: "done" | "awaiting_review" = "done") {
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({ taskId: task.id, title: "Draft memo" });
    updateWorkItem(item.id, { status });
    return item;
  }

  test("run_completed: flips the act, demotes approved outputs, reopens a done item", () => {
    const item = seedCompletedItem("done");
    const approved = createWorkOutput({
      workItemId: item.id,
      kind: "document",
      title: "memo.md",
    });
    getDb().run(
      `UPDATE work_outputs SET review_state = 'approved' WHERE id = '${approved.id}'`,
    );
    const stillPending = createWorkOutput({
      workItemId: item.id,
      kind: "image",
      title: "cover.png",
    });
    const act = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
      title: "Draft memo",
    })!;

    const outcome = reverseAct(act.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.act.reversed).toBe(1);
    expect(outcome.act.reversedAt).not.toBeNull();
    expect(outcome.unwound.outputsDemoted).toBe(1); // only the approved one
    expect(outcome.unwound.workItemReopened).toBe(true);

    // The unwind is real, not just reported.
    expect(getAgentAct(act.id)!.reversed).toBe(1);
    expect(getWorkOutput(approved.id)!.reviewState).toBe("pending");
    expect(getWorkOutput(stillPending.id)!.reviewState).toBe("pending");
    expect(getWorkItem(item.id)!.status).toBe("awaiting_review");
  });

  test("run_completed on an awaiting_review item: reverses without a status flip", () => {
    const item = seedCompletedItem("awaiting_review");
    const act = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
    })!;

    const outcome = reverseAct(act.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.unwound.workItemReopened).toBe(false);
    expect(getWorkItem(item.id)!.status).toBe("awaiting_review");
  });

  test("does not double-reverse a sibling act via the output-store hook", () => {
    const item = seedCompletedItem("done");
    const out = createWorkOutput({
      workItemId: item.id,
      kind: "document",
      title: "v1.md",
    });
    getDb().run(
      `UPDATE work_outputs SET review_state = 'approved' WHERE id = '${out.id}'`,
    );
    // Two acts on the same item (an earlier run + the latest).
    const earlier = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
    })!;
    const latest = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
    })!;

    const outcome = reverseAct(latest.id);
    expect(outcome.ok).toBe(true);
    // Only the requested act flipped — the demotion bypassed the
    // reverse-latest hook, so the earlier act is untouched.
    expect(getAgentAct(latest.id)!.reversed).toBe(1);
    expect(getAgentAct(earlier.id)!.reversed).toBe(0);
  });

  test("already-reversed act → already_reversed, nothing changes", () => {
    const item = seedCompletedItem("done");
    const act = recordAgentAct({
      kind: "run_completed",
      workItemId: item.id,
    })!;
    reverseLatestActForWorkItem(item.id);

    const outcome = reverseAct(act.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("already_reversed");
    expect(getWorkItem(item.id)!.status).toBe("done"); // untouched
  });

  test("kinds with no concrete undo → no_undo, act stays live", () => {
    for (const kind of [
      "message_drafted",
      "schedule_fired",
      "other",
    ] as const) {
      const act = recordAgentAct({ kind, workItemId: "wi-x" })!;
      const outcome = reverseAct(act.id);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.code).toBe("no_undo");
      expect(outcome.reason.length).toBeGreaterThan(0);
      expect(getAgentAct(act.id)!.reversed).toBe(0);
    }
  });

  test("reversible kind with no bound work item → no_undo", () => {
    const act = recordAgentAct({ kind: "run_completed" })!;
    const outcome = reverseAct(act.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("no_undo");
    expect(getAgentAct(act.id)!.reversed).toBe(0);
  });

  test("unknown act → not_found", () => {
    const outcome = reverseAct("missing");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("not_found");
  });
});

describe("getActsSummary", () => {
  test("totals and per-agent breakdown; est_minutes counts only live acts", () => {
    // cue: two acts, one reversed → 1 live, minutes only from the live one.
    recordAgentAct({
      kind: "run_completed",
      agent: "cue",
      estMinutesSaved: 10,
    });
    const reversedCue = recordAgentAct({
      kind: "run_completed",
      agent: "cue",
      workItemId: "wi-r",
      estMinutesSaved: 15,
    });
    expect(reversedCue).not.toBeNull();
    reverseLatestActForWorkItem("wi-r");
    // builder: one live act.
    recordAgentAct({
      kind: "run_completed",
      agent: "builder",
      estMinutesSaved: 8,
    });

    const summary = getActsSummary();
    expect(summary.acts).toBe(3);
    expect(summary.reversed).toBe(1);
    // 10 (live cue) + 8 (builder) — the reversed cue act's 15 is excluded.
    expect(summary.estMinutesSaved).toBe(18);

    // Per-agent breakdown, sorted by act count desc.
    expect(summary.byAgent).toHaveLength(2);
    const cue = summary.byAgent.find((a) => a.agent === "cue")!;
    expect(cue.acts).toBe(2);
    expect(cue.reversed).toBe(1);
    expect(cue.estMinutesSaved).toBe(10);
    const builder = summary.byAgent.find((a) => a.agent === "builder")!;
    expect(builder.acts).toBe(1);
    expect(builder.reversed).toBe(0);
    expect(builder.estMinutesSaved).toBe(8);
  });

  test("filters to one agent and honours the trailing-days window", () => {
    recordAgentAct({ kind: "run_completed", agent: "cue", estMinutesSaved: 5 });
    recordAgentAct({
      kind: "run_completed",
      agent: "builder",
      estMinutesSaved: 5,
    });

    const cueOnly = getActsSummary({ agent: "cue" });
    expect(cueOnly.acts).toBe(1);
    expect(cueOnly.byAgent).toHaveLength(1);
    expect(cueOnly.byAgent[0].agent).toBe("cue");

    // An act stamped 10 days ago is outside a 1-day window.
    const old = recordAgentAct({ kind: "other", agent: "cue" });
    getDb().run(
      `UPDATE agent_acts SET created_at = ${Date.now() - 10 * 24 * 60 * 60 * 1000} WHERE id = '${old!.id}'`,
    );
    const recent = getActsSummary({ days: 1 });
    // Only the two fresh acts fall inside the window.
    expect(recent.acts).toBe(2);
  });

  test("empty ledger is an honest all-zero summary (no backfill)", () => {
    const summary = getActsSummary();
    expect(summary.acts).toBe(0);
    expect(summary.reversed).toBe(0);
    expect(summary.estMinutesSaved).toBe(0);
    expect(summary.byAgent).toEqual([]);
  });
});

describe("listRecentActs", () => {
  test("returns newest-first and respects the limit cap", () => {
    recordAgentAct({ kind: "run_completed", agent: "cue" });
    recordAgentAct({ kind: "output_produced", agent: "cue" });

    const all = listRecentActs();
    expect(all).toHaveLength(2);
    // Newest first: output_produced was recorded last.
    expect(all[0].kind).toBe("output_produced");
    expect(listRecentActs({ limit: 1 })).toHaveLength(1);
  });
});
