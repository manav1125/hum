import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  CompanionNudges,
  mayNudge,
  NUDGE_DAILY_BUDGET,
  NUDGE_INPUT_QUIET_MS,
  type HeldNudge,
  type NudgeConditions,
} from "./companion-nudge";

/**
 * The nudge — design `C7`.
 *
 * Every one of these is a rule about when Cue may **not** speak, which is the
 * part worth testing: the failure mode is not a crash, it is a creature that
 * interrupts once too often. Nobody files a bug about that. They just hide it,
 * and then the always-on companion is a thing that is off.
 */

const conditions = (patch: Partial<NudgeConditions> = {}): NudgeConditions => ({
  spentToday: 0,
  alreadyNudged: new Set<string>(),
  sinceInputMs: 60_000,
  quiet: false,
  visible: true,
  ...patch,
});

/** The real one is eight seconds; nothing here is testing the number. */
const RETRACT_MS = 40;

const request = { itemId: "i1", line: "Dana replied on pricing", source: "needs-you" as const };

describe("what may interrupt you at all", () => {
  test("an item the valve has already decided needs you", () => {
    expect(mayNudge(request, conditions()).allowed).toBe(true);
  });

  test("Cue correcting itself qualifies too", () => {
    expect(
      mayNudge({ ...request, source: "correction" }, conditions()).allowed,
    ).toBe(true);
  });

  test("REGRESSION: Cue talking about its own work does not", () => {
    // The line between a companion and Clippy is drawn here: a finished run
    // is not a reason to speak first.
    const verdict = mayNudge({ ...request, source: "run-finished" }, conditions());
    expect(verdict).toEqual({ allowed: false, reason: "source" });
  });
});

describe("the rules that keep it from becoming Clippy", () => {
  test("never twice for the same item", () => {
    expect(
      mayNudge(request, conditions({ alreadyNudged: new Set(["i1"]) })),
    ).toEqual({ allowed: false, reason: "repeat" });
  });

  test("never while you are in the middle of something", () => {
    expect(
      mayNudge(request, conditions({ sinceInputMs: NUDGE_INPUT_QUIET_MS - 1 })),
    ).toEqual({ allowed: false, reason: "typing" });
  });

  test("never during quiet hours", () => {
    expect(mayNudge(request, conditions({ quiet: true }))).toEqual({
      allowed: false,
      reason: "quiet",
    });
  });

  test("three a day, shared with push", () => {
    expect(
      mayNudge(request, conditions({ spentToday: NUDGE_DAILY_BUDGET })),
    ).toEqual({ allowed: false, reason: "budget" });
  });

  test("never from a creature that is not on screen", () => {
    expect(mayNudge(request, conditions({ visible: false }))).toEqual({
      allowed: false,
      reason: "hidden",
    });
  });

  test("REGRESSION: the reason names the most fundamental refusal, not the first check", () => {
    // Told "over budget" about something that never qualified, a caller
    // retries tomorrow — forever.
    expect(
      mayNudge(
        { ...request, source: "run-finished" },
        conditions({ spentToday: 99, quiet: true }),
      ).allowed === false &&
        mayNudge(
          { ...request, source: "run-finished" },
          conditions({ spentToday: 99, quiet: true }),
        ),
    ).toEqual({ allowed: false, reason: "source" });
  });
});

describe("an ignored nudge is never lost, and never repeats itself out loud", () => {
  let presented: Array<HeldNudge | null>;
  let holds: Array<HeldNudge | null>;
  let taught: string[];
  let clock: number;
  let nudges: CompanionNudges;

  beforeEach(() => {
    presented = [];
    holds = [];
    taught = [];
    clock = Date.parse("2026-08-25T10:00:00Z");
    nudges = new CompanionNudges(
      {
        present: (n) => presented.push(n),
        hold: (n) => holds.push(n),
        taught: (n) => taught.push(n.itemId),
        now: () => clock,
      },
      RETRACT_MS,
    );
  });

  const rest = { sinceInputMs: 60_000, quiet: false, visible: true };

  test("it retracts on its own to a glint held on the dot", async () => {
    nudges.offer(request, rest);
    expect(nudges.current()?.line).toBe("Dana replied on pricing");

    await Bun.sleep(RETRACT_MS + 40);

    expect(nudges.current()).toBeNull();
    expect(nudges.holding()?.itemId).toBe("i1");
  });

  test("hovering replays the held line", async () => {
    nudges.offer(request, rest);
    await Bun.sleep(RETRACT_MS + 40);

    nudges.hover();
    expect(nudges.current()?.itemId).toBe("i1");
    expect(nudges.holding()).toBeNull();
  });

  test("hovering with nothing held does nothing at all", () => {
    nudges.hover();
    expect(presented).toHaveLength(0);
  });

  test("dismissing teaches the valve and takes the glint with it", () => {
    nudges.offer(request, rest);
    nudges.dismiss();

    expect(taught).toEqual(["i1"]);
    expect(nudges.current()).toBeNull();
    expect(nudges.holding()).toBeNull();
  });

  test("opening hands the item over without teaching anything", () => {
    // ✕ is the signal. Opening something is not a complaint about it.
    nudges.offer(request, rest);
    expect(nudges.open()).toBe("i1");
    expect(taught).toEqual([]);
  });
});

describe("nudges with nowhere to be shown are held, not lost (C11)", () => {
  let clock: number;
  let presented: Array<HeldNudge | null>;
  let nudges: CompanionNudges;
  const rest = { sinceInputMs: 60_000, quiet: false, visible: true };
  const noSurface = { ...rest, visible: false };

  beforeEach(() => {
    clock = Date.parse("2026-08-25T10:00:00Z");
    presented = [];
    nudges = new CompanionNudges(
      {
        present: (n) => presented.push(n),
        hold: () => undefined,
        taught: () => undefined,
        now: () => clock,
      },
      RETRACT_MS,
    );
  });

  test("refused for want of a surface, it waits", () => {
    expect(nudges.offer(request, noSurface).allowed).toBe(false);
    expect(nudges.heldCount()).toBe(1);
  });

  test("REGRESSION: a decision about the nudge is not a held nudge", () => {
    // Quiet hours and the budget are decisions; having nowhere to draw it is
    // an accident. Holding the first kind would replay things the rules had
    // already said no to.
    nudges.offer(request, { ...rest, quiet: true });
    nudges.offer({ ...request, itemId: "i2" }, { ...rest, quiet: true });
    expect(nudges.heldCount()).toBe(0);
  });

  test("it spent nothing, so replaying it is not a second interruption", () => {
    nudges.offer(request, noSurface);
    expect(nudges.conditions(rest).spentToday).toBe(0);
  });

  test("the same item twice is held once", () => {
    nudges.offer(request, noSurface);
    nudges.offer(request, noSurface);
    expect(nudges.heldCount()).toBe(1);
  });

  test("replaying shows one, not all of them at once", () => {
    // They were withheld because nothing could speak. Answering that by
    // saying three things at once is worse than having said nothing.
    nudges.offer(request, noSurface);
    nudges.offer({ ...request, itemId: "i2", line: "Second" }, noSurface);

    expect(nudges.replayWithheld(rest)).toBe(true);
    expect(nudges.current()?.itemId).toBe("i1");
    expect(nudges.heldCount()).toBe(1);
    nudges.stop();
  });

  test("replaying with nothing held does nothing", () => {
    expect(nudges.replayWithheld(rest)).toBe(false);
    expect(presented).toHaveLength(0);
  });

  test("REGRESSION: yesterday's withheld nudges are not replayed today", () => {
    // Replaying a day-old nudge is the thing that makes people hide the
    // creature.
    nudges.offer(request, noSurface);
    clock = Date.parse("2026-08-26T10:00:00Z");
    nudges.conditions(rest);
    expect(nudges.heldCount()).toBe(0);
  });
});

describe("the budget, and the day it belongs to", () => {
  let clock: number;
  let nudges: CompanionNudges;
  const rest = { sinceInputMs: 60_000, quiet: false, visible: true };

  beforeEach(() => {
    clock = Date.parse("2026-08-25T10:00:00Z");
    nudges = new CompanionNudges({
      present: () => undefined,
      hold: () => undefined,
      taught: () => undefined,
      now: () => clock,
    });
  });

  test("a taken nudge spends from the shared budget", () => {
    for (let i = 0; i < NUDGE_DAILY_BUDGET; i++) {
      expect(nudges.offer({ ...request, itemId: `i${i}` }, rest).allowed).toBe(
        true,
      );
    }
    expect(nudges.offer({ ...request, itemId: "i9" }, rest)).toEqual({
      allowed: false,
      reason: "budget",
    });
    nudges.stop();
  });

  test("a refused nudge spends nothing — the caller pushes instead", () => {
    // "Replaces, never doubles" only holds if a refusal leaves the budget
    // alone for the push that follows it.
    expect(nudges.offer(request, { ...rest, quiet: true }).allowed).toBe(false);
    expect(nudges.conditions(rest).spentToday).toBe(0);
  });

  test("REGRESSION: the day rolls over on the date, not on a timer", async () => {
    // A timer set for midnight is a timer that does not fire when the machine
    // was asleep at midnight, which is most nights.
    for (let i = 0; i < NUDGE_DAILY_BUDGET; i++) {
      nudges.offer({ ...request, itemId: `i${i}` }, rest);
    }
    nudges.stop();
    expect(nudges.offer({ ...request, itemId: "x" }, rest).allowed).toBe(false);

    clock = Date.parse("2026-08-26T10:00:00Z");
    expect(nudges.offer({ ...request, itemId: "x" }, rest).allowed).toBe(true);
    nudges.stop();
  });

  test("a new day forgets what it already said, so nothing is stuck forever", () => {
    nudges.offer(request, rest);
    nudges.stop();
    clock = Date.parse("2026-08-26T10:00:00Z");
    expect(nudges.offer(request, rest).allowed).toBe(true);
    nudges.stop();
  });
});
