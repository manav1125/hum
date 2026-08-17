/**
 * The store's two load-bearing properties: one row per ritual-period with the
 * FIRST compose winning, and a log that starts empty and stays empty until
 * something is actually composed (no backfill entry point exists).
 *
 * Read-state is exercised here too — it rides on the snapshot rather than on
 * a read-receipt store of its own, and it is keyed by device so a Mac and a
 * phone are allowed to disagree.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getPreviousRitualSnapshot,
  getRitualSnapshot,
  getRitualSnapshotByPeriod,
  getRitualSnapshotReadAt,
  getRitualSnapshotStoreStartedAt,
  isRitualKind,
  listReadSnapshotIdsForDevice,
  listRitualSnapshots,
  markRitualSnapshotRead,
  recordRitualSnapshot,
} from "./ritual-snapshot-store.js";

initializeDb();

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 17, 7, 30); // Mon 17 Aug 2026, 07:30 UTC

beforeEach(() => {
  getDb().run("DELETE FROM ritual_snapshots");
  getDb().run("DELETE FROM ritual_snapshot_reads");
});

function brief(periodKey: string, composedAt: number, done: number) {
  return recordRitualSnapshot({
    ritual: "brief" as const,
    periodKey,
    periodStart: composedAt - DAY,
    periodEnd: composedAt,
    composedAt,
    headline: `While you slept, Cue finished ${done} things.`,
    facts: {
      done,
      review: 0,
      needsYou: 0,
      dayEntries: 0,
      calendarAvailable: false,
    },
  });
}

describe("recordRitualSnapshot", () => {
  test("writes a row and reads it back with its figures intact", () => {
    const { snapshot, written } = brief("2026-08-17", T0, 4);
    expect(written).toBe(true);
    expect(snapshot.ritual).toBe("brief");
    expect(snapshot.periodKey).toBe("2026-08-17");

    const stored = getRitualSnapshot(snapshot.id);
    expect(stored).not.toBeNull();
    expect(stored!.headline).toBe("While you slept, Cue finished 4 things.");
    expect((stored!.facts as { done: number }).done).toBe(4);
  });

  test("the FIRST compose of a period wins — a later one cannot rewrite it", () => {
    brief("2026-08-17", T0, 4);
    const second = brief("2026-08-17", T0 + 12 * 3_600_000, 99);

    expect(second.written).toBe(false);
    // The row returned is the morning's, not the evening's.
    expect(second.snapshot.composedAt).toBe(T0);
    expect((second.snapshot.facts as { done: number }).done).toBe(4);
    expect(listRitualSnapshots()).toHaveLength(1);
  });

  test("different periods and different rituals are separate rows", () => {
    brief("2026-08-17", T0, 1);
    brief("2026-08-18", T0 + DAY, 2);
    recordRitualSnapshot({
      ritual: "weekly",
      periodKey: "2026-W34",
      periodStart: T0 - 7 * DAY,
      periodEnd: T0,
      composedAt: T0,
      headline: "Nine things moved. Two slipped.",
      facts: { moved: 9, slipped: 2 },
    });

    expect(listRitualSnapshots()).toHaveLength(3);
    expect(listRitualSnapshots({ ritual: "weekly" })).toHaveLength(1);
    expect(getRitualSnapshotByPeriod("brief", "2026-08-18")?.headline).toBe(
      "While you slept, Cue finished 2 things.",
    );
  });

  test("listing is newest first", () => {
    brief("2026-08-17", T0, 1);
    brief("2026-08-19", T0 + 2 * DAY, 3);
    brief("2026-08-18", T0 + DAY, 2);
    expect(listRitualSnapshots().map((s) => s.periodKey)).toEqual([
      "2026-08-19",
      "2026-08-18",
      "2026-08-17",
    ]);
  });
});

describe("no backfill", () => {
  test("an empty store reports no start date and no rows", () => {
    expect(listRitualSnapshots()).toEqual([]);
    expect(getRitualSnapshotStoreStartedAt()).toBeNull();
  });

  test("storeStartedAt is the oldest thing actually kept, never earlier", () => {
    brief("2026-08-18", T0 + DAY, 1);
    brief("2026-08-17", T0, 1);
    expect(getRitualSnapshotStoreStartedAt()).toBe(T0);
  });
});

describe("getPreviousRitualSnapshot", () => {
  test("gives the weekly before this one, so a claim can be a comparison", () => {
    recordRitualSnapshot({
      ritual: "weekly",
      periodKey: "2026-W33",
      periodStart: T0 - 14 * DAY,
      periodEnd: T0 - 7 * DAY,
      composedAt: T0 - 7 * DAY,
      headline: "Five things moved. Four slipped.",
      facts: { moved: 5, slipped: 4 },
    });
    const current = recordRitualSnapshot({
      ritual: "weekly",
      periodKey: "2026-W34",
      periodStart: T0 - 7 * DAY,
      periodEnd: T0,
      composedAt: T0,
      headline: "Nine things moved. Two slipped.",
      facts: { moved: 9, slipped: 2 },
    }).snapshot;

    const prev = getPreviousRitualSnapshot("weekly", current.composedAt);
    expect(prev?.periodKey).toBe("2026-W33");
    expect((prev!.facts as { slipped: number }).slipped).toBe(4);
  });

  test("null on the first week — a caller must not invent a direction", () => {
    const only = recordRitualSnapshot({
      ritual: "weekly",
      periodKey: "2026-W34",
      periodStart: T0 - 7 * DAY,
      periodEnd: T0,
      composedAt: T0,
      headline: "A quiet week.",
      facts: { moved: 0, slipped: 0 },
    }).snapshot;
    expect(getPreviousRitualSnapshot("weekly", only.composedAt)).toBeNull();
  });
});

describe("read-state rides on the snapshot", () => {
  test("is per device — one device reading does not mark the other", () => {
    const id = brief("2026-08-17", T0, 1).snapshot.id;
    markRitualSnapshotRead(id, "phone", T0 + 1000);

    expect(getRitualSnapshotReadAt(id, "phone")).toBe(T0 + 1000);
    expect(getRitualSnapshotReadAt(id, "mac")).toBeNull();
    expect(listReadSnapshotIdsForDevice("phone")).toEqual(new Set([id]));
    expect(listReadSnapshotIdsForDevice("mac").size).toBe(0);
  });

  test("re-reading does not move the first-read timestamp", () => {
    const id = brief("2026-08-17", T0, 1).snapshot.id;
    markRitualSnapshotRead(id, "phone", T0 + 1000);
    markRitualSnapshotRead(id, "phone", T0 + 90_000);
    expect(getRitualSnapshotReadAt(id, "phone")).toBe(T0 + 1000);
  });
});

describe("isRitualKind", () => {
  test("accepts the two rituals and nothing else", () => {
    expect(isRitualKind("brief")).toBe(true);
    expect(isRitualKind("weekly")).toBe(true);
    expect(isRitualKind("monthly")).toBe(false);
  });
});
