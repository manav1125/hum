/**
 * Work is ONE destination with two views — proved by rendering both.
 *
 * The claim the design makes is strong and worth testing rather than
 * asserting: "grouping headers in Everything are the same things listed in
 * Things, so the two views are provably the same data." If those two ever
 * drift apart, Work stops being one surface and becomes two dashboards that
 * happen to agree — which is exactly the state the merge was undoing.
 *
 * Also covered: the ledger's controls survived the move out of its own
 * destination (grouping, add-tasks, the "Not in anything yet" bucket), and
 * both views can reach each other, so neither is a one-way door.
 *
 * Mounted via `@testing-library/react` (happy-dom). The generated SDK is
 * mocked so both views read the SAME fixture — if a view invented its own
 * data source, its list would go empty here.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

/** Two things and four tasks — one of them filed nowhere. */
const PROJECTS = [
  {
    id: "proj-acme",
    title: "Renew Acme",
    emoji: "🤝",
    color: null,
    status: "active",
    category: "professional",
    context: null,
    sortIndex: 0,
    pinned: 0,
    missionId: null,
    createdAt: 1,
    updatedAt: 2,
    stats: {
      counts: {
        queued: 6,
        running: 2,
        awaiting_review: 1,
        done: 0,
        open: 9,
        total: 9,
      },
      nextTask: null,
    },
  },
  {
    id: "proj-halo",
    title: "Ship Halo",
    emoji: "🚀",
    color: null,
    status: "active",
    category: "professional",
    context: null,
    sortIndex: 1,
    pinned: 0,
    missionId: null,
    createdAt: 1,
    updatedAt: 2,
    stats: {
      counts: {
        queued: 1,
        running: 0,
        awaiting_review: 0,
        done: 0,
        open: 1,
        total: 1,
      },
      nextTask: null,
    },
  },
];

function workItem(overrides: Record<string, unknown>) {
  return {
    id: "wi-x",
    taskId: "task-x",
    title: "A task",
    notes: null,
    status: "queued",
    priorityTier: 2,
    sortIndex: 0,
    projectId: null,
    dueAt: null,
    labels: null,
    assignee: "cue",
    context: null,
    sourceContext: null,
    lastActivityAt: null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    lastProgressNote: null,
    sourceType: null,
    sourceId: null,
    originConversationId: null,
    approvalStatus: null,
    autoRunEligibility: null,
    ranProvenance: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const WORK_ITEMS = [
  workItem({
    id: "wi-1",
    title: "Confirm the 24-month position",
    projectId: "proj-acme",
    status: "awaiting_review",
  }),
  workItem({
    id: "wi-2",
    title: "Pull last year's usage",
    projectId: "proj-acme",
    status: "running",
    assignee: "you",
  }),
  workItem({
    id: "wi-3",
    title: "Draft the launch note",
    projectId: "proj-halo",
    status: "queued",
  }),
  // Deliberately filed nowhere — the bucket the ledger must keep.
  workItem({ id: "wi-4", title: "Chase the CIPA return", projectId: null }),
];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async () => ({
    data: { projects: PROJECTS },
    ...okResponse,
  })),
  workitemsGet: mock(async () => ({
    data: { items: WORK_ITEMS },
    ...okResponse,
  })),
  workitemsByIdEventsGet: mock(async () => ({
    data: { events: [], cycleTimeMs: null },
    ...okResponse,
  })),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// The activity SSE bridge is a side effect, not part of what is under test.
mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => undefined,
}));

const { ProjectsPage } = await import("./projects-page");

function renderWork(search: string) {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: [`/assistant/projects${search}`] },
        createElement(ProjectsPage),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("Work → Things", () => {
  test("lists the things, by name", async () => {
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
    expect(screen.getByText("Ship Halo")).toBeDefined();
  });

  test("is the default view — no ?view= at all still lands somewhere real", async () => {
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
  });

  test("a malformed ?view= falls back to Things rather than a blank screen", async () => {
    renderWork("?view=nonsense");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
  });

  test("every row is a doorway: counts, not just a status word", async () => {
    // "A ring and a status word alone reads as a dashboard; counts and agents
    // make it a door with a room behind it."
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
    expect(screen.getByText("1 needs you")).toBeDefined();
    expect(screen.getByText("2 running")).toBeDefined();
    expect(screen.getByText("9 total")).toBeDefined();
  });

  test("and names who is on it", async () => {
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
    // wi-1 is Cue's, wi-2 is the user's — both live on Renew Acme.
    expect(screen.getByText(/Cue, You|You, Cue/)).toBeDefined();
  });
});

describe("Work → Everything", () => {
  test("?view=everything renders the ledger, not the things list", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Everything, one list.")).toBeDefined();
    });
  });

  test("lists the tasks", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Confirm the 24-month position")).toBeDefined();
    });
    expect(screen.getByText("Draft the launch note")).toBeDefined();
    expect(screen.getByText("Chase the CIPA return")).toBeDefined();
  });

  test("keeps its grouping control", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Everything, one list.")).toBeDefined();
    });
    const groupBy = screen.getByRole("radiogroup", { name: "Group by" });
    expect(groupBy).toBeDefined();
    // Grouping by container is named for the thing, not the table.
    expect(screen.getByRole("radio", { name: "thing" })).toBeDefined();
  });

  test("keeps its batch-capture entry", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByTitle("Add tasks (⌘⇧A)")).toBeDefined();
    });
  });
});

describe("the two views are the same data", () => {
  test("grouping Everything by thing produces the things Things lists", async () => {
    // Render Things and capture what it claims exists.
    const things = renderWork("");
    await waitFor(() => {
      expect(screen.getByText("Renew Acme")).toBeDefined();
    });
    expect(screen.getByText("Ship Halo")).toBeDefined();
    things.unmount();
    cleanup();

    // The ledger, grouped by thing, must offer the same names as headers.
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Everything, one list.")).toBeDefined();
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("radio", { name: "thing" }));

    // Both names appear as group headers — the same two names Things listed.
    await waitFor(() => {
      expect(screen.getAllByText(/Renew Acme/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/Ship Halo/).length).toBeGreaterThan(0);
  });

  test("a task in no thing gets a bucket, not a null", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Everything, one list.")).toBeDefined();
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("radio", { name: "thing" }));

    await waitFor(() => {
      expect(screen.getByText("Not in anything yet")).toBeDefined();
    });
  });
});

describe("neither view is a one-way door", () => {
  test.each(["", "?view=everything"])(
    "%p renders the Things/Everything switcher",
    async (search) => {
      renderWork(search);
      await waitFor(() => {
        expect(
          screen.getByRole("tablist", { name: "Work views" }),
        ).toBeDefined();
      });
      expect(screen.getByRole("tab", { name: /Things/ })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Everything/ })).toBeDefined();
    },
  );

  test("the switcher marks the current view with more than a colour", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Everything/ })).toBeDefined();
    });
    expect(
      screen
        .getByRole("tab", { name: /Everything/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /Things/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });
});
