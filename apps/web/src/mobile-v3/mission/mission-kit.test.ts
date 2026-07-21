/**
 * Frame-58 mission derivations — sweeps grouping (honest "no action" days),
 * cadence line (no invented clock time), owning-agent attribution, status leg.
 */
import { describe, expect, test } from "bun:test";

import type { AgentCharter } from "@/pages/hq-agents/charters";
import type {
  Mission,
  MissionEvent,
  HqWorkItem,
} from "@/pages/hq/use-missions";

import {
  cadenceLine,
  formatSweepAt,
  missionStatusLabel,
  owningAgent,
  sweepsFromEvents,
} from "./mission-kit";

const NOW = new Date("2026-07-20T12:00:00").getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
function ev(kind: string, at: number): MissionEvent {
  return { id: `e${seq++}`, kind, at, payload: null } as MissionEvent;
}

describe("sweepsFromEvents", () => {
  test("groups per day: queued counts, honest no-action, newest first", () => {
    const today8 = new Date("2026-07-20T08:00:00").getTime();
    const events = [
      ev("cycle_started", today8),
      ev("assessed", today8 + 1000),
      ev("item_enqueued", today8 + 2000),
      ev("item_enqueued", today8 + 3000),
      // Yesterday: a cycle ran, nothing moved — the honest day.
      ev("cycle_started", today8 - DAY),
      ev("assessed", today8 - DAY + 1000),
      // Two days back: checkpoint.
      ev("cycle_started", today8 - 2 * DAY),
      ev("checkpoint", today8 - 2 * DAY + 1000),
    ];
    const rows = sweepsFromEvents(events, NOW);
    expect(rows.length).toBe(3);
    expect(rows[0].dayLabel).toMatch(/^Today /);
    expect(rows[0].summary).toBe("2 items queued");
    expect(rows[0].tone).toBe("ok");
    expect(rows[1].dayLabel).toBe("Yesterday");
    expect(rows[1].summary).toBe("no action");
    expect(rows[1].tone).toBe("quiet");
    expect(rows[2].dayLabel).toBe("Jul 18");
    expect(rows[2].summary).toBe("paused for you");
    expect(rows[2].tone).toBe("attention");
  });

  test("a day with events but NO cycle_started is not a sweep", () => {
    const rows = sweepsFromEvents([ev("item_enqueued", NOW - HOUR)], NOW);
    expect(rows).toEqual([]);
  });

  test("error day reads as an error", () => {
    const rows = sweepsFromEvents(
      [ev("cycle_started", NOW - HOUR), ev("error", NOW - HOUR + 500)],
      NOW,
    );
    expect(rows[0].summary).toBe("hit an error");
    expect(rows[0].tone).toBe("error");
  });

  test("empty feed → no rows (section omitted by the page)", () => {
    expect(sweepsFromEvents([], NOW)).toEqual([]);
  });
});

describe("cadenceLine", () => {
  test("clock-less fallback: reads the real cadence, invents no clock time", () => {
    expect(cadenceLine("daily")).toBe("sweeps daily");
    expect(cadenceLine("hourly")).toBe("sweeps hourly");
    expect(cadenceLine("weekly")).toBe("sweeps weekly");
    expect(cadenceLine(null)).toBe("sweeps daily");
    expect(cadenceLine("daily", null)).toBe("sweeps daily");
    expect(cadenceLine("daily")).not.toMatch(/\d(am|pm)/i);
  });

  test("renders the real sweep clock for daily/weekly", () => {
    expect(cadenceLine("daily", "08:00")).toBe("sweeps daily · 8:00 AM");
    expect(cadenceLine(null, "08:00")).toBe("sweeps daily · 8:00 AM");
    expect(cadenceLine("weekly", "21:30")).toBe("sweeps weekly · 9:30 PM");
    expect(cadenceLine("daily", "00:05")).toBe("sweeps daily · 12:05 AM");
    expect(cadenceLine("daily", "12:00")).toBe("sweeps daily · 12:00 PM");
  });

  test("hourly cadence stays clock-less even with a stored sweepAt", () => {
    expect(cadenceLine("hourly", "08:00")).toBe("sweeps hourly");
  });

  test("malformed sweepAt degrades to the clock-less line", () => {
    expect(cadenceLine("daily", "25:99")).toBe("sweeps daily");
    expect(cadenceLine("daily", "8am")).toBe("sweeps daily");
  });
});

describe("formatSweepAt", () => {
  test("24h HH:mm → 12h clock", () => {
    expect(formatSweepAt("08:00")).toBe("8:00 AM");
    expect(formatSweepAt("8:00")).toBe("8:00 AM");
    expect(formatSweepAt("00:00")).toBe("12:00 AM");
    expect(formatSweepAt("12:30")).toBe("12:30 PM");
    expect(formatSweepAt("23:59")).toBe("11:59 PM");
    expect(formatSweepAt("nope")).toBeNull();
  });
});

describe("owningAgent", () => {
  const charters = [
    { id: "a-ops", name: "Ops", emoji: "◆" },
    { id: "a-growth", name: "Growth", emoji: "▲" },
  ] as AgentCharter[];
  const wi = (assignee: string | null): HqWorkItem =>
    ({ id: "x", assignee }) as HqWorkItem;

  test("majority assignee wins", () => {
    const agent = owningAgent(
      [wi("Growth"), wi("growth"), wi("Ops"), wi("you"), wi(null)],
      charters,
    );
    expect(agent?.name).toBe("Growth");
  });

  test("nothing attributable → null (never fake an agent)", () => {
    expect(owningAgent([wi("cue"), wi(null), wi("you")], charters)).toBeNull();
    expect(owningAgent([], charters)).toBeNull();
  });
});

describe("missionStatusLabel", () => {
  const base = {
    status: "active",
    budgetCents: null,
    spentCents: 0,
    rollup: { counts: { awaiting_review: 0 } },
  } as unknown as Mission;

  test("legs: on track / needs you / paused / achieved", () => {
    expect(missionStatusLabel(base).text).toBe("Mission · on track");
    expect(
      missionStatusLabel({
        ...base,
        rollup: { counts: { awaiting_review: 2 } },
      } as Mission).text,
    ).toBe("Mission · needs you");
    expect(
      missionStatusLabel({ ...base, status: "paused" } as Mission).text,
    ).toBe("Mission · paused");
    expect(
      missionStatusLabel({ ...base, status: "achieved" } as Mission).text,
    ).toBe("Mission · achieved");
  });
});
