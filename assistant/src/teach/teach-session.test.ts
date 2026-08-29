/**
 * The bounds on a demonstration are the product, so they are what these pin.
 *
 * A teach session is the one place Cue watches a screen continuously at the
 * owner's invitation. Every property here is about that invitation being
 * honoured exactly: it ends when they say, it ends anyway, and what it saw
 * after they said stop is not part of what they taught.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetTeachSessionForTests,
  getTeachSessionView,
  getTeachTimeline,
  isTeachSessionArmed,
  recordTeachStep,
  startTeachSession,
  stopTeachSession,
  TEACH_SESSION_MAX_MINUTES,
} from "./teach-session.js";

const T0 = 1_700_000_000_000;

function step(at: number, description: string, appName?: string) {
  return { at, description, ...(appName ? { appName } : {}) };
}

beforeEach(() => {
  _resetTeachSessionForTests();
});

describe("bounds", () => {
  test("a caller cannot ask to be watched for longer than the cap", () => {
    const view = startTeachSession({
      goal: "file an invoice",
      durationMinutes: 600,
      now: T0,
    });
    const spanMinutes =
      (Date.parse(view.expiresAt!) - Date.parse(view.startedAt!)) / 60_000;
    expect(spanMinutes).toBe(TEACH_SESSION_MAX_MINUTES);
  });

  test("omitting a duration means the default, never forever", () => {
    const view = startTeachSession({ goal: "x", now: T0 });
    expect(view.expiresAt).not.toBeNull();
    expect(Date.parse(view.expiresAt!)).toBeGreaterThan(T0);
  });

  test("watching stops on its own at expiry", () => {
    startTeachSession({ goal: "x", durationMinutes: 1, now: T0 });
    expect(isTeachSessionArmed(T0 + 30_000)).toBe(true);
    expect(isTeachSessionArmed(T0 + 61_000)).toBe(false);
  });
});

describe("what a demonstration keeps", () => {
  test("steps are kept in the order performed, with their pacing", () => {
    startTeachSession({ goal: "invoice", now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);
    recordTeachStep(
      step(T0 + 9_000, "Clicked New Invoice", "Safari"),
      T0 + 9_000,
    );

    const timeline = getTeachTimeline(T0 + 10_000)!;
    expect(timeline.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(timeline.steps[0].offsetSeconds).toBe(1);
    expect(timeline.steps[1].offsetSeconds).toBe(9);
    expect(timeline.steps[1].appName).toBe("Safari");
  });

  test("an observation with no readable text is not a step", () => {
    // A blank read tells us nothing about the procedure, and recording it as
    // a step would put an empty instruction into the skill.
    startTeachSession({ goal: "x", now: T0 });
    recordTeachStep(step(T0 + 1_000, "   "), T0 + 1_000);
    expect(getTeachSessionView(T0 + 2_000).stepCount).toBe(0);
  });

  test("a step observed after the owner stopped is not part of the lesson", () => {
    startTeachSession({ goal: "x", now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);
    stopTeachSession(T0 + 2_000);

    recordTeachStep(step(T0 + 3_000, "Opened personal email"), T0 + 3_000);

    const timeline = getTeachTimeline(T0 + 4_000)!;
    expect(timeline.steps).toHaveLength(1);
    expect(timeline.steps[0].description).toBe("Opened Billing");
  });

  test("a step observed after expiry is not part of the lesson either", () => {
    startTeachSession({ goal: "x", durationMinutes: 1, now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);

    recordTeachStep(step(T0 + 90_000, "Opened personal email"), T0 + 90_000);

    const timeline = getTeachTimeline(T0 + 91_000)!;
    expect(timeline.steps).toHaveLength(1);
  });
});

describe("what survives the end of watching", () => {
  test("expiry retires the demonstration rather than discarding it", () => {
    // An owner who demonstrates for the full duration and then asks for the
    // skill has done nothing wrong; losing their work to a timer would be the
    // worst reading of a safety bound.
    startTeachSession({ goal: "invoice", durationMinutes: 1, now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);

    expect(isTeachSessionArmed(T0 + 61_000)).toBe(false);
    const timeline = getTeachTimeline(T0 + 61_000);
    expect(timeline).not.toBeNull();
    expect(timeline!.steps).toHaveLength(1);
    expect(timeline!.goal).toBe("invoice");
  });

  test("stopping keeps the demonstration available to write up", () => {
    startTeachSession({ goal: "invoice", now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);
    const view = stopTeachSession(T0 + 2_000);

    expect(view.armed).toBe(false);
    expect(view.stepCount).toBe(1);
    expect(getTeachTimeline(T0 + 3_000)!.steps).toHaveLength(1);
  });

  test("stop is idempotent", () => {
    startTeachSession({ goal: "x", now: T0 });
    stopTeachSession(T0 + 1_000);
    expect(() => stopTeachSession(T0 + 2_000)).not.toThrow();
    expect(getTeachSessionView(T0 + 3_000).armed).toBe(false);
  });

  test("a new demonstration never blends into the previous one", () => {
    // Two demonstrations appended together would produce a procedure nobody
    // performed.
    startTeachSession({ goal: "invoice", now: T0 });
    recordTeachStep(step(T0 + 1_000, "Opened Billing"), T0 + 1_000);
    stopTeachSession(T0 + 2_000);

    startTeachSession({ goal: "expenses", now: T0 + 3_000 });
    const timeline = getTeachTimeline(T0 + 4_000)!;
    expect(timeline.goal).toBe("expenses");
    expect(timeline.steps).toHaveLength(0);
  });
});

describe("nothing demonstrated", () => {
  test("no session reads as no timeline, not an empty one", () => {
    // Distinct states: "nobody taught me anything" and "I watched and saw
    // nothing" need different answers to the owner.
    expect(getTeachTimeline(T0)).toBeNull();
    expect(getTeachSessionView(T0).sessionId).toBeNull();
  });

  test("a session that saw nothing is a timeline with no steps", () => {
    startTeachSession({ goal: "x", now: T0 });
    stopTeachSession(T0 + 1_000);
    const timeline = getTeachTimeline(T0 + 2_000);
    expect(timeline).not.toBeNull();
    expect(timeline!.steps).toHaveLength(0);
  });
});
