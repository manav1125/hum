/**
 * Route tests for the volume valve, driven through the exported `ROUTES`
 * handlers rather than through a helper — the handlers are what both the HTTP
 * and IPC adapters call, so this is the shape a client actually sees.
 *
 * The health route gets the most attention here. It is the thing that would
 * have caught the previous arrival safety floor running on one of its four
 * legs, and a health route that lies is worse than none at all.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { recordArrival } from "../../../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../../../arrivals/arrival-surface.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { createMission } from "../../../missions/mission-store.js";
import { VALVE_RULE_IDS } from "../../../valve/valve-bands.js";
import { ROUTES } from "../valve-routes.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM valve_bands");
  db.run("DELETE FROM valve_stops");
  db.run("DELETE FROM valve_feedback");
  db.run("DELETE FROM arrivals");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM missions");
  db.run("DELETE FROM projects");
});

function route(operationId: string) {
  const found = ROUTES.find((r) => r.operationId === operationId);
  if (!found) throw new Error(`no route ${operationId}`);
  return found;
}

// biome-ignore lint/suspicious/noExplicitAny: route handlers are transport-agnostic
async function call(operationId: string, args: any = {}): Promise<any> {
  return await route(operationId).handler(args);
}

function arrive(externalId: string, senderAddress: string, title: string) {
  const arrival = recordArrival({
    channel: "watcher:gmail",
    externalId,
    title,
    senderAddress,
    senderName: "Someone",
    snippet: "hello",
    disposition: "surfaced",
    reason: "a reason",
    decidedBy: "rule",
    ruleId: "direct_human",
  });
  return createWorkItemForArrival(arrival);
}

describe("reading and moving the valve", () => {
  test("the default stop is needs_you, and the counts add up", async () => {
    arrive("m1", "jane@example.com", "About the contract");
    arrive("m2", "noreply@example.com", "Your weekly ride recap");

    const state = await call("getValve");
    expect(state.stop).toBe("needs_you");
    expect(state.shown).toBe(1);
    expect(state.held).toBe(1);
    expect(state.bands.needs_you + state.bands.everything).toBe(2);
  });

  test("moving the stop is reversible and loses nothing", async () => {
    arrive("m1", "jane@example.com", "About the contract");
    arrive("m2", "noreply@example.com", "recap");

    const quiet = await call("setValve", { body: { stop: "only_urgent" } });
    expect(quiet.stop).toBe("only_urgent");
    expect(quiet.shown).toBe(0);
    expect(quiet.held).toBe(2);

    const open = await call("setValve", { body: { stop: "everything" } });
    expect(open.stop).toBe("everything");
    expect(open.shown).toBe(2);
    expect(open.held).toBe(0);
  });

  test("previewing a stop does not change the saved one", async () => {
    arrive("m1", "jane@example.com", "hello");
    await call("getValve", { queryParams: { stop: "only_urgent" } });
    expect((await call("getValve")).stop).toBe("needs_you");
  });

  test("an unknown stop is rejected, never widened", async () => {
    // A typo must not silently hide most of the owner's work.
    await expect(
      call("setValve", { body: { stop: "urgnet" } }),
    ).rejects.toThrow();
    await expect(call("setValve", { body: {} })).rejects.toThrow();
  });

  test("the response reports how much of `shown` is merely unsized", async () => {
    // Fail-open honesty: an instance where everything is unbanded should say
    // so, rather than presenting a full lane as a filtered one.
    const state = await call("getValve");
    expect(state).toHaveProperty("unbanded");
  });
});

describe("the per-mission override", () => {
  test("it round-trips and reports the mission by name", async () => {
    const mission = createMission({
      title: "Ship the alpha",
      outcome: "Alpha is in testers' hands",
    });
    const state = await call("setMissionValve", {
      pathParams: { missionId: mission.id },
      body: { stop: "everything" },
    });
    expect(state.missionOverrides).toHaveLength(1);
    expect(state.missionOverrides[0].missionId).toBe(mission.id);
    expect(state.missionOverrides[0].missionTitle).toBe("Ship the alpha");

    const cleared = await call("clearMissionValve", {
      pathParams: { missionId: mission.id },
    });
    expect(cleared.missionOverrides).toHaveLength(0);
  });

  test("an override for a mission that does not exist is a 404, not a silent no-op", async () => {
    await expect(
      call("setMissionValve", {
        pathParams: { missionId: "no-such-mission" },
        body: { stop: "everything" },
      }),
    ).rejects.toThrow();
  });
});

describe("teaching the valve", () => {
  test("a dismissal is recorded and readable back", async () => {
    const result = await call("recordValveFeedback", {
      body: {
        subjectKind: "sender",
        // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
        subjectKey: "Noreply@Example.com",
        signal: "dismissed",
      },
    });
    const row = result.taught.find(
      (r: { subjectKey: string }) => r.subjectKey === "noreply@example.com",
    );
    expect(row).toBeDefined();
    expect(row.dismissed).toBe(1);
    expect(row.kept).toBe(0);
  });

  test("the read route reports NOTHING taught on a fresh instance", async () => {
    // The distinction the Guardrails page depends on: a zero here means the
    // ✕ has genuinely never been used, and the surface must say that rather
    // than print "0 senders demoted" as though it were an achievement.
    const read = await call("getValveTeaching");
    expect(read.taught).toEqual([]);
    expect(read.demotedSenders).toBe(0);
    expect(read.threshold).toBeGreaterThan(1);
  });

  test("`demotedSenders` counts what the RULES use, not the taught list", async () => {
    const dismiss = (subjectKey: string) =>
      call("recordValveFeedback", {
        body: { subjectKind: "sender", subjectKey, signal: "dismissed" },
      });

    // One ✕ is deliberately not enough — a single dismissal is as likely to
    // mean "dealt with it". A surface counting rows here would have claimed a
    // demotion that the banding rules never make.
    await dismiss("once@example.com");
    let read = await call("getValveTeaching");
    expect(read.taught).toHaveLength(1);
    expect(read.demotedSenders).toBe(0);

    await dismiss("twice@example.com");
    await dismiss("twice@example.com");
    read = await call("getValveTeaching");
    expect(read.demotedSenders).toBe(1);

    // …and taking one back genuinely undoes it, rather than merely being
    // absent: both counts are kept, so `kept` can outweigh `dismissed`.
    await call("recordValveFeedback", {
      body: {
        subjectKind: "sender",
        subjectKey: "twice@example.com",
        signal: "kept",
      },
    });
    await call("recordValveFeedback", {
      body: {
        subjectKind: "sender",
        subjectKey: "twice@example.com",
        signal: "kept",
      },
    });
    read = await call("getValveTeaching");
    expect(read.demotedSenders).toBe(0);
  });

  test("the read route records nothing — asking is not teaching", async () => {
    await call("getValveTeaching");
    await call("getValveTeaching");
    expect((await call("getValveTeaching")).taught).toEqual([]);
  });

  test("bad input is rejected rather than recorded against the wrong subject", async () => {
    await expect(
      call("recordValveFeedback", {
        body: { subjectKind: "senders", subjectKey: "x", signal: "dismissed" },
      }),
    ).rejects.toThrow();
    await expect(
      call("recordValveFeedback", {
        body: { subjectKind: "sender", subjectKey: "  ", signal: "dismissed" },
      }),
    ).rejects.toThrow();
    await expect(
      call("recordValveFeedback", {
        body: { subjectKind: "sender", subjectKey: "x", signal: "ignore" },
      }),
    ).rejects.toThrow();
  });
});

describe("the health route", () => {
  test("on a fresh instance EVERY rule is reported as never-fired", async () => {
    // The honest baseline. A health route that reported an empty `neverFired`
    // list before anything had happened would be reassuring and wrong, which
    // is precisely how the last dead safety-floor legs went unnoticed.
    const health = await call("getValveHealth");
    expect(health.neverFired.sort()).toEqual([...VALVE_RULE_IDS].sort());
    expect(health.firings).toHaveLength(0);
  });

  test("a rule that fires leaves the never-fired list", async () => {
    arrive("m1", "noreply@example.com", "Your weekly ride recap");
    const health = await call("getValveHealth");
    expect(health.neverFired).not.toContain("automated_sender");
    expect(
      health.firings.find(
        (f: { ruleId: string }) => f.ruleId === "automated_sender",
      ).count,
    ).toBe(1);
  });

  test("it publishes every rule the valve can fire, with its band", async () => {
    const health = await call("getValveHealth");
    expect(
      health.knownRules.map((r: { ruleId: string }) => r.ruleId).sort(),
    ).toEqual([...VALVE_RULE_IDS].sort());
    for (const rule of health.knownRules) {
      expect(["urgent", "needs_you", "everything"]).toContain(rule.band);
    }
  });

  test("never-fired is measured over all time, not the window", async () => {
    arrive("m1", "noreply@example.com", "recap");
    // A one-hour window sees no firings, but the rule HAS fired — conflating
    // "quiet lately" with "never worked" hides the second.
    const health = await call("getValveHealth", {
      queryParams: { windowHours: "0.0001" },
    });
    expect(health.neverFired).not.toContain("automated_sender");
  });

  test("a nonsense window is rejected", async () => {
    await expect(
      call("getValveHealth", { queryParams: { windowHours: "-3" } }),
    ).rejects.toThrow();
  });
});

describe("route hygiene", () => {
  test("every valve route declares a policy and there is no delete of work", () => {
    for (const r of ROUTES) {
      expect(r.policy).toBeTruthy();
      expect(r.operationId).toBeTruthy();
    }
    // The only DELETE in the valve removes a preference row, never an item.
    const deletes = ROUTES.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.operationId)).toEqual(["clearMissionValve"]);
  });
});
