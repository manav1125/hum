/**
 * The archive's read contract: real rows, newest first, and an honest
 * `storeStartedAt` so an empty list can be told apart from "the rituals never
 * ran". The route never composes — a period with no row returns no row.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { recordRitualSnapshot } from "../../rituals/ritual-snapshot-store.js";
import { ROUTES } from "./ritual-snapshot-routes.js";

initializeDb();

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 17, 7, 30);

beforeEach(() => {
  getDb().run("DELETE FROM ritual_snapshots");
});

function list(queryParams: Record<string, string> = {}) {
  const route = ROUTES.find(
    (r) => r.endpoint === "rituals/snapshots" && r.method === "GET",
  );
  if (!route) throw new Error("route not found");
  return route.handler({ queryParams, headers: {} }) as {
    snapshots: Array<{
      id: string;
      ritual: string;
      periodKey: string;
      headline: string;
      facts: Record<string, unknown>;
    }>;
    storeStartedAt: number | null;
  };
}

function seedBrief(periodKey: string, composedAt: number, done: number) {
  recordRitualSnapshot({
    ritual: "brief",
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

describe("GET rituals/snapshots", () => {
  test("an empty store is empty and says so — no invented rows", () => {
    const result = list();
    expect(result.snapshots).toEqual([]);
    expect(result.storeStartedAt).toBeNull();
  });

  test("returns kept rows newest first, with their figures", () => {
    seedBrief("2026-08-17", T0, 2);
    seedBrief("2026-08-18", T0 + DAY, 5);

    const result = list();
    expect(result.snapshots.map((s) => s.periodKey)).toEqual([
      "2026-08-18",
      "2026-08-17",
    ]);
    expect(result.snapshots[0]!.facts.done).toBe(5);
    expect(result.storeStartedAt).toBe(T0);
  });

  test("?ritual filters, and an unknown value is ignored rather than empty", () => {
    seedBrief("2026-08-17", T0, 1);
    recordRitualSnapshot({
      ritual: "weekly",
      periodKey: "2026-W34",
      periodStart: T0 - 7 * DAY,
      periodEnd: T0,
      composedAt: T0,
      headline: "A quiet week.",
      facts: { moved: 0, slipped: 0 },
    });

    expect(list({ ritual: "weekly" }).snapshots).toHaveLength(1);
    expect(list({ ritual: "brief" }).snapshots).toHaveLength(1);
    // A bad filter must not silently hide the archive.
    expect(list({ ritual: "monthly" }).snapshots).toHaveLength(2);
  });

  test("?limit caps the page", () => {
    seedBrief("2026-08-17", T0, 1);
    seedBrief("2026-08-18", T0 + DAY, 1);
    seedBrief("2026-08-19", T0 + 2 * DAY, 1);
    expect(list({ limit: "2" }).snapshots).toHaveLength(2);
  });
});
