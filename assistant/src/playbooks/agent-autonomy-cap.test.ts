/**
 * An agent's tier and its pause toggle have to actually stop it.
 *
 * Both were display-only. The roster let the owner set an agent to "suggests
 * only" and pause it, and neither changed anything: the agent auto-ran exactly
 * like one set to "acts autonomously". A control that reads as off while the
 * behaviour stays on is worse than no control, because the owner stops
 * watching the thing they believe they turned off.
 *
 * These pin the clamp itself. The gate that consults it lives in
 * `work-items/work-item-triage.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  agentTierCeiling,
  capAgentAutonomy,
  capAutonomy,
} from "./autonomy-cap.js";

const ops = (tier: string, paused = 0) => ({ tier, paused });

describe("tier ceilings", () => {
  test("tier 1 suggests, and may not draft or act", () => {
    expect(agentTierCeiling("1")).toBe("notify");
  });

  test("tier 2 drafts, and may not act", () => {
    expect(agentTierCeiling("2")).toBe("draft");
  });

  test("tiers 3 and 4 both act", () => {
    // They differ in whether the owner is told afterwards, which is a
    // notification concern. Treating tier 3 as less permitted would make
    // "acts, tells you after" mean "does not act".
    expect(agentTierCeiling("3")).toBe("auto");
    expect(agentTierCeiling("4")).toBe("auto");
  });

  test("an unreadable tier clamps to the least autonomy", () => {
    // A tier this code cannot read is a tier whose intent is unknown, and the
    // safe reading of an unknown intent about autonomy is the smallest one.
    expect(agentTierCeiling("")).toBe("notify");
    expect(agentTierCeiling("9")).toBe("notify");
    expect(agentTierCeiling("autonomous")).toBe("notify");
  });
});

describe("the agent's tier holds even when the workspace is permissive", () => {
  test("a draft-tier agent does not act under an Autonomous dial", () => {
    // The reason the owner staffed it at draft is precisely so a permissive
    // workspace does not turn it into an actor.
    expect(capAutonomy("auto", "autonomous").effective).toBe("auto");
    expect(capAgentAutonomy("auto", "autonomous", ops("2")).effective).toBe(
      "draft",
    );
  });

  test("a suggest-tier agent neither drafts nor acts", () => {
    expect(capAgentAutonomy("auto", "autonomous", ops("1")).effective).toBe(
      "notify",
    );
  });

  test("an acting-tier agent is still held by a restrictive dial", () => {
    // The two ceilings compose; neither overrides the other.
    expect(capAgentAutonomy("auto", "observe", ops("4")).effective).toBe(
      "notify",
    );
    expect(capAgentAutonomy("auto", "assist", ops("4")).effective).toBe(
      "draft",
    );
  });
});

describe("pause means stop", () => {
  test("a paused agent never acts, whatever its tier", () => {
    const result = capAgentAutonomy("auto", "autonomous", ops("4", 1));
    expect(result.pausedAgent).toBe(true);
    expect(result.effective).toBe("notify");
  });

  test("pausing is reported distinctly from being tier-capped", () => {
    // The owner needs to be able to tell "I paused this" from "this agent was
    // never allowed to do that" — they are undone in different places.
    expect(capAgentAutonomy("auto", "autonomous", ops("1")).pausedAgent).toBe(
      false,
    );
    expect(
      capAgentAutonomy("auto", "autonomous", ops("1", 1)).pausedAgent,
    ).toBe(true);
  });
});

describe("no agent", () => {
  test("the house assistant is governed by the dial alone, as before", () => {
    for (const dial of ["observe", "assist", "autonomous"] as const) {
      const withoutAgent = capAgentAutonomy("auto", dial, undefined);
      expect(withoutAgent.pausedAgent).toBe(false);
      expect(withoutAgent.effective).toBe(capAutonomy("auto", dial).effective);
    }
  });
});
