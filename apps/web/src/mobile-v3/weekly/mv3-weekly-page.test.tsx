/**
 * Weekly review (frame F3) — the numbers that are real and the page that
 * refuses to invent three proposals.
 *
 * F3's fourth page is "the three leash decisions Cue wants". Nothing in the
 * daemon proposes anything — there is no proposals route, no recommendation
 * engine, nothing. On the one screen whose job is to ask the owner to loosen
 * the leash, three plausible fabricated suggestions would be the worst thing
 * in this whole handoff, so the last test asserts the page says the proposals
 * do not exist and shows the ledger instead.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const DAY = 86_400_000;

const state = {
  missions: [] as unknown[],
  missionsFail: false,
  acts: { acts: 61, reversed: 2, estMinutesSaved: 0, byAgent: [] },
  actsFail: false,
  items: [] as unknown[],
  itemsFail: false,
  usage: { totalEstimatedCostUsd: 18.4 },
  usageFail: false,
  ledger: {
    entries: [],
    summary: {
      total: 9,
      executed: 8,
      parked: 1,
      denied: 0,
      failed: 0,
      executedUnattended: 3,
      executedWithoutApproval: 2,
      byClass: [],
    },
    window: { days: 7, from: 0 },
  },
  ledgerFail: false,
};

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

const realGen = await import("@/generated/daemon/@tanstack/react-query.gen");
function opt(key: string, get: () => unknown, fail: () => boolean) {
  return () => ({
    queryKey: [key],
    queryFn: () => {
      if (fail()) throw new Error("500");
      return get();
    },
    retry: false,
  });
}
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...realGen,
  missionsGetOptions: opt(
    "t-missions",
    () => ({ missions: state.missions }),
    () => state.missionsFail,
  ),
  actsSummaryGetOptions: opt(
    "t-acts",
    () => state.acts,
    () => state.actsFail,
  ),
  workitemsGetOptions: opt(
    "t-work",
    () => ({ items: state.items }),
    () => state.itemsFail,
  ),
  usageTotalsGetOptions: opt(
    "t-usage",
    () => state.usage,
    () => state.usageFail,
  ),
  ledgerAutonomyGetOptions: opt(
    "t-ledger",
    () => state.ledger,
    () => state.ledgerFail,
  ),
}));

const { Mv3WeeklyPage } = await import("./mv3-weekly-page");

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function reset() {
  state.missions = [
    {
      id: "m1",
      title: "Close the seed",
      metric: "committed capital",
      status: "active",
      rollup: {
        projects: [],
        counts: {
          queued: 1,
          running: 0,
          awaiting_review: 0,
          done: 6,
          failed: 0,
          open: 1,
          total: 7,
        },
      },
    },
  ];
  state.missionsFail = false;
  state.acts = { acts: 61, reversed: 2, estMinutesSaved: 0, byAgent: [] };
  state.actsFail = false;
  state.items = [
    {
      id: "i1",
      title: "Send the deck",
      status: "done",
      updatedAt: Date.now() - DAY,
      ranProvenance: "manual",
    },
    {
      id: "i2",
      title: "Halo pricing",
      status: "todo",
      updatedAt: Date.now() - 9 * DAY,
      lastActivityAt: Date.now() - 9 * DAY,
      dueAt: null,
      waitingState: null,
    },
  ];
  state.itemsFail = false;
  state.usageFail = false;
  state.ledgerFail = false;
}

afterEach(cleanup);

describe("Mv3WeeklyPage", () => {
  test("a ring shows the ratio it can compute, and the metric as words", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("86%")).toBeDefined());
    expect(screen.getByText("6/7 done")).toBeDefined();
    expect(screen.getByText("committed capital")).toBeDefined();
    // No fabricated delta anywhere.
    expect(screen.queryByText(/\+\$/)).toBeNull();
  });

  test("a mission with no items shows a glyph, never a fake percentage", async () => {
    reset();
    state.missions = [
      {
        id: "m2",
        title: "New thing",
        metric: null,
        status: "active",
        rollup: {
          projects: [],
          counts: {
            queued: 0,
            running: 0,
            awaiting_review: 0,
            done: 0,
            failed: 0,
            open: 0,
            total: 0,
          },
        },
      },
    ];
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("◼")).toBeDefined());
    expect(screen.queryByText("0%")).toBeNull();
  });

  test("acts you reversed is a real field and sits on the who-did-what page", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText("Acts you reversed")).toBeDefined(),
    );
    expect(screen.getByText("Cue finished alone")).toBeDefined();
  });

  test("spend is labelled MODEL spend — tool cost is recorded nowhere", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("Model spend")).toBeDefined());
    expect(screen.getByText("$18.40")).toBeDefined();
    expect(screen.queryByText(/Model \+ tool/i)).toBeNull();
  });

  test("a failed usage read says unknown rather than $0.00", async () => {
    reset();
    state.usageFail = true;
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("unknown")).toBeDefined());
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  test("a genuinely clear week reads differently from a failed work read", async () => {
    reset();
    state.items = [];
    const { unmount } = render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/real clear week, not a failed read/i)).toBeDefined(),
    );
    unmount();

    state.itemsFail = true;
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/work items didn.t load/i)).toBeDefined(),
    );
    expect(
      screen.queryByText(/real clear week, not a failed read/i),
    ).toBeNull();
  });

  test("the leash page NEVER invents proposals — it shows what the leash did", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WeeklyPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText("Ran with nobody watching")).toBeDefined(),
    );
    expect(screen.getByText("Ran with nobody asked")).toBeDefined();
    expect(
      screen.getByText(/doesn.t propose leash changes yet/i),
    ).toBeDefined();
  });
});
