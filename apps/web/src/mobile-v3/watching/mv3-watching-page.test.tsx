/**
 * Watching (frame F5) — the two honesty cards, and the failure/empty split.
 *
 * The no-op card is not hypothetical: design drew it as an illustration and
 * the pipeline it describes was live. So the tests below check that the card
 * fires on the daemon's own counters, stays silent when the health read
 * itself failed (an unread check is not evidence of a problem), and that a
 * failed connector read reports "unknown" rather than shortening the
 * connected-but-not-watched list.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const state = {
  watchers: [] as unknown[],
  watchersFail: false,
  providers: [] as unknown[],
  arrivals: [] as unknown[],
  summary: {
    since: 0,
    until: 0,
    windowHours: 168,
    arrived: 0,
    filed: 0,
    kept: 0,
    reversed: 0,
    topFiledReasons: [] as { reason: string; count: number }[],
  },
  summaryFails: false,
  comprehension: null as Record<string, unknown> | null,
  comprehensionFails: false,
  apps: [] as unknown[],
  appsFail: false,
};

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

const realAutomations = await import("@/mobile-v3/you/use-automations-data");
mock.module("@/mobile-v3/you/use-automations-data", () => ({
  ...realAutomations,
  useWatchers: () => ({
    data: state.watchersFail ? undefined : state.watchers,
    isLoading: false,
    isError: state.watchersFail,
    refetch: () => {},
  }),
  useWatcherProviders: () => ({ data: state.providers, isLoading: false }),
}));

const realGen = await import("@/generated/daemon/@tanstack/react-query.gen");
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...realGen,
  arrivalsGetOptions: () => ({
    queryKey: ["t-arrivals"],
    queryFn: () => ({ arrivals: state.arrivals }),
    retry: false,
  }),
  arrivalsSummaryGetOptions: () => ({
    queryKey: ["t-arrivals-summary"],
    queryFn: () => {
      if (state.summaryFails) throw new Error("500");
      return state.summary;
    },
    retry: false,
  }),
  arrivalsComprehensionHealthGetOptions: () => ({
    queryKey: ["t-comprehension"],
    queryFn: () => {
      if (state.comprehensionFails) throw new Error("500");
      return state.comprehension;
    },
    retry: false,
  }),
  connectorappsGetOptions: () => ({
    queryKey: ["t-apps"],
    queryFn: () => {
      if (state.appsFail) throw new Error("500");
      return { configured: true, source: "composio", apps: state.apps };
    },
    retry: false,
  }),
}));

const { Mv3WatchingPage } = await import("./mv3-watching-page");

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
  state.watchers = [
    {
      id: "w1",
      name: "Gmail",
      providerId: "gmail",
      enabled: true,
      pollIntervalMs: 300000,
      intakeMode: "all",
      watermark: null,
      status: "ok",
      lastPollAt: Date.now() - 4 * 60_000,
      lastError: null,
      configJson: null,
      credentialService: "gmail",
      health: "ok",
    },
  ];
  state.watchersFail = false;
  state.providers = [
    { id: "gmail", displayName: "Gmail", requiredCredentialService: "gmail" },
  ];
  state.arrivals = [
    { id: "a1", channel: "watcher:gmail", disposition: "filed", workItemId: null },
    {
      id: "a2",
      channel: "watcher:gmail",
      disposition: "surfaced",
      workItemId: "wi1",
    },
  ];
  state.summary = {
    since: 0,
    until: 0,
    windowHours: 168,
    arrived: 415,
    filed: 166,
    kept: 249,
    reversed: 0,
    topFiledReasons: [{ reason: "newsletter from a mailing list", count: 88 }],
  };
  state.summaryFails = false;
  state.comprehension = null;
  state.comprehensionFails = false;
  state.apps = [
    { slug: "gmail", name: "Gmail", category: "email", connected: true },
    { slug: "notion", name: "Notion", category: "docs", connected: true },
  ];
  state.appsFail = false;
}

afterEach(cleanup);

describe("Mv3WatchingPage — sources", () => {
  test("a source states what flowed through it and how much became work", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/2 in — 1 filed, 1 became work/)).toBeDefined(),
    );
    // The per-source block declares its own denominator.
    expect(screen.getByText(/most recent 2 arrivals/i)).toBeDefined();
  });

  test("a failed watcher read is an error, not 'nothing is being watched'", async () => {
    reset();
    state.watchersFail = true;
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/nothing has been turned off/i)).toBeDefined(),
    );
    expect(screen.queryByText(/Nothing is being watched/i)).toBeNull();
  });
});

describe("Mv3WatchingPage — the no-op card", () => {
  const barren = {
    census: {
      since: 0,
      total: 0,
      withDeadline: 0,
      byStatus: {
        comprehended: 0,
        low_confidence: 0,
        failed: 0,
        skipped: 0,
      },
    },
    lastBatchAt: Date.now() - 60_000,
    lastBatchCandidates: 0,
    lastBatchComprehended: 0,
    consecutiveUnproductiveBatches: 40,
    unproductiveWarnAt: 5,
    totalBatches: 718,
    totalComprehended: 0,
  };

  test("a job that ran 718× and learned nothing is called a bug, not a quiet week", async () => {
    reset();
    state.comprehension = barren;
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/ran 718× and understood nothing/i),
      ).toBeDefined(),
    );
    expect(screen.getByText(/a bug, not a quiet week/i)).toBeDefined();
  });

  test("a healthy pipeline shows no card at all", async () => {
    reset();
    state.comprehension = {
      ...barren,
      consecutiveUnproductiveBatches: 0,
      totalComprehended: 300,
      census: {
        ...barren.census,
        total: 300,
        byStatus: { comprehended: 290, low_confidence: 5, failed: 3, skipped: 2 },
      },
    };
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("Gmail")).toBeDefined());
    expect(screen.queryByText(/a bug, not a quiet week/i)).toBeNull();
  });

  test("an UNREAD health check accuses nobody", async () => {
    reset();
    state.comprehensionFails = true;
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText("Gmail")).toBeDefined());
    expect(screen.queryByText(/a bug, not a quiet week/i)).toBeNull();
  });
});

describe("Mv3WatchingPage — connected but not watched", () => {
  test("names the linked-but-unread integrations", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Notion is linked but nothing.s reading it/i),
      ).toBeDefined(),
    );
  });

  test("a failed connector read says UNKNOWN — it must not shorten the list", async () => {
    reset();
    state.appsFail = true;
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/this is unknown — not empty/i)).toBeDefined(),
    );
    expect(
      screen.queryByText(/Everything you.ve connected is being read/i),
    ).toBeNull();
  });
});

describe("Mv3WatchingPage — what Cue skipped", () => {
  test("shows the reasons Cue actually gave and says they are not a rule list", async () => {
    reset();
    render(
      <Wrap>
        <Mv3WatchingPage />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/newsletter from a mailing list/i)).toBeDefined(),
    );
    expect(screen.getByText(/aren.t editable yet/i)).toBeDefined();
  });
});
