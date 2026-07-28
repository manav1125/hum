/**
 * The autonomy-ledger store: the migration, best-effort append, secret
 * redaction, run attribution, the read filters, the summary math, and the
 * two-axis retention bound (age + row count).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { migrateAutonomyLedger } from "../memory/migrations/316-autonomy-ledger.js";
import { createTask } from "../tasks/task-store.js";
import { createWorkItem, updateWorkItem } from "../work-items/work-item-store.js";
import {
  __resetLedgerPruneCounterForTests,
  getAutonomyLedgerSummary,
  listAutonomyLedger,
  pruneAutonomyLedger,
  recordAutonomyLedgerEntry,
  type RecordLedgerEntryInput,
} from "./autonomy-ledger-store.js";

initializeDb();

/**
 * Re-run the ledger migration after a test deliberately drops the table.
 * `initializeDb()` alone won't do it — the completed checkpoint short-circuits
 * `withCrashRecovery` — so clear the checkpoint first.
 */
function restoreLedgerTable(): void {
  const raw = getSqliteFrom(getDb());
  raw
    .query("DELETE FROM memory_checkpoints WHERE key = ?")
    .run("migration_autonomy_ledger_v1");
  migrateAutonomyLedger(getDb());
}

beforeEach(() => {
  getDb().run("DELETE FROM autonomy_ledger");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  __resetLedgerPruneCounterForTests();
});

/** Recent timestamps — the retention sweep must not eat test fixtures. */
const NOW = Date.now();

function entry(
  overrides?: Partial<RecordLedgerEntryInput>,
): RecordLedgerEntryInput {
  return {
    toolName: "gmail__GMAIL_SEND_EMAIL",
    actionClass: "send",
    summary: "Cue sent an email to partner@acme.com (unattended).",
    target: "partner@acme.com",
    outcome: "executed",
    attended: false,
    approvedVia: "auto",
    conversationId: "conv-1",
    ...overrides,
  };
}

describe("recordAutonomyLedgerEntry", () => {
  test("the migration created the table and the row round-trips", () => {
    const written = recordAutonomyLedgerEntry(entry());
    expect(written).not.toBeNull();

    const [row] = listAutonomyLedger();
    expect(row.toolName).toBe("gmail__GMAIL_SEND_EMAIL");
    expect(row.actionClass).toBe("send");
    expect(row.target).toBe("partner@acme.com");
    expect(row.outcome).toBe("executed");
    expect(row.attended).toBe(0);
    expect(row.approvedVia).toBe("auto");
    expect(row.conversationId).toBe("conv-1");
  });

  test("secrets are redacted out of every free-text field before persisting", () => {
    recordAutonomyLedgerEntry(
      entry({
        summary: "Cue ran curl -H 'x: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH-abcdefgh'",
        reason: "failed with token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH-abcdefgh",
      }),
    );
    const [row] = listAutonomyLedger();
    expect(row.summary).not.toContain("sk-ant-api03");
    expect(row.reason).not.toContain("sk-ant-api03");
  });

  test("free text is bounded so one row can never balloon the table", () => {
    recordAutonomyLedgerEntry(entry({ summary: "x".repeat(5000) }));
    const [row] = listAutonomyLedger();
    expect(row.summary.length).toBeLessThanOrEqual(500);
  });

  test("attributes the row to the work item whose run conversation it is", () => {
    const task = createTask({ title: "t", template: "do" });
    const item = createWorkItem({
      taskId: task.id,
      title: "Email the partner",
      assignee: "Growth",
    });
    updateWorkItem(item.id, { lastRunConversationId: "run-conv" });

    recordAutonomyLedgerEntry(entry({ conversationId: "run-conv" }));
    const [row] = listAutonomyLedger();
    expect(row.workItemId).toBe(item.id);
    expect(row.agent).toBe("Growth");
  });

  test("an unattributable conversation still records the action", () => {
    recordAutonomyLedgerEntry(entry({ conversationId: "owner-chat" }));
    const [row] = listAutonomyLedger();
    expect(row.workItemId).toBeNull();
    expect(row.agent).toBeNull();
  });

  test("returns null instead of throwing when the write fails", () => {
    getSqliteFrom(getDb()).exec("DROP TABLE autonomy_ledger");
    try {
      expect(recordAutonomyLedgerEntry(entry())).toBeNull();
    } finally {
      restoreLedgerTable();
    }
  });
});

describe("listAutonomyLedger", () => {
  beforeEach(() => {
    recordAutonomyLedgerEntry(
      entry({ at: NOW - 3_000, outcome: "executed", attended: false }),
    );
    recordAutonomyLedgerEntry(
      entry({
        at: NOW - 2_000,
        outcome: "parked",
        attended: false,
        actionClass: "money",
        approvedVia: null,
      }),
    );
    recordAutonomyLedgerEntry(
      entry({ at: NOW - 1_000, outcome: "executed", attended: true }),
    );
  });

  test("newest first", () => {
    expect(listAutonomyLedger().map((r) => r.at)).toEqual([
      NOW - 1_000,
      NOW - 2_000,
      NOW - 3_000,
    ]);
  });

  test("filters by outcome, class, window and attendance", () => {
    expect(listAutonomyLedger({ outcome: "parked" })).toHaveLength(1);
    expect(listAutonomyLedger({ actionClass: "money" })).toHaveLength(1);
    expect(listAutonomyLedger({ since: NOW - 2_000 })).toHaveLength(2);
    expect(listAutonomyLedger({ unattendedOnly: true })).toHaveLength(2);
  });

  test("the limit is clamped to a sane ceiling", () => {
    expect(listAutonomyLedger({ limit: 100_000 }).length).toBeLessThanOrEqual(
      500,
    );
  });
});

describe("getAutonomyLedgerSummary", () => {
  test("counts the numbers the owner actually needs", () => {
    // Two unattended executed sends — one auto-approved (the rogue-send shape),
    // one cleared by a standing trust rule; plus a parked and a denial.
    recordAutonomyLedgerEntry(
      entry({ outcome: "executed", attended: false, approvedVia: "auto" }),
    );
    recordAutonomyLedgerEntry(
      entry({ outcome: "executed", attended: false, approvedVia: "trust_rule" }),
    );
    recordAutonomyLedgerEntry(
      entry({
        outcome: "executed",
        attended: true,
        approvedVia: "inline_card",
      }),
    );
    recordAutonomyLedgerEntry(
      entry({ outcome: "parked", attended: false, approvedVia: null }),
    );
    recordAutonomyLedgerEntry(
      entry({ outcome: "denied", attended: true, approvedVia: null }),
    );

    const summary = getAutonomyLedgerSummary({ days: 30 });
    expect(summary.total).toBe(5);
    expect(summary.executed).toBe(3);
    expect(summary.parked).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.executedUnattended).toBe(2);
    expect(summary.executedWithoutApproval).toBe(1);
    expect(summary.byClass).toEqual([{ actionClass: "send", count: 5 }]);
  });

  test("the window excludes older rows", () => {
    recordAutonomyLedgerEntry(
      entry({ at: Date.now() - 60 * 24 * 60 * 60 * 1000 }),
    );
    expect(getAutonomyLedgerSummary({ days: 30 }).total).toBe(0);
    expect(getAutonomyLedgerSummary({ days: 90 }).total).toBe(1);
  });
});

describe("retention", () => {
  test("prunes by age", () => {
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
    recordAutonomyLedgerEntry(entry({ at: old }));
    recordAutonomyLedgerEntry(entry({ at: Date.now() }));

    expect(pruneAutonomyLedger()).toBe(1);
    expect(listAutonomyLedger()).toHaveLength(1);
  });

  test("prunes by row count, newest kept", () => {
    for (let i = 0; i < 10; i += 1) {
      recordAutonomyLedgerEntry(entry({ at: NOW - 10 + i }));
    }
    pruneAutonomyLedger({ maxRows: 3 });
    const rows = listAutonomyLedger();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.at)).toEqual([NOW - 1, NOW - 2, NOW - 3]);
  });

  test("the sweep runs on the first write after process start", () => {
    __resetLedgerPruneCounterForTests(true);
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
    // Seeded through a suppressed write, then the primed write sweeps it away.
    getDb().run("DELETE FROM autonomy_ledger");
    recordAutonomyLedgerEntry(entry({ at: old }));
    expect(listAutonomyLedger({ since: 0 })).toHaveLength(0);
  });

  test("prune never throws when the table is missing", () => {
    getSqliteFrom(getDb()).exec("DROP TABLE autonomy_ledger");
    try {
      expect(pruneAutonomyLedger()).toBe(0);
    } finally {
      restoreLedgerTable();
    }
  });
});
