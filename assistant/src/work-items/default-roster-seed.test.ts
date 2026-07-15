/**
 * Tests for the boot-time default agent-roster seed: seeds exactly three
 * conservative roles on an EMPTY registry, leaves any non-empty roster
 * untouched, respects the env kill switch, and never throws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { countAgents, createAgent, listAgents } from "./agent-store.js";
import {
  DEFAULT_AGENT_ROSTER,
  DISABLE_DEFAULT_AGENT_SEED_ENV,
  seedDefaultAgentRoster,
} from "./default-roster-seed.js";

initializeDb();

let origDisableEnv: string | undefined;

beforeEach(() => {
  getDb().run("DELETE FROM agents");
  origDisableEnv = process.env[DISABLE_DEFAULT_AGENT_SEED_ENV];
  delete process.env[DISABLE_DEFAULT_AGENT_SEED_ENV];
});

afterEach(() => {
  if (origDisableEnv === undefined) {
    delete process.env[DISABLE_DEFAULT_AGENT_SEED_ENV];
  } else {
    process.env[DISABLE_DEFAULT_AGENT_SEED_ENV] = origDisableEnv;
  }
});

describe("seedDefaultAgentRoster", () => {
  test("empty roster: seeds exactly Ops / Growth / Inbox with expected scopes", () => {
    expect(countAgents()).toBe(0);

    const result = seedDefaultAgentRoster();
    expect(result.seeded).toBe(true);
    expect(result.reason).toBe("seeded");
    expect(result.createdNames).toEqual(["Ops", "Growth", "Inbox"]);
    expect(countAgents()).toBe(3);

    const byName = new Map(listAgents().map((a) => [a.name, a]));
    expect([...byName.keys()].sort()).toEqual(["Growth", "Inbox", "Ops"]);

    const ops = byName.get("Ops")!;
    expect(ops.domain).toBe("Operations");
    expect(ops.toolScopes).toEqual(["calendar", "docs", "files", "research"]);

    const growth = byName.get("Growth")!;
    expect(growth.toolScopes).toEqual(["research", "docs", "files"]);

    const inbox = byName.get("Inbox")!;
    expect(inbox.toolScopes).toEqual(["email", "research", "docs"]);

    // Zero-behavior-change bias on every seeded role: charter present,
    // no model pin, hard stop off, uncapped, active, default tier.
    for (const role of DEFAULT_AGENT_ROSTER) {
      const agent = byName.get(role.name)!;
      expect(agent.charter && agent.charter.length > 0).toBe(true);
      expect(agent.model).toBeNull();
      expect(agent.hardStopEnabled).toBe(0);
      expect(agent.capCents).toBeNull();
      expect(agent.paused).toBe(0);
      expect(agent.tier).toBe("1");
    }
  });

  test("idempotent: a second call is a no-op on the just-seeded roster", () => {
    expect(seedDefaultAgentRoster().seeded).toBe(true);
    const again = seedDefaultAgentRoster();
    expect(again.seeded).toBe(false);
    expect(again.reason).toBe("roster_not_empty");
    expect(countAgents()).toBe(3);
  });

  test("non-empty roster (e.g. a legacy seed with different names) is untouched", () => {
    createAgent({ name: "Builder", domain: "Product", charter: "Ship it" });
    expect(countAgents()).toBe(1);

    const result = seedDefaultAgentRoster();
    expect(result.seeded).toBe(false);
    expect(result.reason).toBe("roster_not_empty");
    expect(countAgents()).toBe(1);
    expect(listAgents().map((a) => a.name)).toEqual(["Builder"]);
  });

  test("a single surviving agent blocks the seed (no partial top-up)", () => {
    createAgent({ name: "Ops" });
    const result = seedDefaultAgentRoster();
    expect(result.reason).toBe("roster_not_empty");
    expect(countAgents()).toBe(1);
  });

  test("kill switch CUE_DISABLE_DEFAULT_AGENT_SEED=1 skips seeding entirely", () => {
    process.env[DISABLE_DEFAULT_AGENT_SEED_ENV] = "1";
    const result = seedDefaultAgentRoster();
    expect(result.seeded).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(countAgents()).toBe(0);
  });

  test("kill switch also accepts 'true'", () => {
    process.env[DISABLE_DEFAULT_AGENT_SEED_ENV] = "true";
    expect(seedDefaultAgentRoster().reason).toBe("disabled");
    expect(countAgents()).toBe(0);
  });

  test("kill switch '0' does not disable", () => {
    process.env[DISABLE_DEFAULT_AGENT_SEED_ENV] = "0";
    expect(seedDefaultAgentRoster().reason).toBe("seeded");
    expect(countAgents()).toBe(3);
  });

  test("scopes stay within the known guardrails vocabulary and exclude social/ads/outreach", () => {
    // The conservative bias in one assertion: no seeded role carries the
    // send-adjacent domains (outreach/social/ads), and every scope id is one
    // the tool-scope filter actually knows.
    const KNOWN = new Set([
      "email",
      "calendar",
      "research",
      "files",
      "code",
      "docs",
      "design",
      "outreach",
      "social",
      "ads",
    ]);
    for (const role of DEFAULT_AGENT_ROSTER) {
      for (const scope of role.toolScopes) {
        expect(KNOWN.has(scope)).toBe(true);
      }
      expect(role.toolScopes).not.toContain("outreach");
      expect(role.toolScopes).not.toContain("social");
      expect(role.toolScopes).not.toContain("ads");
    }
  });
});
