/**
 * The write path, driven end to end.
 *
 * These tests do NOT stub the composer. `ensureRitualSnapshots` runs the real
 * `buildMorningBrief` — the same function `GET /brief/morning` serves — over
 * real work items in a real database, and the assertion is that the row that
 * lands carries the figures those items produced. A unit test of the writer
 * would pass just as happily with nothing wired to it.
 *
 * The other property under test is the one that cannot be added later:
 * **no backfill.** An instance whose history predates the store shows no rows
 * for that history, only for the periods actually composed since.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { recordAgentAct } from "../work-items/agent-act-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import { isoWeekKey, weekdayOfDateKey } from "./ritual-compose.js";
import {
  ensureRitualSnapshots,
  isWeeklyWindow,
} from "./ritual-snapshot-job.js";
import {
  type BriefSnapshotFacts,
  listRitualSnapshots,
  type WeeklySnapshotFacts,
} from "./ritual-snapshot-store.js";

initializeDb();

const DAY_MS = 86_400_000;

beforeEach(() => {
  getDb().run("DELETE FROM ritual_snapshots");
  getDb().run("DELETE FROM ritual_snapshot_reads");
  getDb().run("DELETE FROM work_item_events");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM agent_acts");
  getDb().run("DELETE FROM tasks");
});

/** A work item that finished, so the brief has something real to report. */
function finishedItem(title: string, status: "done" | "awaiting_review") {
  const task = createTask({ title, template: "do" });
  const item = createWorkItem({ taskId: task.id, title });
  updateWorkItem(item.id, { status });
  return item;
}

/** Monday 17 Aug 2026, 09:00 in the daemon's own timezone — past 07:30. */
function mondayMorning(): Date {
  return new Date(2026, 7, 17, 9, 0, 0, 0);
}

/** Friday 21 Aug 2026, 13:00 local — inside the weekly's window. */
function fridayAfternoon(): Date {
  return new Date(2026, 7, 21, 13, 0, 0, 0);
}

describe("ensureRitualSnapshots — the real compose path", () => {
  test("composes today's brief from live work items and keeps it", async () => {
    finishedItem("Draft the Q3 note", "done");
    finishedItem("Renew the domain", "done");
    finishedItem("Sign off the invoice", "awaiting_review");

    const now = mondayMorning();
    const result = await ensureRitualSnapshots(now);
    expect(result.written).toContain("brief");

    const rows = listRitualSnapshots({ ritual: "brief" });
    expect(rows).toHaveLength(1);

    const facts = rows[0]!.facts as BriefSnapshotFacts;
    // The figures came from the items above, not from a fixture.
    expect(facts.done).toBe(2);
    expect(facts.needsYou).toBeGreaterThanOrEqual(1);
    // …and the sentence was composed FROM those figures.
    expect(rows[0]!.headline).toBe("While you slept, Cue finished two things.");
    expect(rows[0]!.periodKey).toBe("2026-08-17");
    expect(rows[0]!.periodEnd).toBeGreaterThan(rows[0]!.periodStart);
  });

  test("a quiet night is still a finding, and is still kept", async () => {
    const result = await ensureRitualSnapshots(mondayMorning());
    expect(result.written).toContain("brief");
    const rows = listRitualSnapshots({ ritual: "brief" });
    expect(rows[0]!.headline).toBe("All quiet overnight.");
    expect((rows[0]!.facts as BriefSnapshotFacts).done).toBe(0);
  });

  test("the first compose of the day wins — a later tick cannot rewrite it", async () => {
    finishedItem("Draft the Q3 note", "done");
    await ensureRitualSnapshots(mondayMorning());

    finishedItem("Something else entirely", "done");
    const second = await ensureRitualSnapshots(
      new Date(2026, 7, 17, 22, 0, 0, 0),
    );

    expect(second.written).toEqual([]);
    const rows = listRitualSnapshots({ ritual: "brief" });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.facts as BriefSnapshotFacts).done).toBe(1);
  });

  test("nothing is written before the brief's own hour", async () => {
    finishedItem("Draft the Q3 note", "done");
    const result = await ensureRitualSnapshots(
      new Date(2026, 7, 17, 0, 5, 0, 0),
    );
    expect(result.written).toEqual([]);
    expect(listRitualSnapshots()).toEqual([]);
  });

  test("the weekly is composed inside its window, with its two numbers", async () => {
    // Two things that moved: an act, and an item the owner cleared themselves.
    recordAgentAct({ kind: "run_completed", agent: "cue" });
    const cleared = finishedItem("Filed the receipts", "done");
    updateWorkItem(cleared.id, { completedElsewhere: 1 });

    // One that slipped: overdue by two days.
    const task = createTask({ title: "Overdue thing", template: "do" });
    createWorkItem({
      taskId: task.id,
      title: "Overdue thing",
      dueAt: fridayAfternoon().getTime() - 2 * DAY_MS,
    });

    const result = await ensureRitualSnapshots(fridayAfternoon());
    expect(result.written).toContain("weekly");

    const rows = listRitualSnapshots({ ritual: "weekly" });
    expect(rows).toHaveLength(1);
    const facts = rows[0]!.facts as WeeklySnapshotFacts;
    expect(facts.moved).toBe(2);
    expect(facts.slipped).toBe(1);
    expect(rows[0]!.headline).toBe("Two things moved. One slipped.");
    expect(rows[0]!.periodKey).toBe(isoWeekKey("2026-08-21"));
  });

  test("no weekly outside its window", async () => {
    const result = await ensureRitualSnapshots(mondayMorning());
    expect(result.written).not.toContain("weekly");
    expect(listRitualSnapshots({ ritual: "weekly" })).toEqual([]);
  });
});

describe("no backfill", () => {
  test("history that predates the store produces no rows for it", async () => {
    // An instance that has been running for months: work finished long before
    // anything was ever kept.
    const old = finishedItem("Shipped in June", "done");
    const twoMonthsAgo = Date.now() - 60 * DAY_MS;
    getDb().run(
      `UPDATE work_items SET updated_at = ${twoMonthsAgo}, created_at = ${twoMonthsAgo} WHERE id = '${old.id}'`,
    );
    getDb().run(`UPDATE work_item_events SET at = ${twoMonthsAgo}`);

    // Before anything is composed, the log is empty — not "reconstructed".
    expect(listRitualSnapshots()).toEqual([]);

    await ensureRitualSnapshots(mondayMorning());

    // Exactly one row, dated today. Nothing for June, nothing for last week.
    const rows = listRitualSnapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.periodKey).toBe("2026-08-17");
    // …and it does not claim June's work as overnight news.
    expect((rows[0]!.facts as BriefSnapshotFacts).done).toBe(0);
  });
});

describe("period keys", () => {
  test("ISO week keys put Friday and the weekend in the same week", () => {
    expect(isoWeekKey("2026-08-21")).toBe(isoWeekKey("2026-08-23"));
    expect(isoWeekKey("2026-08-21")).not.toBe(isoWeekKey("2026-08-24"));
  });

  test("weekday is read off the key, not off a local Date", () => {
    expect(weekdayOfDateKey("2026-08-17")).toBe(1); // Monday
    expect(weekdayOfDateKey("2026-08-21")).toBe(5); // Friday
  });

  test("the weekly window is Friday from noon, then the weekend", () => {
    expect(isWeeklyWindow("2026-08-21", 11 * 60)).toBe(false);
    expect(isWeeklyWindow("2026-08-21", 12 * 60)).toBe(true);
    expect(isWeeklyWindow("2026-08-22", 9 * 60)).toBe(true); // Saturday
    expect(isWeeklyWindow("2026-08-23", 9 * 60)).toBe(true); // Sunday
    expect(isWeeklyWindow("2026-08-17", 15 * 60)).toBe(false); // Monday
  });
});
