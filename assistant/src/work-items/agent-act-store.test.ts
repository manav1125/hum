/**
 * Tests for the act/reversal ledger store: the migration, the minutes-saved
 * heuristic, act capture from a completed run (with mission denormalization),
 * reversal marking, and the summary math + per-agent breakdown.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createMission } from "../missions/mission-store.js";
import {
  estimateRunMinutesSaved,
  getActsSummary,
  listRecentActs,
  recordActForCompletedRun,
  recordAgentAct,
  reverseLatestActForWorkItem,
  RUN_MINUTES_SAVED_HEURISTIC,
} from "./agent-act-store.js";
import { createProject } from "./project-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM missions");
});

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
      { id: "wi-1", projectId: project.id, assignee: "builder" },
      { toolsUsed: ["web_search"], outputCount: 1 },
    );
    expect(act).not.toBeNull();
    expect(act!.kind).toBe("run_completed");
    expect(act!.agent).toBe("builder");
    expect(act!.workItemId).toBe("wi-1");
    expect(act!.missionId).toBe(mission.id);
    expect(act!.reversed).toBe(0);
    expect(act!.reversedAt).toBeNull();
    // base 5 + research 5 + deliverables 10 = 20.
    expect(act!.estMinutesSaved).toBe(20);
  });

  test("unlinked work item (no project) records with null mission + cue agent", () => {
    const act = recordActForCompletedRun(
      { id: "wi-2", projectId: null, assignee: null },
      { toolsUsed: [], outputCount: 0 },
    );
    expect(act!.missionId).toBeNull();
    expect(act!.agent).toBe("cue");
    expect(act!.estMinutesSaved).toBe(RUN_MINUTES_SAVED_HEURISTIC.base);
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
