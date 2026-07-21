/**
 * Tests for the task drawer's pre-run assessment surface — the visible half of
 * "Cue understood this before it ran it".
 *
 * Covers each verdict's affordance: `execute` shows the understanding + plan
 * and keeps the ▶ row, `clarify` shows the ONE question with an inline answer
 * that writes into the task's context, `not_ai_task` stops offering a run as
 * the primary action, `blocked` names the missing thing and offers the real
 * fix — plus the fail-open case, where an item with no verdict renders exactly
 * as it did before assessment existed. The run trail's narrated rows are
 * checked here too, since they land on the same surface.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`). The
 * generated SDK is mocked so the events read and the context PATCH resolve
 * locally instead of reaching for a daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { ProjectsByIdWorkitemsGetResponses } from "@/generated/daemon/types.gen";

type BoardItem = ProjectsByIdWorkitemsGetResponses[200]["items"][number];
type TrailEvent = {
  id: string;
  workItemId: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  detail: string | null;
  at: number;
};

const ASSISTANT_ID = "asst-1";
const ITEM_ID = "wi-1";

const okResponse = { response: new Response(), error: undefined };
let trail: TrailEvent[] = [];

const sdkActual = await import("@/generated/daemon/sdk.gen");
const patchSpy = mock(async (options: { body: unknown }) => ({
  data: { item: null, ...(options.body as object) },
  ...okResponse,
}));
const runSpy = mock(async () => ({ data: { success: true }, ...okResponse }));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  workitemsByIdEventsGet: mock(async () => ({
    data: { events: trail, cycleTimeMs: null },
    ...okResponse,
  })),
  workitemsByIdPatch: patchSpy,
  workitemsByIdRunPost: runSpy,
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
    sourceType: "email",
    sourceId: null,
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
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function renderDrawer(
  item: BoardItem,
  opts: { onAttachKnowledge?: () => void } = {},
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/projects/proj-1"]}>
        <TaskDrawer
          assistantId={ASSISTANT_ID}
          item={item}
          projects={[]}
          currentProjectId="proj-1"
          onClose={() => {}}
          onAttachKnowledge={opts.onAttachKnowledge}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  patchSpy.mockClear();
  runSpy.mockClear();
  trail = [];
});

describe("TaskDrawer · pre-run assessment", () => {
  test("execute shows what Cue understood and what it will do, and still offers the run", () => {
    // GIVEN an item Cue understood and can do
    renderDrawer(
      boardItem({
        assessmentVerdict: "execute",
        assessmentUnderstanding:
          "Write the quarterly update email to the board and send it.",
        assessmentPlan:
          "Read the Q2 deck from project knowledge, draft the email, and show it to you before sending.",
        assessmentConfidence: 0.9,
        assessmentAt: 1_760_000_100_000,
      }),
    );

    // THEN both halves of the understanding are visible before it runs
    expect(screen.getByText("Here is what I understood")).toBeDefined();
    expect(
      screen.getByText(
        "Write the quarterly update email to the board and send it.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Here is my plan")).toBeDefined();
    expect(
      screen.getByText(
        "Read the Q2 deck from project knowledge, draft the email, and show it to you before sending.",
      ),
    ).toBeDefined();

    // AND the normal primary action is untouched
    expect(
      screen.getByRole("button", { name: /Have Cue handle it/ }),
    ).toBeDefined();
  });

  test("clarify asks one question, holds the run, and writes the answer into the task context", async () => {
    // GIVEN an item parked on a single question
    const item = boardItem({
      assessmentVerdict: "clarify",
      assessmentQuestion: "Which board list should this go to?",
      assessmentUnderstanding: "Send a quarterly update to the board.",
      assessmentConfidence: 0.8,
      assessmentAt: 1_760_000_100_000,
      context: "Keep it under a page.",
    });
    renderDrawer(item);

    // THEN the question is stated plainly, and the loud run row stands down
    expect(
      screen.getByText("Which board list should this go to?"),
    ).toBeDefined();
    expect(
      screen.getByText(/I need one thing before I can run this/),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Have Cue handle it/ }),
    ).toBeNull();
    // AND the override is still there, quietly
    expect(screen.getByRole("button", { name: "Run it anyway" })).toBeDefined();

    // WHEN the user answers inline
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "The investor list in Notion." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    // THEN the answer is saved onto the item's own context, alongside the
    // question it answers and whatever context was already there
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    const body = patchSpy.mock.calls[0]?.[0]?.body as { context: string };
    expect(body.context).toContain("Keep it under a page.");
    expect(body.context).toContain("Which board list should this go to?");
    expect(body.context).toContain("The investor list in Notion.");
  });

  test("not_ai_task stops offering a run as the primary action", () => {
    // GIVEN an item Cue says belongs to a person
    renderDrawer(
      boardItem({
        title: "Sign the office lease",
        assessmentVerdict: "not_ai_task",
        assessmentUnderstanding:
          "Sign the lease in person at the landlord's office.",
        assessmentConfidence: 0.9,
        assessmentAt: 1_760_000_100_000,
      }),
    );

    // THEN it says so honestly, and ▶ is no longer the primary action
    expect(screen.getByText("This one needs a person, not Cue.")).toBeDefined();
    expect(
      screen.getByText("Sign the lease in person at the landlord's office."),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Have Cue handle it/ }),
    ).toBeNull();

    // AND the human-appropriate close leads, with the override de-emphasised
    expect(screen.getByRole("button", { name: "Mark it done" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Ask Cue anyway" }),
    ).toBeDefined();
  });

  test("blocked names the missing thing and offers the fix that exists", () => {
    // GIVEN an item blocked on a file that was never attached
    const onAttachKnowledge = mock(() => {});
    renderDrawer(
      boardItem({
        assessmentVerdict: "blocked",
        assessmentMissing:
          "The Q2 financials file is not attached to this project.",
        assessmentConfidence: 0.85,
        assessmentAt: 1_760_000_100_000,
      }),
      { onAttachKnowledge },
    );

    // THEN the one missing thing is named, and the fix goes somewhere real
    expect(
      screen.getByText(
        "The Q2 financials file is not attached to this project.",
      ),
    ).toBeDefined();
    const fix = screen.getByRole("button", {
      name: "Attach it to this project",
    });
    fireEvent.click(fix);
    expect(onAttachKnowledge).toHaveBeenCalledTimes(1);
  });

  test("blocked with no fix destination says what is needed instead of a dead button", () => {
    // GIVEN a blocked item whose missing thing maps to no surface we have
    renderDrawer(
      boardItem({
        assessmentVerdict: "blocked",
        assessmentMissing: "The decision on which vendor won the bid.",
        assessmentAt: 1_760_000_100_000,
      }),
    );

    // THEN no fix button is invented, and the copy says what to do
    expect(
      screen.getByText("The decision on which vendor won the bid."),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Connect an account/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Attach it to this project/ }),
    ).toBeNull();
    expect(screen.getByText(/Add it in Context below/)).toBeDefined();
  });

  test("an unassessed item renders exactly as before", () => {
    // GIVEN an item with no verdict (never dispatched, or the assessment
    // failed open)
    renderDrawer(boardItem());

    // THEN there is no panel at all — no empty shell, no pending spinner
    expect(screen.queryByText("Here is what I understood")).toBeNull();
    expect(
      screen.queryByText(/I need one thing before I can run this/),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Have Cue handle it/ }),
    ).toBeDefined();
  });

  test("the trail reads as sentences for narrated rows", async () => {
    // GIVEN a run that recorded its verdict and one of its steps
    trail = [
      {
        id: "ev-1",
        workItemId: ITEM_ID,
        kind: "assessed",
        fromStatus: null,
        toStatus: null,
        actor: "assessor",
        detail: "Understood: draft the board update. Plan: read the Q2 deck.",
        at: 1_760_000_100_000,
      },
      {
        id: "ev-2",
        workItemId: ITEM_ID,
        kind: "run_step",
        fromStatus: null,
        toStatus: null,
        actor: "runner",
        detail: "Reading Q2-deck.pdf from project knowledge",
        at: 1_760_000_200_000,
      },
      {
        id: "ev-3",
        workItemId: ITEM_ID,
        kind: "status_changed",
        fromStatus: "queued",
        toStatus: "running",
        actor: "runner",
        detail: null,
        at: 1_760_000_300_000,
      },
    ];
    renderDrawer(boardItem({ status: "running" }));

    // THEN the narrated rows read as plain sentences, and the lifecycle row
    // keeps its transition
    expect(
      await screen.findByText("Reading Q2-deck.pdf from project knowledge"),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Understood: draft the board update. Plan: read the Q2 deck.",
      ),
    ).toBeDefined();
    expect(screen.getByText("queued → running")).toBeDefined();
  });
});
