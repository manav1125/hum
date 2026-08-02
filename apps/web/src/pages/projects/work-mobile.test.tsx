/**
 * Work at phone width.
 *
 * The desktop assertions live in `work-two-views.test.tsx`; this file exists
 * because the phone renders entirely different components for the same two
 * views (`Mv3Projects` / `Mv3AllWork`), and "the two platforms agree" is a
 * claim about what the user sees, not about a shared constant.
 *
 * The width gate itself (`useMobileLayout` — narrow AND not Electron) is
 * covered in `hooks/use-is-mobile.test.tsx`, including the case that has
 * bitten before: a 440px Electron window must render the DESKTOP flow. Here
 * the gate is forced so the phone rendering is exercised directly.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

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
];

const WORK_ITEMS = [
  {
    id: "wi-1",
    taskId: "task-1",
    title: "Confirm the 24-month position",
    notes: null,
    status: "awaiting_review",
    priorityTier: 2,
    sortIndex: 0,
    projectId: "proj-acme",
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
  },
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
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => undefined,
}));

// Force the phone branch. The real gate is a viewport query AND a platform
// check; both are tested at source in hooks/use-is-mobile.test.tsx.
const isMobileActual = await import("@/hooks/use-is-mobile");
mock.module("@/hooks/use-is-mobile", () => ({
  ...isMobileActual,
  useIsMobile: () => true,
  useMobileLayout: () => true,
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

describe("Work on the phone", () => {
  test("the surface is called Work, not Projects", async () => {
    // The phone said "Projects" while the design had moved to "Work"; the
    // two platforms disagreeing about the noun is the bug this prevents.
    renderWork("");
    await waitFor(() => {
      expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    });
  });

  test("Things lists the things", async () => {
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText(/Renew Acme/)).toBeDefined();
    });
  });

  test("rows are doorways here too — counts, not a status word alone", async () => {
    renderWork("");
    await waitFor(() => {
      expect(
        screen.getByText(/1 needs you · 2 running · 9 total/),
      ).toBeDefined();
    });
  });

  test("?view=everything renders the ledger", async () => {
    renderWork("?view=everything");
    await waitFor(() => {
      expect(screen.getByText("Confirm the 24-month position")).toBeDefined();
    });
  });

  test.each(["", "?view=everything"])(
    "%p carries the same Things/Everything switcher desktop has",
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

  test("the ledger is reachable ONLY through that switcher", async () => {
    // The phone used to carry a separate "All work ›" row at the bottom of
    // the list. With the ledger now a view of this surface, that row was a
    // second nav path to the same place — the duplicate-nav mistake this
    // codebase has already had to clean up once.
    renderWork("");
    await waitFor(() => {
      expect(screen.getByText(/Renew Acme/)).toBeDefined();
    });
    expect(screen.queryByText("All work")).toBeNull();
  });
});
