/**
 * Tests for the task drawer's PROVENANCE surface — "why is this here, and what
 * did Cue do to it", answered where the user opens the item.
 *
 * Two regressions are pinned here.
 *
 * 1. The drawer's Source section rendered `from {item.sourceType}` — the raw
 *    stored token straight onto the screen ("from gmail_watcher"). That is the
 *    same class of schema leak `work-vocabulary.ts` was written to stop, and
 *    it survived on this surface because the section predates that module.
 * 2. An item with NO source rendered nothing, correctly — and that has to stay
 *    true now that a provenance affordance exists. It must not acquire a
 *    default origin on the way past.
 *
 * Harness mirrors `task-drawer.assessment.test.tsx`: happy-dom via
 * `test-setup.ts`, with the generated SDK mocked so the events read resolves
 * locally instead of reaching for a daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { ProjectsByIdWorkitemsGetResponses } from "@/generated/daemon/types.gen";

type BoardItem = ProjectsByIdWorkitemsGetResponses[200]["items"][number];

const ASSISTANT_ID = "asst-1";
const ITEM_ID = "wi-1";
const okResponse = { response: new Response(), error: undefined };

const sdkActual = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  workitemsByIdEventsGet: mock(async () => ({
    data: { events: [], cycleTimeMs: null },
    ...okResponse,
  })),
  workitemsByIdPatch: mock(async () => ({ data: {}, ...okResponse })),
  workitemsByIdRunPost: mock(async () => ({
    data: { success: true },
    ...okResponse,
  })),
}));

const { TaskDrawer } = await import("./task-drawer");

function boardItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: ITEM_ID,
    taskId: "task-1",
    title: "Send the Q2 update to the board",
    notes: null,
    status: "queued",
    priorityTier: 2,
    sortIndex: 0,
    projectId: "proj-1",
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
    arrivalId: null,
    originConversationId: null,
    approvalStatus: null,
    autoRunEligibility: null,
    ranProvenance: null,
    completedElsewhere: false,
    autoFiledBy: null,
    autoFileConfidence: null,
    assessmentVerdict: null,
    assessmentUnderstanding: null,
    assessmentPlan: null,
    assessmentQuestion: null,
    assessmentMissing: null,
    assessmentConfidence: null,
    assessmentAt: null,
    domain: "work",
    horizon: null,
    waitingOn: null,
    lastChasedAt: null,
    waitingState: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function renderDrawer(item: BoardItem): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/projects/proj-1"]}>
        <TaskDrawer
          assistantId={ASSISTANT_ID}
          item={item}
          projects={[
            {
              id: "proj-1",
              title: "Seed raise",
            } as unknown as Parameters<
              typeof TaskDrawer
            >[0]["projects"][number],
          ]}
          currentProjectId="proj-1"
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("TaskDrawer · the source is stated in words", () => {
  test("a watcher arrival never renders its stored token", () => {
    renderDrawer(boardItem({ sourceType: "gmail_watcher" }));
    const body = document.body.textContent ?? "";
    // The regression: "from gmail_watcher" on screen.
    expect(body).not.toContain("gmail_watcher");
    expect(body).toContain("A watcher picked this up from Gmail");
  });

  test("a token only present in the triage snapshot is translated too", () => {
    renderDrawer(
      boardItem({
        sourceType: null,
        sourceContext: JSON.stringify({ origin: "slack_channel" }),
      }),
    );
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("slack_channel");
    expect(body).toContain("Came in from Slack");
  });
});

describe("TaskDrawer · never asserts provenance it does not have", () => {
  test("an item with no source shows no origin and no provenance pill", () => {
    renderDrawer(boardItem({ sourceType: null, sourceContext: null }));
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("You added this");
    expect(body).not.toContain("Came in from");
    expect(body).not.toContain("A watcher");
    // The Source section itself is absent rather than empty.
    expect(screen.queryByText("Source")).toBeNull();
    expect(screen.queryByLabelText(/^Why is this here\?/)).toBeNull();
  });

  test("a user-filed item claims no filing judgement", () => {
    // projectId set, autoFiledBy null — the user filed it, not Cue.
    renderDrawer(
      boardItem({ sourceType: null, projectId: "proj-1", autoFiledBy: null }),
    );
    expect(document.body.textContent ?? "").not.toContain("Cue filed this");
  });
});

describe("TaskDrawer · the judgement Cue made, one click away", () => {
  test("the trace names the destination and how sure Cue was, in words", () => {
    renderDrawer(
      boardItem({
        sourceType: "slack",
        projectId: "proj-1",
        autoFiledBy: "cue",
        autoFileConfidence: 0.93,
        ranProvenance: "you_approved",
      }),
    );

    fireEvent.click(screen.getByLabelText(/^Why is this here\?/));

    const panel = screen.getByLabelText("Where this came from");
    expect(panel.textContent).toContain("Came in from Slack");
    expect(panel.textContent).toContain(
      "Cue filed this into Seed raise itself — it was almost certain",
    );
    expect(panel.textContent).toContain("Cue ran this after you approved it");
    // Words, not digits.
    expect(panel.textContent).not.toContain("0.93");
    expect(panel.textContent).not.toContain("%");
  });
});
