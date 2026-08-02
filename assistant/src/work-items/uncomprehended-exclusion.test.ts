/**
 * An arrival Cue could not read must not appear as a task.
 *
 * Design's rule: "an un-comprehended arrival stays in arrivals and never enters
 * the task list — it hasn't earned a task row." We implement that as a read
 * rule rather than by delaying the write, because comprehension is a model call
 * and intake must never block on one. The item is minted, marked, and excluded
 * from the list — relocated, never lost.
 *
 * Two rules are load-bearing and both are pinned here:
 *
 *   · `skipped` is NOT un-comprehended. It means comprehension was switched off
 *     or the arrival was not a message. Treating it as confusion would empty the
 *     whole task list the moment the feature was disabled.
 *   · Excluded is not deleted. The row survives and an explicit opt-in returns
 *     it, because the arrivals surface has to count and render these.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import {
  type ComprehensionStatus,
  recordComprehension,
} from "../arrivals/comprehension-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createWorkItem, listWorkItems } from "./work-item-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM work_item_comprehension");
});

/** Mint a work item and stamp a comprehension verdict on it. */
function itemWith(title: string, status: ComprehensionStatus | null): string {
  const task = createTask({ title, template: title });
  const item = createWorkItem({ taskId: task.id, title });
  // Written through the real store rather than raw SQL, so this test cannot
  // pass against a column set production never actually writes.
  if (status) {
    recordComprehension({ workItemId: item.id, status, originalTitle: title });
  }
  return item.id;
}

function listedTitles(opts?: Parameters<typeof listWorkItems>[0]): string[] {
  return listWorkItems(opts).map((i) => i.title);
}

describe("un-comprehended arrivals are not tasks", () => {
  test("FAILED keeps the item visible — an outage must not empty the list", () => {
    // `failed` covers timeouts, parse failures and an unreachable model. During
    // a model outage EVERY arrival fails, so hiding on `failed` would silently
    // empty the user's task list exactly when Cue is least able to explain
    // itself. Same fail-open rule as the relevance gate.
    //
    // This was a real regression: excluding `failed` broke 9 integration tests
    // that drive the real intake path with no model available — which is
    // precisely the production outage shape.
    itemWith("Reply to Rachel about the NDA", "comprehended");
    itemWith("Email from CIPA: annual return", "failed");

    expect(listedTitles().sort()).toEqual([
      "Email from CIPA: annual return",
      "Reply to Rachel about the NDA",
    ]);
  });

  test("a low-confidence reading is absent too — Cue did not understand it", () => {
    itemWith("Renew the annual return", "comprehended");
    itemWith("Email from Trip.com: 上海", "low_confidence");

    expect(listedTitles()).toEqual(["Renew the annual return"]);
  });

  test("SKIPPED is not confusion, and stays a task", () => {
    // The catastrophe this prevents: comprehension gets switched off, every
    // item is stamped `skipped`, and the user's entire task list silently
    // empties. Skipped means "not asked", not "asked and confused".
    itemWith("Chase the data room", "skipped");
    expect(listedTitles()).toEqual(["Chase the data room"]);
  });

  test("an item with no comprehension row at all is a task", () => {
    // Everything that predates comprehension, and everything created by hand.
    itemWith("Book the flights", null);
    expect(listedTitles()).toEqual(["Book the flights"]);
  });

  test("excluded is not deleted — the row is still there when asked for", () => {
    itemWith("Email from Trip.com: 上海", "low_confidence");

    expect(listWorkItems()).toHaveLength(0);
    expect(listWorkItems({ includeUnComprehended: true })).toHaveLength(1);
  });

  test("the exclusion composes with the other filters rather than replacing them", () => {
    // Drizzle's `.where()` ASSIGNS rather than appends, and this exact class of
    // bug already shipped once here: status + projectId together returned the
    // whole project. A fourth predicate is a fourth chance to make it again.
    const keep = itemWith("Queued and readable", "comprehended");
    itemWith("Queued but unreadable", "low_confidence");
    getDb().run(sql`UPDATE work_items SET status = 'done' WHERE id != ${keep}`);

    const queued = listWorkItems({ status: "queued" });
    expect(queued.map((i) => i.title)).toEqual(["Queued and readable"]);
  });
});
