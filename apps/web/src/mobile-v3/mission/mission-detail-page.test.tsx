/**
 * Mv3MissionDetail (round-4 frame 58) — rendering against mocked mission
 * data (prod has no missions yet):
 *  · charter in quotes, "MISSION · ON TRACK" leg, agent + cadence line
 *    (no invented clock time)
 *  · work rows keep the taxonomy incl. ○ parked ("parked — waiting for ▶")
 *    and the round-4.1 queued solid faint-blue ring ("runs next, no ▶ needed")
 *  · REAL pause wiring: the chip PATCHes status and swaps to ▶ Resume
 *  · sweeps render honest "no action" days, and the section is omitted with
 *    an empty event feed
 *  · a missing mission stays graceful.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";

import type {
  Mission,
  MissionEvent,
  HqWorkItem,
} from "@/pages/hq/use-missions";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let MISSION: Mission | null = null;
let EVENTS: MissionEvent[] = [];
let ITEMS: Record<string, HqWorkItem[]> = {};
const patchCalls: Array<{ body: unknown }> = [];

function mission(over: Partial<Mission>): Mission {
  return {
    id: "m-1",
    title: "Keep the pipeline warm",
    outcome: "Nothing goes cold.",
    brief:
      "Every investor and prospect hears from us within 48h of any signal. Nothing goes cold.",
    status: "active",
    cadence: "daily",
    sweepAt: "08:00",
    budgetCents: null,
    spentCents: 0,
    rollup: {
      projects: [
        { id: "p-seed", title: "Seed raise", emoji: null, status: "active" },
        { id: "p-events", title: "Events", emoji: null, status: "active" },
      ],
      counts: {
        queued: 1,
        running: 1,
        awaiting_review: 0,
        done: 0,
        failed: 0,
        open: 2,
        total: 2,
      },
      spentCents: 0,
      budgetCents: null,
    },
    ...over,
  } as Mission;
}

function wi(over: Partial<HqWorkItem>): HqWorkItem {
  return {
    id: "wi",
    title: "A task",
    status: "pending",
    projectId: "p-seed",
    assignee: null,
    autoRunEligibility: null,
    updatedAt: NOW - HOUR,
    createdAt: NOW - DAY,
    ...over,
  } as HqWorkItem;
}

let evSeq = 0;
function ev(kind: string, at: number): MissionEvent {
  return { id: `e${evSeq++}`, kind, at, payload: null } as MissionEvent;
}

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => {},
}));
mock.module("@/pages/hq-agents/charters", () => ({
  useCharters: () => [
    { id: "a-growth", name: "Growth", emoji: "▲" },
    { id: "a-ops", name: "Ops", emoji: "◆" },
  ],
}));
mock.module("@/pages/hq/use-missions", () => ({
  // ringStatusFor rides through mission-kit — keep the real derivation shape.
  ringStatusFor: (m: Mission) =>
    m.status === "paused"
      ? "blocked"
      : m.rollup.counts.awaiting_review > 0
        ? "needs_you"
        : "on_track",
  useMission: () => ({
    mission: MISSION,
    isLoading: false,
    isError: false,
  }),
  useMissionEvents: () => ({ events: EVENTS, isLoading: false }),
  useHqWorkItems: (_id: string, status?: string) => ({
    items: ITEMS[status ?? "all"] ?? [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  usePatchMission: () => ({
    isPending: false,
    mutate: (vars: { body: unknown }) => {
      patchCalls.push({ body: vars.body });
    },
  }),
}));

import { Mv3MissionDetail } from "./mission-detail-page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient } as { client: QueryClient; children?: ReactNode },
        createElement(Mv3MissionDetail, { missionId: "m-1" }),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  patchCalls.length = 0;
});

describe("Mv3MissionDetail", () => {
  test("charter in quotes, status leg, agent + cadence, taxonomy rows, sweeps", () => {
    MISSION = mission({});
    ITEMS = {
      running: [
        wi({
          id: "r1",
          title: "Nudging 4 cold threads",
          status: "running",
          assignee: "Growth",
        }),
      ],
      awaiting_review: [
        wi({
          id: "v1",
          title: "Re-engage Sequoia — draft ready",
          status: "awaiting_review",
          assignee: "Growth",
        }),
      ],
      pending: [
        wi({
          id: "p1",
          title: "Quarterly investor dinner plan",
          projectId: "p-events",
          autoRunEligibility: "parked",
        }),
        // Queued-not-parked (round-4.1): solid faint-blue ring, "runs next".
        wi({ id: "q1", title: "Follow-up sweep — Notion leads" }),
        // Filed OUTSIDE the mission's projects — must not render.
        wi({ id: "x1", title: "Unrelated task", projectId: "p-other" }),
      ],
    };
    // Anchor to noon TODAY so the day grouping never straddles midnight
    // (sweepsFromEvents reads the real clock).
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const today12 = todayNoon.getTime();
    EVENTS = [
      ev("cycle_started", today12),
      ev("item_enqueued", today12 + 1000),
      ev("cycle_started", today12 - DAY),
      ev("assessed", today12 - DAY + 1000),
    ];
    renderPage();

    expect(screen.getByText("Mission · on track")).toBeTruthy();
    expect(screen.getByText("Keep the pipeline warm")).toBeTruthy();
    // Charter in quotes.
    expect(
      screen.getByText(/“Every investor and prospect hears from us/),
    ).toBeTruthy();
    // Real attribution + the REAL sweep clock (mission.sweepAt, not the
    // frame's fabricated "8am").
    expect(screen.getByText("Growth runs it")).toBeTruthy();
    expect(screen.getByText("· sweeps daily · 8:00 AM")).toBeTruthy();
    expect(screen.queryByText(/8am/)).toBeNull();
    // Work rows across projects, taxonomy states intact.
    expect(
      screen.getByText(/Work under this mission · across 2 projects/i),
    ).toBeTruthy();
    expect(screen.getByText("Nudging 4 cold threads")).toBeTruthy();
    expect(screen.getByText(/Seed raise · running now/)).toBeTruthy();
    expect(screen.getByText(/Seed raise · ready for review/)).toBeTruthy();
    // ○ parked row.
    expect(screen.getByText(/Events · parked — waiting for ▶/)).toBeTruthy();
    // Queued row (round-4.1): drawn ring + the "runs on its own" sub-line,
    // distinct from parked's dashed mono.
    expect(
      screen.getByText(/Seed raise · queued — runs next, no ▶ needed/),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-state-tile="queued"]'),
    ).toBeTruthy();
    // Fenced: the unlinked item stays out.
    expect(screen.queryByText("Unrelated task")).toBeNull();
    // Sweeps: activity + the honest no-action day.
    expect(screen.getByText(/Today .* — 1 item queued/)).toBeTruthy();
    expect(screen.getByText(/Yesterday — no action/)).toBeTruthy();
  });

  test("legacy mission without a sweep clock keeps the clock-less cadence line", () => {
    MISSION = mission({ sweepAt: null });
    ITEMS = {};
    EVENTS = [];
    renderPage();
    expect(screen.getByText("· sweeps daily")).toBeTruthy();
    expect(screen.queryByText(/AM|PM/)).toBeNull();
  });

  test("pause chip drives the REAL mission PATCH; paused shows ▶ Resume", () => {
    MISSION = mission({});
    ITEMS = {};
    EVENTS = [];
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: "Pause this mission" }),
    );
    expect(patchCalls).toEqual([{ body: { status: "paused" } }]);

    cleanup();
    MISSION = mission({ status: "paused" });
    renderPage();
    expect(screen.getByText("Mission · paused")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Resume this mission" }),
    );
    expect(patchCalls).toEqual([
      { body: { status: "paused" } },
      { body: { status: "active" } },
    ]);
  });

  test("empty event feed omits the sweeps section; empty work stays quiet", () => {
    MISSION = mission({});
    ITEMS = {};
    EVENTS = [];
    renderPage();
    expect(screen.queryByText(/Recent sweeps/i)).toBeNull();
    expect(
      screen.getByText(/Nothing queued under this mission right now/),
    ).toBeTruthy();
    // No roster attribution → the honest fallback, never a fake agent.
    expect(screen.getByText("Cue runs it")).toBeTruthy();
  });

  test("missing mission stays graceful", () => {
    MISSION = null;
    ITEMS = {};
    EVENTS = [];
    renderPage();
    expect(
      screen.getByText(/Couldn’t load this mission — it may have been archived./),
    ).toBeTruthy();
    expect(screen.getByText("Back to HQ ›")).toBeTruthy();
  });
});
