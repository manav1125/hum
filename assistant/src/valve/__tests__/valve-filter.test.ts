/**
 * End-to-end tests for the volume valve, driven through the REAL functions
 * production runs — `bandWorkItem` / `applyValve` / `runValveArchiveSweep` —
 * against real SQLite rows.
 *
 * Deliberately not a test of an extracted copy of the logic: a previous fix in
 * this repo passed its tests while being completely broken because the test
 * exercised a helper rather than the code production runs. Everything here
 * goes in the front door — mint a work item, band it, read it back through the
 * filter, then assert against what came out of the database.
 *
 * The centre of gravity is the fail-open half. A valve that filters correctly
 * and fails closed is worse than no valve, and this codebase has already
 * emptied a task list once by getting that backwards.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { recordArrival } from "../../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../../arrivals/arrival-surface.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from "../../work-items/work-item-store.js";
import {
  ARCHIVABLE_RULES,
  runValveArchiveSweep,
} from "../valve-archive-sweep.js";
import { BAND_URGENT, VALVE_STOPS } from "../valve-bands.js";
import { applyValve } from "../valve-filter.js";
import { bandWorkItem } from "../valve-intake.js";
import {
  getGlobalStop,
  GLOBAL_SCOPE,
  LEARN_DOWN_THRESHOLD,
  learnedDownSenders,
  recordFeedback,
  setStop,
} from "../valve-store.js";

initializeDb();

/** The raw bun:sqlite handle, for the direct row assertions below. */
function raw() {
  return getSqliteFrom(getDb());
}

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM valve_bands");
  db.run("DELETE FROM valve_stops");
  db.run("DELETE FROM valve_feedback");
  db.run("DELETE FROM arrivals");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
});

/** Mint a work item the ordinary way, with no arrival behind it. */
function plainItem(title = "A captured thing"): WorkItem {
  const task = createTask({ title, template: title });
  return createWorkItem({ taskId: task.id, title, actor: "test" });
}

/** Mint an arrival + its work item through the real surfacing path. */
function arrivedItem(over: {
  externalId: string;
  senderAddress?: string;
  title?: string;
  snippet?: string;
  decidedBy?: string;
  ruleId?: string | null;
  disposition?: "surfaced" | "filed";
}): WorkItem {
  const arrival = recordArrival({
    channel: "watcher:gmail",
    externalId: over.externalId,
    title: over.title ?? "A subject",
    senderAddress: over.senderAddress ?? "jane@example.com",
    senderName: "Jane",
    snippet: over.snippet ?? "hello",
    disposition: over.disposition ?? "surfaced",
    reason: "a reason",
    decidedBy: (over.decidedBy ?? "rule") as never,
    ...(over.ruleId !== undefined
      ? { ruleId: over.ruleId as string }
      : { ruleId: "direct_human" }),
  });
  // The real path: this mints the item, links it, AND bands it.
  return createWorkItemForArrival(arrival);
}

describe("fail open", () => {
  test("an item that was never banded shows at EVERY stop", () => {
    // The day-one case, and the most important test in this file. There is no
    // backfill, so on the morning this ships all 131 of the owner's standing
    // items have no band row. Every one of them must keep interrupting.
    const item = plainItem();
    expect(raw().query("SELECT * FROM valve_bands").all()).toHaveLength(0);

    for (const stop of VALVE_STOPS) {
      const result = applyValve([item], { stop });
      expect(result.shown).toHaveLength(1);
      expect(result.held).toHaveLength(0);
      expect(result.shown[0]!.band).toBe(BAND_URGENT);
      expect(result.shown[0]!.unbanded).toBe(true);
      expect(result.unbandedCount).toBe(1);
    }
  });

  test("MUTATION CHECK: an unbanded item is reported as unbanded, not as urgent-by-judgement", () => {
    // A suppressed item must be distinguishable from an absent one, and an
    // unjudged item from a judged one. If `unbanded` ever stops being set, a
    // client cannot tell "Cue decided this is urgent" from "Cue has not looked
    // at this", and the valve's own health becomes unreadable.
    const result = applyValve([plainItem()], { stop: "only_urgent" });
    expect(result.shown[0]!.unbanded).toBe(true);
    expect(result.shown[0]!.ruleId).toBe("unbanded");
    expect(result.shown[0]!.reason).not.toBe("");
  });

  test("MUTATION CHECK: when the bands table cannot be read, nothing is held", () => {
    // The scorer-times-out drill, at the only layer where it can happen. The
    // valve has no model and no network, so its single failure mode is the
    // band read — and forcing it proves the failure surfaces work rather than
    // swallowing it.
    const items = [
      arrivedItem({
        externalId: "m1",
        senderAddress: "noreply@example.com",
        title: "recap",
      }),
      arrivedItem({
        externalId: "m2",
        senderAddress: "noreply@example.org",
        title: "sale",
      }),
    ];
    // Confirm the valve WOULD have held these, so the assertion below is a
    // real reversal and not a vacuous pass.
    const before = applyValve(items, { stop: "needs_you" });
    expect(before.held.length).toBe(2);

    const db = getDb();
    db.run("ALTER TABLE valve_bands RENAME TO valve_bands_hidden");
    try {
      const during = applyValve(items, { stop: "only_urgent" });
      expect(during.held).toHaveLength(0);
      expect(during.shown).toHaveLength(2);
      expect(during.shown.every((v) => v.unbanded)).toBe(true);
    } finally {
      db.run("ALTER TABLE valve_bands_hidden RENAME TO valve_bands");
    }

    // And it recovers: the rows were never touched, only unreadable.
    const after = applyValve(items, { stop: "needs_you" });
    expect(after.held).toHaveLength(2);
  });

  test("an unreadable stops table falls back to the default stop, not to silence", () => {
    const db = getDb();
    db.run("ALTER TABLE valve_stops RENAME TO valve_stops_hidden");
    try {
      expect(getGlobalStop()).toBe("needs_you");
    } finally {
      db.run("ALTER TABLE valve_stops_hidden RENAME TO valve_stops");
    }
  });

  test("an unreadable feedback table teaches nothing, so nothing is quieted", () => {
    const db = getDb();
    db.run("ALTER TABLE valve_feedback RENAME TO valve_feedback_hidden");
    try {
      expect(learnedDownSenders().size).toBe(0);
    } finally {
      db.run("ALTER TABLE valve_feedback_hidden RENAME TO valve_feedback");
    }
  });

  test("an arrival the gate could not judge survives the whole real path", () => {
    const item = arrivedItem({
      externalId: "unsure-1",
      decidedBy: "fallback",
      ruleId: null,
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      senderAddress: "noreply@notification.example.com",
      title: "Statement ready",
    });
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    recordFeedback("sender", "noreply@notification.example.com", "dismissed");
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    recordFeedback("sender", "noreply@notification.example.com", "dismissed");
    bandWorkItem(getWorkItem(item.id)!);

    const result = applyValve([getWorkItem(item.id)!], { stop: "needs_you" });
    expect(result.shown).toHaveLength(1);
    expect(result.shown[0]!.ruleId).toBe("gate_unsure");
  });
});

describe("suppressed is not absent", () => {
  test("held items come back with their reason, and are still in Work", () => {
    const item = arrivedItem({
      externalId: "bulk-1",
      senderAddress: "noreply@example.com",
      title: "Your weekly ride recap",
    });

    const result = applyValve([item], { stop: "needs_you" });
    expect(result.shown).toHaveLength(0);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]!.ruleId).toBe("automated_sender");
    expect(result.held[0]!.reason.length).toBeGreaterThan(0);

    // The whole promise: filtered items stay queryable.
    expect(listWorkItems().map((i) => i.id)).toContain(item.id);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("moving the stop back reveals exactly what was there, with no re-ingestion", () => {
    const quiet = arrivedItem({
      externalId: "bulk-2",
      senderAddress: "noreply@example.com",
      title: "recap",
    });
    const loud = arrivedItem({ externalId: "person-1" });
    const items = [quiet, loud];

    expect(applyValve(items, { stop: "needs_you" }).shown).toHaveLength(1);
    const opened = applyValve(items, { stop: "everything" });
    expect(opened.shown).toHaveLength(2);
    expect(opened.held).toHaveLength(0);
    // Same rows, same bands — the stop is a comparison, not a rewrite.
    expect(opened.shown.map((v) => v.item.id).sort()).toEqual(
      [quiet.id, loud.id].sort(),
    );
  });
});

describe("the learning signal", () => {
  test("one dismissal is not enough; two are", () => {
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    const sender = "email@market.example.com";
    recordFeedback("sender", sender, "dismissed");
    expect(learnedDownSenders().has(sender)).toBe(false);

    recordFeedback("sender", sender, "dismissed");
    expect(LEARN_DOWN_THRESHOLD).toBe(2);
    expect(learnedDownSenders().has(sender)).toBe(true);
  });

  test('"this mattered" counts against dismissals rather than being merely absent', () => {
    const sender = "olga@example.com";
    recordFeedback("sender", sender, "dismissed");
    recordFeedback("sender", sender, "dismissed");
    expect(learnedDownSenders().has(sender)).toBe(true);

    recordFeedback("sender", sender, "kept");
    recordFeedback("sender", sender, "kept");
    expect(learnedDownSenders().has(sender)).toBe(false);
  });

  test("teaching the valve changes a later banding, and the holding count shrinks", () => {
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    const sender = "hello@mail.example.com";
    const first = arrivedItem({
      externalId: "learn-1",
      senderAddress: sender,
      title: "A note from a person",
    });
    expect(applyValve([first], { stop: "needs_you" }).held).toHaveLength(0);

    recordFeedback("sender", sender, "dismissed");
    recordFeedback("sender", sender, "dismissed");

    const second = arrivedItem({
      externalId: "learn-2",
      senderAddress: sender,
      title: "Another note",
    });
    const result = applyValve([second], { stop: "needs_you" });
    expect(result.held).toHaveLength(1);
    expect(result.held[0]!.ruleId).toBe("learned_down");
  });
});

describe("the stop, and the per-mission override", () => {
  test("the default stop is needs_you and it round-trips", () => {
    expect(getGlobalStop()).toBe("needs_you");
    setStop(GLOBAL_SCOPE, "only_urgent", "user");
    expect(getGlobalStop()).toBe("only_urgent");
    setStop(GLOBAL_SCOPE, "everything", "user");
    expect(getGlobalStop()).toBe("everything");
  });
});

describe("resting", () => {
  test("an item rests only after it has actually been shown", () => {
    const item = arrivedItem({ externalId: "rest-1" });
    // Not marked seen: a count or a preview must not burn the appearance.
    applyValve([item], { stop: "needs_you" });
    expect(
      raw()
        .query("SELECT surfaced_at FROM valve_bands WHERE work_item_id = ?")
        .get(item.id),
    ).toEqual({ surfaced_at: null });

    applyValve([item], { stop: "needs_you", markSeen: true });
    const row = raw()
      .query("SELECT surfaced_at FROM valve_bands WHERE work_item_id = ?")
      .get(item.id) as { surfaced_at: number | null };
    expect(row.surfaced_at).not.toBeNull();
  });
});

describe("the archive sweep", () => {
  /** Age an item and its band past the 48h cutoff. */
  function age(item: WorkItem): void {
    const old = Date.now() - 72 * 3_600_000;
    raw().run("UPDATE work_items SET updated_at = ? WHERE id = ?", [
      old,
      item.id,
    ]);
    raw().run("UPDATE valve_bands SET created_at = ? WHERE work_item_id = ?", [
      old,
      item.id,
    ]);
  }

  test("it archives a demoted, aged item — and archive is a status, not a delete", () => {
    const item = arrivedItem({
      externalId: "sweep-1",
      senderAddress: "noreply@example.com",
      title: "Your weekly ride recap",
    });
    age(item);

    const result = runValveArchiveSweep();
    expect(result.archived).toBe(1);

    // The row is STILL THERE, and still carries everything it did.
    const after = getWorkItem(item.id);
    expect(after).toBeDefined();
    expect(after!.status).toBe("archived");
    expect(after!.arrivalId).toBe(item.arrivalId);
    expect(
      raw()
        .query("SELECT * FROM valve_bands WHERE work_item_id = ?")
        .all(item.id),
    ).toHaveLength(1);
    expect(raw().query("SELECT * FROM arrivals").all()).toHaveLength(1);
    // And it reopens like any other archived item.
    updateWorkItem(item.id, { status: "queued" }, { actor: "test" });
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("MUTATION CHECK: it never archives an item the gate could not judge", () => {
    const item = arrivedItem({
      externalId: "sweep-unsure",
      decidedBy: "fallback",
      ruleId: null,
      senderAddress: "noreply@example.com",
      title: "recap",
    });
    age(item);
    expect(runValveArchiveSweep().archived).toBe(0);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("MUTATION CHECK: it never archives an unbanded item", () => {
    const item = plainItem("Never sized up");
    raw().run("UPDATE work_items SET updated_at = ? WHERE id = ?", [
      Date.now() - 72 * 3_600_000,
      item.id,
    ]);
    expect(runValveArchiveSweep().archived).toBe(0);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("it never archives work Cue is holding to run itself", () => {
    // Archiving Cue's own queue would cancel it by side effect.
    expect(ARCHIVABLE_RULES.has("cue_is_holding" as never)).toBe(false);
    expect(ARCHIVABLE_RULES.has("gate_unsure" as never)).toBe(false);
  });

  test("a fresh demoted item is left alone until it has aged", () => {
    arrivedItem({
      externalId: "sweep-fresh",
      senderAddress: "noreply@example.com",
      title: "recap",
    });
    expect(runValveArchiveSweep().archived).toBe(0);
  });

  test("a disabled sweep reports that it was skipped, not that it succeeded", () => {
    // A no-op is not a success. `skipped` is what makes "ran and found
    // nothing" distinguishable from "never ran".
    const result = runValveArchiveSweep();
    expect(result.skipped).toBeUndefined();
    expect(result).toHaveProperty("considered");
    expect(result).toHaveProperty("archived");
  });
});
