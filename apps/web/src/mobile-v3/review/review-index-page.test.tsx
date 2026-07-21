/**
 * ReviewIndexPage (round-4 frame 55) — list rendering against mocked stores:
 *  · "N waiting · newest first" header + the "Archive N stale" pill
 *  · fresh rows (project · age · agent sub-line) above the mono
 *    "OLDER — LIKELY STALE" divider; stale rows carry the amber date line
 *  · pill → the confirm sheet with the archive-never-delete copy
 *  · row tap → the pager SEEDED at that item (?item=id)
 *  · empty state stays graceful.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { HqWorkItem } from "@/pages/hq/use-missions";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(over: Partial<HqWorkItem>): HqWorkItem {
  return {
    id: "wi",
    title: "A deliverable",
    status: "awaiting_review",
    dueAt: null,
    projectId: null,
    assignee: null,
    updatedAt: NOW - HOUR,
    createdAt: NOW - DAY,
    ...over,
  } as HqWorkItem;
}

let ITEMS: HqWorkItem[] = [];

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/hooks/use-activity-sync", () => ({
  useActivitySync: () => {},
}));
mock.module("@/pages/hq/use-missions", () => ({
  useHqWorkItems: () => ({
    items: ITEMS,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));
mock.module("@/pages/projects/use-projects", () => ({
  useProjects: () => ({
    projects: [{ id: "proj-acme", title: "Acme renewal" }],
    isLoading: false,
  }),
}));
mock.module("@/pages/hq/hq-agent-identity", () => ({
  useAgentFor: (assignee: string | null) =>
    assignee === "Ops" ? { name: "Ops" } : null,
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  workitemsByIdPatchMutation: () => ({
    mutationFn: async () => ({}),
  }),
}));

import { ReviewIndexPage } from "./review-index-page";

function PagerProbe() {
  const loc = useLocation();
  return createElement("div", null, `PAGER${loc.search}`);
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/assistant/review-queue/list"] },
      createElement(
        QueryClientProvider,
        { client: queryClient } as { client: QueryClient; children?: ReactNode },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/assistant/review-queue/list",
            element: createElement(ReviewIndexPage),
          }),
          createElement(Route, {
            path: "/assistant/review-queue",
            element: createElement(PagerProbe),
          }),
        ),
      ),
    ),
  );
}

afterEach(cleanup);

describe("ReviewIndexPage", () => {
  test("header counts, fresh sub-lines, stale divider + amber line, pill", () => {
    ITEMS = [
      item({
        id: "fresh-1",
        title: "Acme one-pager v2",
        projectId: "proj-acme",
        assignee: "Ops",
        updatedAt: NOW - 2 * HOUR,
      }),
      item({
        id: "stale-1",
        title: "Blog outline — launch week",
        updatedAt: NOW - 16 * DAY,
      }),
      item({
        id: "stale-2",
        title: "Hiring scorecard draft",
        updatedAt: NOW - 18 * DAY,
      }),
    ];
    renderPage();

    expect(screen.getByText("Review ready")).toBeTruthy();
    expect(screen.getByText("3 waiting · newest first")).toBeTruthy();
    // Fresh row keeps the project · age · agent sub-line.
    expect(screen.getByText(/Acme renewal · .+ · Ops/)).toBeTruthy();
    // Stale grammar.
    expect(screen.getByText("OLDER — LIKELY STALE")).toBeTruthy();
    expect(screen.getAllByText(/likely stale$/).length).toBe(2);
    expect(screen.getByText("Archive 2 stale")).toBeTruthy();
    // Play-all affordance into the pager.
    expect(screen.getByText("Play all ›")).toBeTruthy();
  });

  test("archive pill opens the confirm sheet — archive, never delete", () => {
    ITEMS = [
      item({ id: "fresh-1", updatedAt: NOW - 2 * HOUR }),
      item({ id: "stale-1", updatedAt: NOW - 16 * DAY }),
    ];
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Archive 1 stale review/ }),
    );
    expect(screen.getByText("Archive 1 stale review?")).toBeTruthy();
    expect(
      screen.getByText("They move to the archive — nothing is deleted."),
    ).toBeTruthy();
    // Both verbs present.
    expect(screen.getByText("Archive 1")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  test("confirming archives the stale rows and shows the undo toast", async () => {
    ITEMS = [
      item({ id: "fresh-1", title: "Fresh thing", updatedAt: NOW - 2 * HOUR }),
      item({
        id: "stale-1",
        title: "Old thing",
        updatedAt: NOW - 16 * DAY,
      }),
    ];
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Archive 1 stale review/ }),
    );
    fireEvent.click(screen.getByText("Archive 1"));

    expect(await screen.findByText("Archived 1 stale review")).toBeTruthy();
    expect(screen.getByText("Undo")).toBeTruthy();
    // The stale row left the list; the fresh row stays.
    expect(screen.queryByText("Old thing")).toBeNull();
    expect(screen.getByText("Fresh thing")).toBeTruthy();
    expect(screen.getByText("1 waiting · newest first")).toBeTruthy();
  });

  test("row tap seeds the existing pager at that item", () => {
    ITEMS = [
      item({ id: "seed-me", title: "Acme one-pager v2", updatedAt: NOW - HOUR }),
    ];
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Task: Acme one-pager v2" }));
    expect(screen.getByText("PAGER?item=seed-me")).toBeTruthy();
  });

  test("empty state is graceful", () => {
    ITEMS = [];
    renderPage();
    expect(
      screen.getByText(/Nothing to review — when Cue finishes/),
    ).toBeTruthy();
    expect(screen.queryByText("Play all ›")).toBeNull();
  });
});
