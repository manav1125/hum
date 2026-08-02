/**
 * The desktop rail's primary navigation.
 *
 * v11's finding was that the rail and the phone's tab bar had drifted into
 * describing different information models — the rail still said "Missions"
 * and "Projects" long after the phone had moved on. `nav-model.test.ts`
 * asserts the shared declaration; this file asserts that the rail actually
 * RENDERS it, which is the half a shared constant cannot guarantee on its own.
 *
 * Scope is the rail only. The conversation list below it is covered by the
 * sidebar-state tests.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

let projects: { id: string; status: string }[] = [];
let workItems: { id: string; status: string }[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  projectsGet: mock(async () => ({ data: { projects }, ...okResponse })),
  // Honour the status filter: the needs-you badge asks for `awaiting_review`
  // while the rail's counts read the unfiltered list, and a mock that ignored
  // the query would make those two indistinguishable.
  workitemsGet: mock(async (options?: { query?: { status?: string } }) => {
    const status = options?.query?.status;
    return {
      data: {
        items: status
          ? workItems.filter((i) => i.status === status)
          : workItems,
      },
      ...okResponse,
    };
  }),
  pendinginteractionsGet: mock(async () => ({
    data: { interactions: [] },
    ...okResponse,
  })),
}));

const { AssistantSideMenu } = await import("./assistant-side-menu");

function renderRail(pathname = "/assistant/hq") {
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
        { initialEntries: [pathname] },
        createElement(AssistantSideMenu, {
          assistantId: ASSISTANT_ID,
          collapsed: false,
          variant: "rail" as const,
          conversations: [],
          onSelectConversation: () => undefined,
        }),
      ),
    ),
  );
}

afterEach(() => {
  projects = [];
  workItems = [];
  cleanup();
});

describe("the rail's top three match the phone's three tabs", () => {
  test.each(["Talk to Cue", "HQ", "Work"])("%s is in the rail", (label) => {
    renderRail();
    expect(screen.getByText(label)).toBeDefined();
  });

  test("the words the design retired are gone from the rail", () => {
    // "A rename is only finished when nothing else answers to the old word."
    renderRail();
    expect(screen.queryByText("Missions")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("All work")).toBeNull();
  });
});

describe("Work's two views are nested, not promoted", () => {
  test("they appear while Work is open", async () => {
    renderRail("/assistant/projects");
    await waitFor(() => {
      expect(screen.getByText("Things")).toBeDefined();
    });
    expect(screen.getByText("Everything")).toBeDefined();
  });

  test("and not while it is closed — three rail rows for one destination is the duplicate-nav mistake", () => {
    renderRail("/assistant/hq");
    expect(screen.queryByText("Things")).toBeNull();
    expect(screen.queryByText("Everything")).toBeNull();
  });
});

describe("the deeper surfaces", () => {
  test.each([
    "Agents",
    "Rhythms",
    "People",
    "What Cue does",
    "Trust & guardrails",
  ])("%s is reachable from the rail", (label) => {
    renderRail();
    expect(screen.getByText(label)).toBeDefined();
  });

  test("Voice and Create stay reachable even though they lost their tab", () => {
    // Voice became a mode rather than a place on the phone; on desktop it has
    // no composer mic to fall back to, so removing the row would strand it.
    renderRail();
    expect(screen.getByText("Voice")).toBeDefined();
    expect(screen.getByText("Create")).toBeDefined();
  });
});

describe("the counts", () => {
  test("HQ shows what needs you; Work shows how many things there are", async () => {
    projects = [
      { id: "p1", status: "active" },
      { id: "p2", status: "active" },
      { id: "p3", status: "active" },
    ];
    workItems = [
      { id: "w1", status: "awaiting_review" },
      { id: "w2", status: "running" },
    ];
    renderRail();
    await waitFor(() => {
      // 1 awaiting review → HQ's badge.
      expect(screen.getByText("1")).toBeDefined();
    });
    // 3 live things → Work's count.
    expect(screen.getByText("3")).toBeDefined();
  });

  test("nothing renders a zero — a badge that nags at zero is noise", async () => {
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Work")).toBeDefined();
    });
    expect(screen.queryByText("0")).toBeNull();
  });
});
