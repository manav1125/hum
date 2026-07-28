/**
 * Round-trip tests for the autonomy-ledger read: newest-first entries, the
 * filters, the window, and the summary numbers the owner cares about.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetLedgerPruneCounterForTests,
  recordAutonomyLedgerEntry,
  type RecordLedgerEntryInput,
} from "../../ledger/autonomy-ledger-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { ROUTES } from "./autonomy-ledger-routes.js";
import { BadRequestError } from "./errors.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM autonomy_ledger");
  __resetLedgerPruneCounterForTests();
});

const route = ROUTES.find((r) => r.operationId === "getAutonomyLedger")!;

function get(queryParams?: Record<string, string>) {
  return route.handler({ queryParams }) as {
    entries: Array<Record<string, unknown>>;
    summary: Record<string, unknown>;
    window: { days: number; from: number };
  };
}

function seed(overrides?: Partial<RecordLedgerEntryInput>): void {
  recordAutonomyLedgerEntry({
    toolName: "gmail__GMAIL_SEND_EMAIL",
    actionClass: "send",
    summary: "Cue sent an email to partner@acme.com (unattended).",
    target: "partner@acme.com",
    outcome: "executed",
    attended: false,
    approvedVia: "auto",
    conversationId: "conv-1",
    ...overrides,
  });
}

describe("GET ledger/autonomy", () => {
  test("is registered scope-less under ledger/autonomy", () => {
    expect(route.endpoint).toBe("ledger/autonomy");
    expect(route.method).toBe("GET");
  });

  test("returns an empty ledger honestly", () => {
    const payload = get();
    expect(payload.entries).toEqual([]);
    expect(payload.summary.total).toBe(0);
    expect(payload.window.days).toBe(30);
  });

  test("returns entries newest first with the summary rollup", () => {
    const now = Date.now();
    seed({ at: now - 3_000 });
    seed({ at: now - 2_000, outcome: "parked", approvedVia: null });
    seed({
      at: now - 1_000,
      attended: true,
      approvedVia: "inline_card",
      actionClass: "money",
    });

    const payload = get();
    expect(payload.entries.map((e) => e.at)).toEqual([
      now - 1_000,
      now - 2_000,
      now - 3_000,
    ]);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.executed).toBe(2);
    expect(payload.summary.parked).toBe(1);
    // The headline: one action ran unattended, and nobody approved it.
    expect(payload.summary.executedUnattended).toBe(1);
    expect(payload.summary.executedWithoutApproval).toBe(1);
    expect(payload.summary.byClass).toEqual([
      { actionClass: "send", count: 2 },
      { actionClass: "money", count: 1 },
    ]);
  });

  test("filters by outcome, class and attendance", () => {
    seed({ outcome: "executed", attended: true });
    seed({ outcome: "parked", attended: false, actionClass: "money" });

    expect(get({ outcome: "parked" }).entries).toHaveLength(1);
    expect(get({ actionClass: "money" }).entries).toHaveLength(1);
    expect(get({ unattendedOnly: "true" }).entries).toHaveLength(1);
    expect(get({ unattendedOnly: "false" }).entries).toHaveLength(2);
  });

  test("the window bounds both the entries and the summary", () => {
    seed({ at: Date.now() - 60 * 24 * 60 * 60 * 1000 });
    seed();

    expect(get({ days: "30" }).entries).toHaveLength(1);
    expect(get({ days: "30" }).summary.total).toBe(1);
    expect(get({ days: "90" }).entries).toHaveLength(2);
  });

  test("rejects nonsense query params instead of guessing", () => {
    expect(() => get({ days: "-1" })).toThrow(BadRequestError);
    expect(() => get({ limit: "abc" })).toThrow(BadRequestError);
    expect(() => get({ outcome: "exploded" })).toThrow(BadRequestError);
    expect(() => get({ actionClass: "nonsense" })).toThrow(BadRequestError);
  });

  test("honours the limit", () => {
    for (let i = 0; i < 5; i += 1) seed({ at: Date.now() - i });
    expect(get({ limit: "2" }).entries).toHaveLength(2);
  });
});
