/**
 * Delegating to an agent that does not exist must fail, not fall through.
 *
 * Work-item assignee matching is by NAME, case-insensitively, and everything
 * that makes an agent an agent keys off that match: its spend cap, its tool
 * scopes, its model pin. An unmatched name resolves to the house assistant,
 * which is unrestricted.
 *
 * So a near-miss — "Ops team" for an agent called "Ops" — used to hand the
 * work to unrestricted generic Cue while the owner believed they had given it
 * to a capped, scoped agent. Nothing in the result said otherwise. These pin
 * that the tool refuses instead, and that the refusal names the roster so the
 * caller can correct itself in one turn rather than guessing again.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Agent } from "../../work-items/agent-store.js";

const realAgentStore = await import("../../work-items/agent-store.js");

function agent(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${name.toLowerCase()}`,
    name,
    emoji: null,
    domain: null,
    charter: null,
    tier: "2",
    capCents: null,
    warnPercent: null,
    hardStopEnabled: 0,
    paused: 0,
    model: null,
    toolScopes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Agent;
}

/**
 * Spread the real module and override only `listAgents`. An exhaustive factory
 * would delete every other export for this file and every file after it — see
 * assistant/CLAUDE.md.
 */
function withRoster(roster: Agent[]): void {
  mock.module("../../work-items/agent-store.js", () => ({
    ...realAgentStore,
    listAgents: () => roster,
  }));
}

afterEach(() => {
  mock.module("../../work-items/agent-store.js", () => ({ ...realAgentStore }));
});

async function addWithAssignee(assignee: unknown) {
  withRoster([agent("Ops"), agent("Growth")]);
  const { executeTaskListAdd } = await import("./work-item-enqueue.js");
  return executeTaskListAdd(
    { title: "Reconcile the Acme invoice", assignee },
    {} as never,
  );
}

describe("an unknown assignee is refused", () => {
  test("a near-miss name does not silently become the house assistant", async () => {
    const result = await addWithAssignee("Ops team");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no agent named");
  });

  test("the refusal names the roster so the caller can correct itself", async () => {
    const result = await addWithAssignee("Finance");
    expect(result.content).toContain("Ops");
    expect(result.content).toContain("Growth");
  });

  test("an empty assignee is refused rather than treated as omitted", async () => {
    // Omitting is a choice ("run it yourself"); sending blank is a bug in the
    // caller, and swallowing it would hide that bug behind working behaviour.
    const result = await addWithAssignee("   ");
    expect(result.isError).toBe(true);
  });
});

describe("names that are meant to pass through", () => {
  test('"you" is the owner, not a roster lookup', async () => {
    const result = await addWithAssignee("you");
    expect(result.content).not.toContain("no agent named");
  });

  test('"cue" is the house assistant, not a roster lookup', async () => {
    const result = await addWithAssignee("cue");
    expect(result.content).not.toContain("no agent named");
  });

  test("a roster name matches case-insensitively, as the runner matches it", async () => {
    const result = await addWithAssignee("ops");
    expect(result.content).not.toContain("no agent named");
  });
});
