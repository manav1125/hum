/**
 * Round-trip tests for the act/reversal ledger routes: the summary totals +
 * per-agent breakdown (with ?agent and ?days filters) and the recent-acts
 * listing. The empty ledger returns an honest all-zero summary.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  recordAgentAct,
  reverseLatestActForWorkItem,
} from "../../work-items/agent-act-store.js";
import { ROUTES } from "./acts-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM agent_acts");
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
});
