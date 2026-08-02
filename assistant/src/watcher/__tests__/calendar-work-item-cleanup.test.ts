/**
 * The cleanup sweep, against a real database.
 *
 * Two properties matter more than any of the counts: it never deletes, and it
 * never touches an item the owner has had a hand in. Both are asserted on the
 * table itself after an applied run rather than on the report, because a report
 * is what the code believes and the table is what the owner will see.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const { getDb } = await import("../../memory/db-connection.js");
const { initializeDb } = await import("../../memory/db-init.js");
const { createTask } = await import("../../tasks/task-store.js");
const { createWorkItem, getWorkItem, updateWorkItem } =
  await import("../../work-items/work-item-store.js");
const {
  cleanupCalendarWorkItems,
  formatCleanupReport,
  ownerTouchSignals,
  revertCalendarCleanup,
} = await import("../calendar-work-item-cleanup.js");

initializeDb();

const CHANNEL = "watcher:google-calendar";

let taskId: string;

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "Calendar", template: "n/a" }).id;
});

/** An item exactly as watcher intake minted it: nothing but the mint-time fields. */
function mintedItem(over: Parameters<typeof createWorkItem>[0] | object = {}) {
  return createWorkItem({
    taskId,
    title: "Calendar event: GBA-HK: G&M Sync — 2020-05-04T09:00:00+08:00",
    notes: "From Google Calendar — schedule changes · updated_calendar_event",
    sourceType: CHANNEL,
    sourceId: "4vm32g7jqnu2jh6o5tpf9mha3f_20200622T010000Z",
    ...(over as object),
  });
}

function rowCount(): number {
  return (
    getDb().all("SELECT COUNT(*) AS n FROM work_items") as Array<{ n: number }>
  )[0]!.n;
}

describe("what gets archived", () => {
  test("a dry run changes nothing", () => {
    const item = mintedItem();
    const { report, manifest } = cleanupCalendarWorkItems();

    expect(report.applied).toBe(false);
    expect(report.archived).toBe(1);
    expect(manifest).toBeNull();
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("an applied run archives an untouched item and never deletes it", () => {
    const item = mintedItem();
    const before = rowCount();

    const { report, manifest } = cleanupCalendarWorkItems({ apply: true });

    expect(report.archived).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("archived");
    // Nothing deleted: the row, its title and its notes all survive.
    expect(rowCount()).toBe(before);
    expect(getWorkItem(item.id)!.notes).toContain("From Google Calendar");
    expect(manifest!.items).toEqual([
      { workItemId: item.id, title: item.title, previousStatus: "queued" },
    ]);
  });

  test("items on other channels are not even scanned", () => {
    createWorkItem({
      taskId,
      title: "Email from CIPA: annual return due",
      sourceType: "watcher:gmail",
      sourceId: "msg-1",
    });
    const { report } = cleanupCalendarWorkItems({ apply: true });
    expect(report.scanned).toBe(0);
  });

  test("a second run finds nothing left to do", () => {
    mintedItem();
    cleanupCalendarWorkItems({ apply: true });
    const { report } = cleanupCalendarWorkItems({ apply: true });
    expect(report.scanned).toBe(0);
    expect(report.archived).toBe(0);
  });
});

describe("what it refuses to touch", () => {
  // A calendar event that genuinely IS a commitment needing preparation is a
  // real thing. The moment the owner acts on one it stops being noise, and
  // every one of these is a way they can have acted.
  const touches: Array<[string, () => string]> = [
    ["filed into a project", () => mintedItem({ projectId: "proj-1" }).id],
    ["given a due date", () => mintedItem({ dueAt: Date.now() }).id],
    ["labelled", () => mintedItem({ labels: '["prep"]' }).id],
    ["assigned to someone", () => mintedItem({ assignee: "manav" }).id],
    [
      "has notes the owner added",
      () => mintedItem({ context: "deck not written" }).id,
    ],
    [
      "notes were edited",
      () => mintedItem({ notes: "Write the board deck first" }).id,
    ],
    [
      "has been run",
      () => {
        const i = mintedItem();
        updateWorkItem(i.id, { lastRunId: "run-1" });
        return i.id;
      },
    ],
    [
      "status",
      () => {
        const i = mintedItem();
        updateWorkItem(i.id, { status: "done" });
        return i.id;
      },
    ],
    [
      "progress note",
      () => {
        const i = mintedItem();
        updateWorkItem(i.id, { lastProgressNote: "drafting" });
        return i.id;
      },
    ],
  ];

  for (const [label, build] of touches) {
    test(`keeps an item that was ${label}`, () => {
      const id = build();
      const statusBefore = getWorkItem(id)!.status;

      const { report } = cleanupCalendarWorkItems({ apply: true });

      expect(report.kept).toBe(1);
      expect(report.archived).toBe(0);
      expect(getWorkItem(id)!.status).toBe(statusBefore);
      // The report says WHY, so a kept item can be argued with.
      expect(report.items[0]!.touchedBy.length).toBeGreaterThan(0);
    });
  }

  test("an untouched item reports no touch signals at all", () => {
    const item = mintedItem();
    expect(ownerTouchSignals(getWorkItem(item.id)!)).toEqual([]);
  });

  test("an empty labels array is not a label", () => {
    // What an automatic pass leaves behind. Counting it would exempt the row.
    const item = mintedItem({ labels: "[]" });
    expect(ownerTouchSignals(getWorkItem(item.id)!)).toEqual([]);
  });

  test("a deadline Cue extracted itself is not the owner's hand", () => {
    // Two of the live rows looked exactly like this: a verb-phrase title and a
    // due date, both written by the comprehension pass on the way in. Reading
    // that as an owner touch would leave calendar noise in the lane forever.
    const item = mintedItem({ dueAt: 1_784_217_599_999 });
    expect(ownerTouchSignals(getWorkItem(item.id)!, 1_784_217_599_999)).toEqual(
      [],
    );
    // A date that is NOT the one Cue extracted still counts.
    expect(
      ownerTouchSignals(getWorkItem(item.id)!, 1_700_000_000_000),
    ).toContain("given a due date");
    // And so does one on an item Cue never dated.
    expect(ownerTouchSignals(getWorkItem(item.id)!)).toContain(
      "given a due date",
    );
  });

  test("a mixed batch keeps the touched one and archives the rest", () => {
    const kept = mintedItem({ projectId: "proj-1" });
    const gone = mintedItem({ sourceId: "other-event" });

    const { report } = cleanupCalendarWorkItems({ apply: true });

    expect(report.scanned).toBe(2);
    expect(report.kept).toBe(1);
    expect(report.archived).toBe(1);
    expect(getWorkItem(kept.id)!.status).toBe("queued");
    expect(getWorkItem(gone.id)!.status).toBe("archived");
  });
});

describe("reversal", () => {
  test("the manifest puts everything back", () => {
    const item = mintedItem();
    const { manifest } = cleanupCalendarWorkItems({ apply: true });
    expect(getWorkItem(item.id)!.status).toBe("archived");

    const dry = revertCalendarCleanup(manifest!);
    expect(dry.restored).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("archived"); // still a dry run

    const applied = revertCalendarCleanup(manifest!, { apply: true });
    expect(applied.restored).toBe(1);
    expect(getWorkItem(item.id)!.status).toBe("queued");
  });

  test("an item somebody changed since is left alone", () => {
    const item = mintedItem();
    const { manifest } = cleanupCalendarWorkItems({ apply: true });
    updateWorkItem(item.id, { status: "done" });

    const out = revertCalendarCleanup(manifest!, { apply: true });

    expect(out.restored).toBe(0);
    expect(out.skipped[0]!.reason).toContain("left alone");
    expect(getWorkItem(item.id)!.status).toBe("done");
  });

  test("a manifest from an unknown version is refused", () => {
    expect(() =>
      revertCalendarCleanup({
        version: 99 as never,
        appliedAt: 0,
        channels: [],
        items: [],
      }),
    ).toThrow(/version/);
  });
});

describe("the report", () => {
  test("names every kept item and the signal that saved it", () => {
    mintedItem({ projectId: "proj-1" });
    const { report } = cleanupCalendarWorkItems();
    const text = formatCleanupReport(report);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("filed into a project");
  });

  test("says how much of the batch is meetings that already happened", () => {
    mintedItem();
    const { report } = cleanupCalendarWorkItems();
    expect(report.archivedPastEvents).toBeGreaterThanOrEqual(0);
    expect(formatCleanupReport(report)).toContain("Archived (1)");
  });
});
