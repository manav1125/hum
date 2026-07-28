/**
 * DesktopWatchPage — the desktop run timeline, rendered against mocked daemon
 * reads:
 *  · the item's event trail becomes ✓ rows (deduped), with the daemon's own
 *    narration where a row carries any
 *  · a running item gets the "now" row (the runner's latest progress note) and
 *    the dashed "Finish → your review" tail; a finished one does not
 *  · Stop only exists while the item is really running, and fires cancel
 *  · "Take over" only exists when a run conversation exists
 *  · "Review →" only exists once the item is awaiting review
 *  · a missing item says so rather than rendering an empty run.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { HqWorkItem } from "@/pages/hq/use-missions";

const NOW = Date.now();
const MIN = 60_000;

interface TrailEvent {
  id: string;
  workItemId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  detail: string | null;
  at: number;
}

let ITEMS: HqWorkItem[] = [];
let EVENTS: TrailEvent[] = [];
let CANCELLED: string[] = [];

function ev(over: Partial<TrailEvent>): TrailEvent {
  return {
    id: "e",
    workItemId: "wi-1",
    kind: "status_changed",
    fromStatus: null,
    toStatus: null,
    actor: null,
    detail: null,
    at: NOW - 10 * MIN,
    ...over,
  };
}

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
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  workitemsByIdEventsGetOptions: (opts: { path: { id: string } }) => ({
    queryKey: ["events", opts.path.id],
    queryFn: async () => ({ events: EVENTS, cycleTimeMs: null }),
  }),
  workitemsByIdCancelPostMutation: () => ({
    mutationFn: async (vars: { path: { id: string } }) => {
      CANCELLED.push(vars.path.id);
      return {};
    },
  }),
  workitemsByIdRunPostMutation: () => ({ mutationFn: async () => ({}) }),
}));

import { DesktopWatchPage } from "./desktop-watch-page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/assistant/work/wi-1/live"] },
      createElement(
        QueryClientProvider,
        { client: queryClient } as { client: QueryClient; children?: ReactNode },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/assistant/work/:workItemId/live",
            element: createElement(DesktopWatchPage),
          }),
        ),
      ),
    ),
  );
}

function workItem(over: Partial<HqWorkItem>): HqWorkItem {
  return {
    id: "wi-1",
    title: "Draft the renewal brief",
    status: "running",
    dueAt: null,
    projectId: null,
    assignee: "cue",
    notes: null,
    lastRunConversationId: null,
    lastProgressNote: null,
    updatedAt: NOW - 5 * MIN,
    createdAt: NOW - 30 * MIN,
    ...over,
  } as HqWorkItem;
}

afterEach(() => {
  cleanup();
  EVENTS = [];
  CANCELLED = [];
});

describe("DesktopWatchPage", () => {
  test("a running item streams its trail, narration, now-row and tail", async () => {
    ITEMS = [workItem({ lastProgressNote: "Reading Q2-deck.pdf" })];
    EVENTS = [
      ev({ id: "e1", kind: "created", at: NOW - 30 * MIN }),
      ev({ id: "e2", toStatus: "queued", at: NOW - 20 * MIN }),
      // Two rows the daemon writes for one start — must collapse to one.
      ev({ id: "e3", toStatus: "running", at: NOW - 12 * MIN }),
      ev({ id: "e4", kind: "run_started", toStatus: "running", at: NOW - 12 * MIN }),
      ev({
        id: "e5",
        kind: "run_step",
        detail: "Opened the Acme project knowledge",
        at: NOW - 8 * MIN,
      }),
    ];
    renderPage();

    expect(screen.getByText("Draft the renewal brief")).toBeTruthy();
    expect(screen.getByText(/Cue · Running/)).toBeTruthy();
    expect(await screen.findByText("Captured the task")).toBeTruthy();
    expect(screen.getByText("Queued for a run")).toBeTruthy();
    // Deduped: one "Started the run", not two.
    expect(screen.getAllByText("Started the run").length).toBe(1);
    // The daemon's own narration rides along.
    expect(screen.getByText("Opened the Acme project knowledge")).toBeTruthy();
    // The now-row is the runner's real progress note; the tail is dashed.
    expect(screen.getByText("Reading Q2-deck.pdf")).toBeTruthy();
    expect(screen.getByText("Finish → your review")).toBeTruthy();
  });

  test("Stop exists only while running, and cancels", async () => {
    ITEMS = [workItem({})];
    renderPage();
    fireEvent.click(await screen.findByText("■ Stop"));
    await waitFor(() => expect(CANCELLED).toEqual(["wi-1"]));
  });

  test("a finished item has no Stop and no now-row", async () => {
    ITEMS = [workItem({ status: "awaiting_review" })];
    EVENTS = [ev({ id: "e1", kind: "created", at: NOW - 30 * MIN })];
    renderPage();

    await screen.findByText("Captured the task");
    expect(screen.queryByText("■ Stop")).toBeNull();
    expect(screen.queryByText("Finish → your review")).toBeNull();
    expect(screen.getByText("Waiting on your review")).toBeTruthy();
    // The review hand-off appears exactly when there is something to review.
    expect(screen.getByText("Review →")).toBeTruthy();
  });

  test("take-over only shows when a run conversation exists", async () => {
    ITEMS = [workItem({})];
    renderPage();
    await screen.findByText("■ Stop");
    expect(screen.queryByText("Take over in the conversation")).toBeNull();

    cleanup();
    ITEMS = [workItem({ lastRunConversationId: "conv-7" })];
    renderPage();
    expect(
      await screen.findByText("Take over in the conversation"),
    ).toBeTruthy();
  });

  test("a missing item says so", () => {
    ITEMS = [];
    renderPage();
    expect(screen.getByText(/isn’t here anymore/)).toBeTruthy();
  });
});
