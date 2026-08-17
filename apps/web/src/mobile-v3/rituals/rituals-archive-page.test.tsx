/**
 * "Briefs & reviews", rendered.
 *
 * Two properties are asserted against the real page rather than the pure
 * model: a kept snapshot appears as a dated row carrying the sentence it was
 * composed with, and an instance whose history predates the store shows the
 * interim line with **no** invented rows behind it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const DAY = 86_400_000;

const state = {
  body: { snapshots: [] as unknown[], storeStartedAt: null as number | null },
  ok: true,
};

const realClient = await import("@/generated/daemon/client.gen");
mock.module("@/generated/daemon/client.gen", () => ({
  ...realClient,
  client: {
    ...realClient.client,
    get: async () => ({
      data: state.body,
      response: { ok: state.ok, status: state.ok ? 200 : 500 },
    }),
  },
}));

const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { Mv3RitualsArchivePage } = await import("./rituals-archive-page");

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

beforeEach(() => {
  state.body = { snapshots: [], storeStartedAt: null };
  state.ok = true;
  useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
});

afterEach(cleanup);

describe("the live rows are always there", () => {
  test("today's brief and this week's review", async () => {
    render(<Mv3RitualsArchivePage />, { wrapper: Wrap });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.getByText("Weekly review")).toBeTruthy();
  });
});

describe("kept rows", () => {
  test("a past brief renders with the sentence it was composed with", async () => {
    const composedAt = Date.now() - 2 * DAY;
    state.body = {
      snapshots: [
        {
          id: "brief:2026-01-02",
          ritual: "brief",
          periodKey: "2026-01-02",
          periodStart: composedAt - DAY,
          periodEnd: composedAt,
          composedAt,
          headline: "While you slept, Cue finished three things.",
          facts: { done: 3, needsYou: 1 },
        },
      ],
      storeStartedAt: composedAt,
    };

    render(<Mv3RitualsArchivePage />, { wrapper: Wrap });

    await waitFor(() => {
      expect(
        screen.getByText("While you slept, Cue finished three things."),
      ).toBeTruthy();
    });
    expect(screen.getByText("3 finished · 1 needed you")).toBeTruthy();
    // The kept row is not a control: there is nowhere honest to send a tap.
    const kept = document.querySelector('[data-slot="mv3-ritual-kept"]');
    expect(kept).not.toBeNull();
    expect(kept!.tagName.toLowerCase()).not.toBe("button");
  });
});

describe("no backfill", () => {
  test("history predating the store shows the interim line, not invented rows", async () => {
    // The daemon has months of work items and has kept nothing yet.
    state.body = { snapshots: [], storeStartedAt: null };

    render(<Mv3RitualsArchivePage />, { wrapper: Wrap });

    await waitFor(() => {
      expect(
        screen.getByText(/Cue only started keeping these today/),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/they went out and weren't written down/),
    ).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="mv3-ritual-kept"]').length,
    ).toBe(0);
  });

  test("a week of kept rows drops the line without anyone editing copy", async () => {
    const composedAt = Date.now() - 2 * DAY;
    state.body = {
      snapshots: [
        {
          id: "brief:old",
          ritual: "brief",
          periodKey: "2026-01-02",
          periodStart: composedAt - DAY,
          periodEnd: composedAt,
          composedAt,
          headline: "All quiet overnight.",
          facts: { done: 0 },
        },
      ],
      storeStartedAt: Date.now() - 9 * DAY,
    };

    render(<Mv3RitualsArchivePage />, { wrapper: Wrap });

    await waitFor(() => {
      expect(screen.getByText("All quiet overnight.")).toBeTruthy();
    });
    expect(screen.queryByText(/started keeping these/)).toBeNull();
  });

  test("a failed read states nothing at all", async () => {
    state.ok = false;
    render(<Mv3RitualsArchivePage />, { wrapper: Wrap });
    await waitFor(() => {
      expect(screen.getByText("Morning brief")).toBeTruthy();
    });
    expect(screen.queryByText(/started keeping these/)).toBeNull();
  });
});
