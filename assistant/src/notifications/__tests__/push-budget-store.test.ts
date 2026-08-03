/**
 * The durable half of the interruption budget: the count survives a restart,
 * it is scoped to the user's calendar day, and a suppressed push leaves a row
 * behind so the number can never be invented.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { pushBudgetLedger } from "../../memory/schema.js";
import { decidePush, type PushLedger } from "../push-budget.js";
import {
  listPushDecisions,
  pushDayKey,
  readPushLedger,
  recordPushDecision,
} from "../push-budget-store.js";

initializeDb();

beforeEach(() => {
  getDb().delete(pushBudgetLedger).run();
});

function record(opts: {
  dayKey: string;
  deliveredSoFar?: number;
  quietNow?: boolean;
  sourceEventName?: string;
}): void {
  const ledger: PushLedger = {
    dayKey: opts.dayKey,
    delivered: opts.deliveredSoFar ?? 0,
    suppressed: 0,
  };
  const decision = decidePush(
    { sourceEventName: opts.sourceEventName ?? "work_item_completed" },
    ledger,
    { quietNow: opts.quietNow ?? false },
  );
  recordPushDecision({
    dayKey: opts.dayKey,
    decision,
    sourceEventName: opts.sourceEventName ?? "work_item_completed",
    subjectKey: "wi:1",
  });
}

describe("the day's counts", () => {
  test("delivered and suppressed are counted separately, from real rows", () => {
    const today = pushDayKey();
    record({ dayKey: today, deliveredSoFar: 0 });
    record({ dayKey: today, deliveredSoFar: 1 });
    record({ dayKey: today, deliveredSoFar: 3 }); // over the ceiling

    const ledger = readPushLedger();
    expect(ledger.delivered).toBe(2);
    expect(ledger.suppressed).toBe(1);
    expect(ledger.unavailable).toBeUndefined();
  });

  test("yesterday's pushes do not spend today's budget", () => {
    record({ dayKey: "1999-01-01", deliveredSoFar: 0 });
    record({ dayKey: "1999-01-01", deliveredSoFar: 1 });
    expect(readPushLedger().delivered).toBe(0);
  });

  test("an empty day reads as zero, not as unavailable", () => {
    const ledger = readPushLedger();
    expect(ledger).toMatchObject({ delivered: 0, suppressed: 0 });
    expect(ledger.unavailable).toBeUndefined();
  });
});

describe("the audit behind the counts", () => {
  test("a suppressed push leaves a row carrying its tier and its reason", () => {
    const today = pushDayKey();
    record({ dayKey: today, deliveredSoFar: 5 });

    const entries = listPushDecisions();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.delivered).toBe(false);
    expect(entries[0]!.tier).toBe("ambient");
    expect(entries[0]!.reason.length).toBeGreaterThan(0);
  });

  test("a correction delivered in quiet hours is recorded as having broken them", () => {
    const today = pushDayKey();
    record({
      dayKey: today,
      quietNow: true,
      sourceEventName: "assistant.correction",
    });

    const entries = listPushDecisions();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tier).toBe("correction");
    expect(entries[0]!.delivered).toBe(true);
    expect(entries[0]!.brokeQuietHours).toBe(true);
  });

  test("delivered-only excludes what was held back", () => {
    const today = pushDayKey();
    record({ dayKey: today, deliveredSoFar: 0 });
    record({ dayKey: today, deliveredSoFar: 9 });
    expect(listPushDecisions(new Date(), { deliveredOnly: true })).toHaveLength(
      1,
    );
  });
});

describe("the day key", () => {
  test("is a calendar date", () => {
    expect(pushDayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("is stable across a single day's clock movement", () => {
    const morning = new Date();
    morning.setHours(11, 0, 0, 0);
    const evening = new Date(morning);
    evening.setHours(13, 0, 0, 0);
    expect(pushDayKey(morning)).toBe(pushDayKey(evening));
  });
});
