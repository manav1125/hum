/**
 * The interruption budget as a pure decision: tiering, design's three-a-day
 * ceiling, the quiet-hours exemption that belongs to the correction tier
 * alone, and the failure posture (an unreadable ledger holds ambient pushes
 * and only ambient pushes).
 *
 * No clock, no config and no database is stubbed here — `decidePush` takes the
 * day so far and the two gate facts as arguments precisely so the rule can be
 * asserted at any hour of any day.
 */

import { describe, expect, test } from "bun:test";

import {
  CORRECTION_EVENTS,
  decidePush,
  PUSH_DAILY_CEILING,
  type PushIntent,
  type PushLedger,
  tierFor,
  TIME_CRITICAL_EVENTS,
} from "../push-budget.js";

function ledger(
  delivered: number,
  extra: Partial<PushLedger> = {},
): PushLedger {
  return { dayKey: "2026-08-03", delivered, suppressed: 0, ...extra };
}

const ambient: PushIntent = { sourceEventName: "work_item_completed" };
const approval: PushIntent = { sourceEventName: "confirmation_request" };
const correction: PushIntent = { sourceEventName: "run.failed" };

describe("tiering", () => {
  test("a completion is ambient — design groups it with the brief", () => {
    expect(tierFor(ambient)).toBe("ambient");
    expect(tierFor({ sourceEventName: "brief.morning_ready" })).toBe("ambient");
  });

  test("a blocked tool call is time-critical", () => {
    expect(tierFor(approval)).toBe("time_critical");
  });

  test("anything carrying an inline approval is time-critical", () => {
    expect(
      tierFor({
        sourceEventName: "something.unheard.of",
        approval: { actionLabel: "Send it" },
      }),
    ).toBe("time_critical");
  });

  test("Cue reporting its own error is a correction, however it is named", () => {
    for (const name of CORRECTION_EVENTS) {
      expect(tierFor({ sourceEventName: name })).toBe("correction");
    }
    expect(
      tierFor({ sourceEventName: "anything", isSelfCorrection: true }),
    ).toBe("correction");
  });

  test("the client's time-critical vocabulary tiers the same way here", () => {
    for (const name of TIME_CRITICAL_EVENTS) {
      expect(tierFor({ sourceEventName: name })).toBe("time_critical");
    }
  });

  test("self-correction outranks an approval on the same intent", () => {
    expect(
      tierFor({
        sourceEventName: "confirmation_request",
        approval: { actionLabel: "Send it" },
        isSelfCorrection: true,
      }),
    ).toBe("correction");
  });

  test("an unknown event is ambient — the capped tier, not the exempt one", () => {
    expect(tierFor({ sourceEventName: "who.knows" })).toBe("ambient");
  });
});

describe("the ceiling", () => {
  test("design's ceiling is three", () => {
    expect(PUSH_DAILY_CEILING).toBe(3);
  });

  test("the first three ambient pushes of the day are delivered", () => {
    for (let delivered = 0; delivered < 3; delivered++) {
      const decision = decidePush(ambient, ledger(delivered), {
        quietNow: false,
      });
      expect(decision.deliver).toBe(true);
      expect(decision.countToday).toBe(delivered + 1);
    }
  });

  test("the fourth is held for the brief", () => {
    const decision = decidePush(ambient, ledger(3), { quietNow: false });
    expect(decision.deliver).toBe(false);
    expect(decision.suppressedBecause).toBe("daily_ceiling");
    // The count does not advance for a push that never went out.
    expect(decision.countToday).toBe(3);
  });

  test("a fifth, a sixth — the cap does not leak", () => {
    for (const delivered of [4, 5, 12]) {
      expect(
        decidePush(ambient, ledger(delivered), { quietNow: false }).deliver,
      ).toBe(false);
    }
  });

  test("'unless something breaks': a correction is never capped", () => {
    const decision = decidePush(correction, ledger(9), { quietNow: false });
    expect(decision.deliver).toBe(true);
    expect(decision.tier).toBe("correction");
    // Counted, so the ledger stays honest about a noisy day.
    expect(decision.countToday).toBe(10);
  });

  test("a time-critical approval is never capped either", () => {
    const decision = decidePush(approval, ledger(9), { quietNow: false });
    expect(decision.deliver).toBe(true);
    expect(decision.tier).toBe("time_critical");
  });
});

describe("quiet hours are the user's", () => {
  test("only the correction tier breaks them", () => {
    const decision = decidePush(correction, ledger(0), { quietNow: true });
    expect(decision.deliver).toBe(true);
    expect(decision.breaksQuietHours).toBe(true);
  });

  test("a time-critical approval waits — a deadline of ours is not enough", () => {
    const decision = decidePush(approval, ledger(0), { quietNow: true });
    expect(decision.deliver).toBe(false);
    expect(decision.suppressedBecause).toBe("quiet_hours");
    expect(decision.breaksQuietHours).toBe(false);
  });

  test("an ambient push waits, with room left in the budget", () => {
    const decision = decidePush(ambient, ledger(0), { quietNow: true });
    expect(decision.deliver).toBe(false);
    expect(decision.suppressedBecause).toBe("quiet_hours");
  });

  test("a correction inside quiet hours is still uncapped", () => {
    const decision = decidePush(correction, ledger(PUSH_DAILY_CEILING + 4), {
      quietNow: true,
    });
    expect(decision.deliver).toBe(true);
    expect(decision.breaksQuietHours).toBe(true);
  });
});

describe("a category the user switched off", () => {
  test("outranks every tier, including the correction", () => {
    for (const intent of [ambient, approval, correction]) {
      const decision = decidePush(intent, ledger(0), {
        quietNow: false,
        categoryEnabled: false,
      });
      expect(decision.deliver).toBe(false);
      expect(decision.suppressedBecause).toBe("category_disabled");
    }
  });
});

describe("failure posture", () => {
  test("an unreadable ledger holds ambient pushes rather than spending an unknown count", () => {
    const decision = decidePush(ambient, ledger(0, { unavailable: true }), {
      quietNow: false,
    });
    expect(decision.deliver).toBe(false);
    expect(decision.suppressedBecause).toBe("ledger_unavailable");
  });

  test("an unreadable ledger cannot silence a correction or an approval", () => {
    const broken = ledger(0, { unavailable: true });
    expect(decidePush(correction, broken, { quietNow: false }).deliver).toBe(
      true,
    );
    expect(decidePush(approval, broken, { quietNow: false }).deliver).toBe(
      true,
    );
  });
});

describe("reasons", () => {
  test("every decision carries a one-line reason", () => {
    const cases: PushDecisionCase[] = [
      [ambient, ledger(0), false],
      [ambient, ledger(PUSH_DAILY_CEILING), false],
      [ambient, ledger(0), true],
      [approval, ledger(0), false],
      [correction, ledger(0), true],
    ];
    for (const [intent, led, quietNow] of cases) {
      const reason = decidePush(intent, led, { quietNow }).reason;
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("the ceiling's reason names the real ceiling", () => {
    const decision = decidePush(ambient, ledger(PUSH_DAILY_CEILING), {
      quietNow: false,
    });
    expect(decision.reason).toContain(String(PUSH_DAILY_CEILING));
  });
});

type PushDecisionCase = [PushIntent, PushLedger, boolean];
