/**
 * An agent's restrictions must not lapse just because time passed.
 *
 * `tool_scopes` is a guardrail: an agent carrying them is one the owner
 * deliberately narrowed. Those scopes used to be attached to the in-memory
 * conversation at run time and nowhere else, so the evictor sweeping an idle
 * conversation — or a daemon restart — quietly restored the full unrestricted
 * tool set, with nothing to tell the owner their restriction had stopped
 * applying.
 *
 * A guardrail that lapses on a timer is worse than one that was never offered,
 * because the owner believes it is on. These pin the rules that make it
 * survive.
 */

import { describe, expect, test } from "bun:test";

import {
  type AgentBindable,
  applyAgentBinding,
  buildAgentCharterPreamble,
  resolveAgentModelOverride,
} from "./agent-binding.js";
import type { Agent } from "./agent-store.js";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-ops",
    name: "Ops",
    emoji: "🛠",
    domain: "Operations",
    charter: "Keep the books straight and the vendors paid.",
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

describe("tool scopes survive rehydration", () => {
  test("a scoped agent's filter is applied to a fresh conversation", () => {
    const conversation: AgentBindable = {};
    applyAgentBinding(conversation, agent({ toolScopes: ["email"] }));
    expect(typeof conversation.toolScopeFilter).toBe("function");
  });

  test("re-applying is idempotent, so every hydration is safe", () => {
    const conversation: AgentBindable = {};
    const a = agent({ toolScopes: ["email"] });
    applyAgentBinding(conversation, a);
    const first = conversation.toolScopeFilter;
    applyAgentBinding(conversation, a);
    expect(typeof conversation.toolScopeFilter).toBe("function");
    // A fresh filter each time is fine; what matters is one is always present.
    expect(first).toBeDefined();
  });
});

describe("a binding that changes must not leave the old rules behind", () => {
  test("an unscoped agent clears a previous agent's filter", () => {
    // A conversation reassigned from a scoped agent to an unscoped one that
    // kept enforcing the old scopes would deny tools for a reason the owner
    // cannot see anywhere on screen.
    const conversation: AgentBindable = {};
    applyAgentBinding(conversation, agent({ toolScopes: ["email"] }));
    expect(conversation.toolScopeFilter).toBeDefined();

    applyAgentBinding(
      conversation,
      agent({ id: "agent-growth", toolScopes: null }),
    );
    expect(conversation.toolScopeFilter).toBeUndefined();
  });

  test("the house assistant clears the filter too", () => {
    const conversation: AgentBindable = {};
    applyAgentBinding(conversation, agent({ toolScopes: ["email"] }));
    applyAgentBinding(conversation, undefined);
    expect(conversation.toolScopeFilter).toBeUndefined();
  });
});

describe("the charter travels with the binding", () => {
  test("applying a binding sets the agent's identity on the conversation", () => {
    const conversation: AgentBindable = {};
    applyAgentBinding(conversation, agent());
    expect(conversation.agentCharter).toContain("Ops");
    expect(conversation.agentCharter).toContain("Keep the books straight");
  });

  test("rebinding to the house assistant clears the identity", () => {
    // A conversation that kept a previous agent's charter would introduce
    // itself as an agent that is no longer running it.
    const conversation: AgentBindable = {};
    applyAgentBinding(conversation, agent());
    applyAgentBinding(conversation, undefined);
    expect(conversation.agentCharter).toBeUndefined();
  });
});

describe("model pin", () => {
  test("an agent's pin becomes the conversation's model override", () => {
    expect(resolveAgentModelOverride(agent({ model: "deepseek/x" }))).toBe(
      "deepseek/x",
    );
  });

  test("no pin and no agent both mean no override", () => {
    expect(resolveAgentModelOverride(agent({ model: null }))).toBeUndefined();
    expect(resolveAgentModelOverride(undefined)).toBeUndefined();
  });
});

describe("charter", () => {
  test("names the agent and carries its mandate", () => {
    const preamble = buildAgentCharterPreamble(agent())!;
    expect(preamble).toContain("Ops");
    expect(preamble).toContain("Operations");
    expect(preamble).toContain("Keep the books straight");
  });

  test("an agent with no charter still gets named", () => {
    // Identity without a mandate is still identity: the agent should not
    // introduce itself as nobody.
    const preamble = buildAgentCharterPreamble(agent({ charter: null }))!;
    expect(preamble).toContain("Ops");
  });

  test("the house assistant has no preamble to add", () => {
    expect(buildAgentCharterPreamble(undefined)).toBeUndefined();
  });
});
