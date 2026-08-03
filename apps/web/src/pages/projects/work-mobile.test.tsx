/**
 * Work at phone width.
 *
 * The desktop assertions live in `work-two-views.test.tsx`; this file exists
 * because the phone renders entirely different components for the same two
 * views (`Mv3Projects` / `Mv3AllWork`), and "the two platforms agree" is a
 * claim about what the user sees, not about a shared constant.
 *
 * The gate itself (`usePhoneLayout` — narrow AND a COARSE POINTER AND not
 * Electron) is covered in `hooks/use-is-mobile.test.tsx`, including the two
 * cases that have bitten before: a 440px Electron window and a 720px desktop
 * browser window must both render the DESKTOP flow. Here the gate is forced
 * so the phone rendering is exercised directly.
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

/**
 * The library — `GET /library`, which composes run-registered deliverables
 * with the files, documents and apps that no work run ever touched. The
 * Library used to read `GET /outputs` alone, which is why the owner's phone
 * showed two cards against 89 real assets.
 */
const LIBRARY = [
  {
    id: "out-1",
    source: "output",
    workItemId: "wi-1",
    missionId: null,
    projectId: "proj-acme",
    attachmentId: null,
    externalUrl: null,
    documentId: null,
    appId: null,
    kind: "deck",
    title: "Acme one-pager v2",
    why: null,
    agent: "Ops",
    reviewState: "approved",
    createdAt: Date.now() - 86_400_000,
    attachment: null,
  },
  {
    id: "doc-1",
    source: "document",
    workItemId: null,
    missionId: null,
    projectId: null,
    attachmentId: null,
    externalUrl: null,
    documentId: "surface-1",
    appId: null,
    kind: "document",
    title: "Ubud Family Itinerary",
    why: "Document · 1,204 words",
    agent: null,
    reviewState: null,
    createdAt: Date.now() - 3 * 86_400_000,
    attachment: null,
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
  libraryGet: mock(async () => ({
    data: { items: LIBRARY },
    ...okResponse,
  })),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => undefined,
}));

// Force the phone branch. The real gate is a viewport query AND a pointer
// query AND a platform check; all three are tested at source in
// hooks/use-is-mobile.test.tsx.
const isMobileActual = await import("@/hooks/use-is-mobile");
mock.module("@/hooks/use-is-mobile", () => ({
  ...isMobileActual,
  useIsMobile: () => true,
  usePointerCoarse: () => true,
  useMobileLayout: () => true,
  usePhoneLayout: () => true,
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

  test.each(["", "?view=everything", "?view=library"])(
    "%p carries the same three-view switcher desktop has",
    async (search) => {
      renderWork(search);
      await waitFor(() => {
        expect(
          screen.getByRole("tablist", { name: "Work views" }),
        ).toBeDefined();
      });
      // Exactly three — v23 states three is the phone's ceiling, and a
      // fourth would put the tab bar's mark off-centre all over again.
      expect(screen.getAllByRole("tab")).toHaveLength(3);
      expect(screen.getByRole("tab", { name: /Things/ })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Everything/ })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Library/ })).toBeDefined();
    },
  );

  test("?view=library keeps Library's gallery form, filed inside Work", async () => {
    // The R1 revision: Library stopped being a tab and became Work's third
    // view — "filed, not demoted". It must still be a wall of real output,
    // and each card must still name the agent and the thing.
    renderWork("?view=library");
    await waitFor(() => {
      expect(screen.getByText("Acme one-pager v2")).toBeDefined();
    });
    expect(screen.getByText(/◆ Ops · Renew Acme/)).toBeDefined();
    // …and a document no work run ever registered is on the same wall. Under
    // the old `GET /outputs` fetch it was not reachable at all.
    expect(screen.getByText("Ubud Family Itinerary")).toBeDefined();
    // The header line carries the argument, off a real count, and names the
    // scope it applied rather than claiming authorship it cannot back.
    expect(screen.getByText(/2 things made with Cue/)).toBeDefined();
  });

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
