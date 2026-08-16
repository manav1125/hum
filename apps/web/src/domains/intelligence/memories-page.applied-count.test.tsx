/**
 * The "applied N times" line on the Memory surface's detail rail.
 *
 * The rule these hold is **omit rather than fake**. The daemon only started
 * counting applications when the injection-event log landed, so a memory with
 * no recorded applications has no history — not a history of zero. Printing
 * "applied 0 times" would read as a verdict ("this memory has never been
 * useful") against a memory we simply have no record for, so the line is
 * absent instead. Same reason the phone's Memory screen refuses to claim an
 * application count at all today.
 *
 * The neighbouring reinforcement line is pinned here too: it used to render
 * "reinforced 0×" unguarded on essentially every memory, which is the same
 * mistake in the same rail.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

const actualRouter = await import("react-router");
mock.module("react-router", () => ({
  ...actualRouter,
  useNavigate: () => () => {},
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  useMobileLayout: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-test",
}));

type Overrides = {
  accessCount?: number | null;
  reinforcementCount?: number;
};

const itemOverrides: { value: Overrides } = { value: {} };

mock.module(
  "@/domains/intelligence/memories/hooks/use-memory-items-query",
  () => ({
    useMemoryItemsQuery: () => ({
      data: {
        items: [
          {
            id: "m1",
            kind: "preference",
            statement: "Prefers concise replies",
            subject: "you",
            confidence: 0.9,
            reinforcementCount: itemOverrides.value.reinforcementCount ?? 0,
            accessCount:
              itemOverrides.value.accessCount === undefined
                ? null
                : itemOverrides.value.accessCount,
            sourceType: "chat",
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
          },
        ],
        kindCounts: {},
      },
      isLoading: false,
      isError: false,
      refetch: () => {},
    }),
  }),
);

const { MemoriesPage } = await import("@/domains/intelligence/memories-page");

/**
 * Render the page. The rail auto-selects the first visible memory, so no
 * click is needed — and the statement text appears twice (list row + rail
 * card), which makes `getByText` on it ambiguous anyway.
 */
function renderWithSelection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MemoriesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  itemOverrides.value = {};
});

afterEach(() => {
  cleanup();
});

describe("applied count on the memory detail rail", () => {
  test("a memory with no recorded applications shows no line at all", () => {
    itemOverrides.value = { accessCount: null };
    renderWithSelection();

    // Not "applied 0 times", not a dash — absent.
    expect(screen.queryByText(/applied/i)).toBeNull();
    expect(screen.queryByText(/0 times/i)).toBeNull();
  });

  test("a real count is stated plainly", () => {
    itemOverrides.value = { accessCount: 12 };
    renderWithSelection();

    expect(screen.queryAllByText(/applied 12 times/i).length).toBe(1);
  });

  test("one application reads as 'once', not 'applied 1 times'", () => {
    itemOverrides.value = { accessCount: 1 };
    renderWithSelection();

    expect(screen.queryAllByText(/applied once/i).length).toBe(1);
  });

  test("a zero from the wire is still omitted, not printed", () => {
    // Belt to the daemon's braces: the route sends null rather than 0, but if
    // a 0 ever arrives the surface must still say nothing.
    itemOverrides.value = { accessCount: 0 };
    renderWithSelection();

    expect(screen.queryByText(/applied/i)).toBeNull();
  });
});

describe("the neighbouring reinforcement line follows the same rule", () => {
  test("zero reinforcements prints no 'reinforced 0×'", () => {
    itemOverrides.value = { reinforcementCount: 0 };
    renderWithSelection();

    expect(screen.queryByText(/reinforced/i)).toBeNull();
  });

  test("a real reinforcement count is still shown", () => {
    itemOverrides.value = { reinforcementCount: 3 };
    renderWithSelection();

    expect(screen.queryAllByText(/reinforced 3×/i).length).toBeGreaterThan(0);
  });
});
