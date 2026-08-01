/**
 * DesktopReviewPage — the desktop review surface, rendered against mocked
 * daemon reads:
 *  · header count + the stale partition ("OLDER — LIKELY STALE" + the batch pill)
 *  · the deliverable panel renders the run's markdown summary and highlights
 *  · Approve / Redo / Archive each fire their real daemon call with the right
 *    path and body — the honesty rule is that no enabled control is inert
 *  · "Open the conversation" appears ONLY when the item carries a run
 *    conversation, and the no-summary copy changes to match
 *  · `?item=` deep links select that row.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

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
    notes: null,
    context: null,
    labels: null,
    priorityTier: 2,
    sortIndex: 0,
    lastRunConversationId: null,
    updatedAt: NOW - HOUR,
    createdAt: NOW - DAY,
    ...over,
  } as HqWorkItem;
}

let ITEMS: HqWorkItem[] = [];
let OUTPUT: Record<string, unknown> = {};

interface Call {
  kind: string;
  vars: { path?: { id?: string }; body?: Record<string, unknown> };
}
let CALLS: Call[] = [];

function record(kind: string) {
  return {
    mutationFn: async (vars: Call["vars"]) => {
      CALLS.push({ kind, vars });
      return {};
    },
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
mock.module("@/pages/hq/hq-agent-identity", () => ({
  useAgentFor: (assignee: string | null) =>
    assignee === "Ops" ? { name: "Ops" } : null,
}));
mock.module("@/pages/hq/assessment-kit", () => ({
  AssessmentSignal: () => null,
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  workitemsByIdOutputGetOptions: (opts: { path: { id: string } }) => ({
    queryKey: ["output", opts.path.id],
    queryFn: async () => ({ id: opts.path.id, success: true, output: OUTPUT }),
  }),
  workitemsByIdCompletePostMutation: () => record("complete"),
  workitemsByIdPatchMutation: () => record("patch"),
  workitemsByIdRunPostMutation: () => record("run"),
}));

import { DesktopReviewPage } from "./desktop-review-page";

/**
 * Find a verb button by its id rather than its label.
 *
 * The labels now come from the canonical §4 verb table, so asserting on the
 * words here would re-pin copy this page no longer owns — and would break every
 * time the vocabulary is corrected in one place, which is the whole point of
 * having one place.
 */
function verb(id: string): HTMLElement {
  const el = document.querySelector(`[data-verb='${id}']`);
  if (!el) throw new Error(`no verb button '${id}' on screen`);
  return el as HTMLElement;
}

function renderPage(search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/assistant/review-queue${search}`] },
      createElement(
        QueryClientProvider,
        { client: queryClient } as { client: QueryClient; children?: ReactNode },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/assistant/review-queue",
            element: createElement(DesktopReviewPage),
          }),
        ),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  CALLS = [];
  OUTPUT = {};
});

describe("DesktopReviewPage", () => {
  test("counts, stale partition, and the batch-archive affordance", () => {
    ITEMS = [
      item({ id: "fresh-1", title: "Acme one-pager v2", assignee: "Ops" }),
      item({ id: "stale-1", title: "Blog outline", updatedAt: NOW - 16 * DAY }),
      item({ id: "stale-2", title: "Hiring scorecard", updatedAt: NOW - 18 * DAY }),
    ];
    renderPage();

    expect(screen.getByText("Ready for review")).toBeTruthy();
    expect(screen.getByText("3 waiting · newest first")).toBeTruthy();
    expect(screen.getByText("OLDER — LIKELY STALE")).toBeTruthy();
    expect(screen.getByText("Archive 2 stale")).toBeTruthy();
    // Archive is never presented as a delete.
    fireEvent.click(screen.getByText("Archive 2 stale"));
    expect(
      screen.getByText(/nothing is deleted/),
    ).toBeTruthy();
  });

  test("renders the run's deliverable as markdown", async () => {
    ITEMS = [item({ id: "wi-1", title: "Acme one-pager v2" })];
    OUTPUT = {
      summary: "## What I found\n\nThe renewal **is** at risk.",
      highlights: ["Champion left in March"],
    };
    renderPage();

    expect(await screen.findByText("What I found")).toBeTruthy();
    expect(screen.getByText("Champion left in March")).toBeTruthy();
  });

  test("Approve fires the complete call for the selected item", async () => {
    ITEMS = [item({ id: "wi-1", title: "Acme one-pager v2" })];
    renderPage();

    fireEvent.click(verb("approve"));
    await screen.findByText("Ready for review");
    expect(CALLS.some((c) => c.kind === "complete" && c.vars.path?.id === "wi-1")).toBe(
      true,
    );
  });

  test("a correction chip PATCHes the item context, then reruns it", async () => {
    ITEMS = [item({ id: "wi-1", context: "Keep it punchy" })];
    renderPage();

    fireEvent.click(screen.getByText("More formal"));
    await screen.findByText("Ready for review");

    const patched = CALLS.find((c) => c.kind === "patch");
    expect(patched).toBeTruthy();
    expect(String(patched?.vars.body?.context)).toContain("Keep it punchy");
    expect(String(patched?.vars.body?.context)).toContain("More formal");
    expect(CALLS.some((c) => c.kind === "run" && c.vars.path?.id === "wi-1")).toBe(
      true,
    );
  });

  test("Archive PATCHes to archived — never deletes — and offers Undo", async () => {
    ITEMS = [item({ id: "wi-1", title: "Acme one-pager v2" })];
    renderPage();

    fireEvent.click(verb("archive"));
    expect(await screen.findByText(/Archived “Acme one-pager v2”/)).toBeTruthy();
    expect(screen.getByText("Undo")).toBeTruthy();

    const archived = CALLS.find((c) => c.kind === "patch");
    expect(archived?.vars.body?.status).toBe("archived");
  });

  test("the conversation link only exists when there is a conversation", async () => {
    ITEMS = [item({ id: "wi-1" })];
    renderPage();
    await screen.findByText(/no written summary/);
    // "Open" is a verb the page only offers when there is somewhere to open.
    expect(document.querySelector("[data-verb='open']")).toBeNull();
    expect(
      screen.getByText(/no written summary, and it has no conversation/),
    ).toBeTruthy();

    cleanup();
    ITEMS = [item({ id: "wi-2", lastRunConversationId: "conv-9" })];
    renderPage();
    // Approve is always offered for a selected item, so it is the signal that
    // the verb bar has rendered and `open`'s absence would be meaningful.
    await screen.findByText("Approve");
    expect(document.querySelector("[data-verb='open']")).toBeTruthy();
  });

  test("?item= deep link selects that row", async () => {
    ITEMS = [
      item({ id: "wi-1", title: "First thing" }),
      item({ id: "wi-2", title: "Second thing", updatedAt: NOW - 2 * HOUR }),
    ];
    renderPage("?item=wi-2");

    // The detail panel headline is the deep-linked item, not the newest.
    const headings = await screen.findAllByText("Second thing");
    expect(headings.length).toBeGreaterThan(1);
  });

  test("empty state is graceful", () => {
    ITEMS = [];
    renderPage();
    expect(screen.getByText(/Nothing to review — when Cue finishes/)).toBeTruthy();
  });
});
