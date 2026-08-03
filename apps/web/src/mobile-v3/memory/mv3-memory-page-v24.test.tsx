/**
 * Memory (frame F6) — the use count that isn't there.
 *
 * F6's headline device is "applied 14 times". `accessCount` and `lastUsedAt`
 * are hardcoded `null` by the daemon for every memory, and `reinforcementCount`
 * — a *re-observation* count, not an application count — is 0 for all but one
 * node in production. So the tests below assert that no application count is
 * ever printed, and that a zero reinforcement count produces no line at all
 * rather than "seen again 0 times".
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const DAY = 86_400_000;

const state = {
  items: [] as unknown[],
  fails: false,
};

function item(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    kind: "behavioral",
    subject: "meetings",
    statement: "Never book meetings before 9am",
    status: "active",
    confidence: 0.9,
    importance: 0.7,
    firstSeenAt: Date.now() - 40 * DAY,
    lastSeenAt: Date.now(),
    sourceType: "direct",
    reinforcementCount: 0,
    accessCount: null,
    lastUsedAt: null,
    ...over,
  };
}

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

// Spread the real hook module; override only the one query this screen reads.
const realHook = await import(
  "@/domains/intelligence/memories/hooks/use-memory-items-query"
);
mock.module(
  "@/domains/intelligence/memories/hooks/use-memory-items-query",
  () => ({
    ...realHook,
    useMemoryItemsQuery: () => ({
      data: state.fails ? undefined : { items: state.items, total: state.items.length },
      isLoading: false,
      isError: state.fails,
      refetch: () => {},
    }),
  }),
);

const { Mv3MemoryV24Page } = await import("./mv3-memory-page-v24");

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

afterEach(cleanup);

describe("Mv3MemoryV24Page", () => {
  test("a rule is quoted, and NO application count is claimed", async () => {
    state.items = [item()];
    state.fails = false;
    render(
      <Wrap>
        <Mv3MemoryV24Page />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Never book meetings before 9am/)).toBeDefined(),
    );
    // The frame's "applied 14 times" has no field behind it.
    expect(screen.queryByText(/applied/i)).toBeNull();
    // And a zero reinforcement count produces no line, not "0 times".
    expect(screen.queryByText(/seen again/i)).toBeNull();
  });

  test("a real reinforcement count is described as what it is", async () => {
    state.items = [item({ reinforcementCount: 3 })];
    state.fails = false;
    render(
      <Wrap>
        <Mv3MemoryV24Page />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getByText(/seen again 3 times/i)).toBeDefined(),
    );
    expect(screen.queryByText(/applied 3 times/i)).toBeNull();
  });

  test("no rules yet says so — it does not claim the store is broken", async () => {
    state.items = [];
    state.fails = false;
    render(
      <Wrap>
        <Mv3MemoryV24Page />
      </Wrap>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/haven.t told Cue any standing rules yet/i),
      ).toBeDefined(),
    );
  });

  test("a failed read is an error, not an empty memory", async () => {
    state.items = [];
    state.fails = true;
    render(
      <Wrap>
        <Mv3MemoryV24Page />
      </Wrap>,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/MEMORY DIDN.T LOAD/i).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getByText(/Nothing has been forgotten/i)).toBeDefined();
    expect(screen.queryByText(/haven.t told Cue any standing rules/i)).toBeNull();
  });
});
