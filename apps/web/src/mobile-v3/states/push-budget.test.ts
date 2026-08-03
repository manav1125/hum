/**
 * K2 · The interruption budget.
 *
 * Two rules pull in opposite directions and the tests exist to hold both:
 * "three a day is the ceiling" and "unless something breaks". A cap that can
 * swallow an expiring approval is not a budget, it is a bug with a policy
 * attached — so the exemption is asserted at every hour of the quiet window and
 * well past the ceiling.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  budgetLine,
  decideAndRecordPush,
  decidePush,
  DEFAULT_QUIET_HOURS,
  isQuietHour,
  PUSH_DAILY_CEILING,
  readPushLedger,
  tierFor,
  type PushIntent,
  type PushLedger,
} from "./push-budget";

const NOON = new Date(2026, 7, 3, 12, 0, 0);
const MIDNIGHT = new Date(2026, 7, 3, 0, 30, 0);

function ledger(delivered: number): PushLedger {
  return { day: "2026-08-03", delivered, suppressed: 0 };
}

const brief: PushIntent = {
  sourceEventName: "daily_brief.ready",
  title: "Your morning brief",
  body: "4 done overnight · 7 need you",
};
const approval: PushIntent = {
  sourceEventName: "guardian_action.requested",
  title: "Acme call in 40 minutes",
  body: "The 24-month reply is drafted and waiting on you.",
  approval: { actionLabel: "Send it" },
};
const correction: PushIntent = {
  sourceEventName: "assistant.correction",
  title: "I got something wrong",
  body: "I chased Sarah about the data room — you'd already spoken to her Tuesday.",
};

beforeEach(() => {
  localStorage.clear();
});

describe("the three tiers design drew", () => {
  test("a correction is a correction", () => {
    expect(tierFor(correction)).toBe("correction");
    expect(tierFor({ ...brief, isSelfCorrection: true })).toBe("correction");
  });
  test("anything carrying an approval is time-critical", () => {
    expect(tierFor(approval)).toBe("time_critical");
  });
  test("everything else is ambient", () => {
    expect(tierFor(brief)).toBe("ambient");
  });
});

describe("quiet hours", () => {
  test("the window wraps midnight", () => {
    expect(isQuietHour(MIDNIGHT, DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isQuietHour(new Date(2026, 7, 3, 23, 0), DEFAULT_QUIET_HOURS)).toBe(
      true,
    );
    expect(isQuietHour(NOON, DEFAULT_QUIET_HOURS)).toBe(false);
  });

  test("the 7:30 brief is inside it — and design is right that it should be", () => {
    // 7:30 sits in the 22→8 window, so the brief is held. That is the rule
    // working, not a bug: the brief is ambient and the user asked for quiet.
    expect(isQuietHour(new Date(2026, 7, 3, 7, 30), DEFAULT_QUIET_HOURS)).toBe(
      true,
    );
    expect(decidePush(brief, ledger(0), {
      now: new Date(2026, 7, 3, 7, 30),
    }).deliver).toBe(false);
  });
});

describe("three a day is the ceiling", () => {
  test("the first three ambient notifications go", () => {
    for (let n = 0; n < PUSH_DAILY_CEILING; n++) {
      expect(decidePush(brief, ledger(n), { now: NOON }).deliver).toBe(true);
    }
  });

  test("the fourth does not, and says why", () => {
    const d = decidePush(brief, ledger(PUSH_DAILY_CEILING), { now: NOON });
    expect(d.deliver).toBe(false);
    expect(d.reason).toContain("the rest waits for the brief");
  });
});

describe("…unless something breaks", () => {
  test("a correction gets through at 3am, ten notifications deep", () => {
    const d = decidePush(correction, ledger(10), { now: MIDNIGHT });
    expect(d.deliver).toBe(true);
    expect(d.breaksQuietHours).toBe(true);
    expect(d.tier).toBe("correction");
  });

  test("a time-critical approval is never capped either", () => {
    const d = decidePush(approval, ledger(99), { now: MIDNIGHT });
    expect(d.deliver).toBe(true);
  });

  test("the approval carries its inline action — Send it, on the notification", () => {
    expect(decidePush(approval, ledger(0), { now: NOON }).inlineAction).toBe(
      "Send it",
    );
    // Ambient never gets one: there is nothing to answer.
    expect(decidePush(brief, ledger(0), { now: NOON }).inlineAction).toBeNull();
  });

  test("no hour of the day can silence a correction", () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(2026, 7, 3, hour, 0);
      expect(decidePush(correction, ledger(50), { now }).deliver).toBe(true);
    }
  });
});

describe("the ledger is real, so the line on the lock screen is not invented", () => {
  test("delivering records, suppressing records separately", () => {
    decideAndRecordPush(brief, { now: NOON });
    expect(readPushLedger(NOON).delivered).toBe(1);

    for (let i = 0; i < 5; i++) decideAndRecordPush(brief, { now: NOON });
    const led = readPushLedger(NOON);
    expect(led.delivered).toBe(PUSH_DAILY_CEILING);
    expect(led.suppressed).toBe(3);
  });

  test("a new day is a new budget", () => {
    for (let i = 0; i < 5; i++) decideAndRecordPush(brief, { now: NOON });
    const tomorrow = new Date(2026, 7, 4, 12, 0);
    expect(readPushLedger(tomorrow).delivered).toBe(0);
  });

  test("the line states the real count, and admits when the day went over", () => {
    expect(budgetLine(ledger(3))).toBe(
      "3 notifications today · that's the limit unless something breaks",
    );
    expect(budgetLine(ledger(1))).toContain("1 notification today");
    expect(budgetLine(ledger(5))).toContain("because something broke");
  });
});
