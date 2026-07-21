/**
 * Tests for the MOBILE task sheet's pre-run assessment surface — the phone half
 * of "Cue understood this before it ran it".
 *
 * The verdict vocabulary is the desktop drawer's, so these cover the same four
 * affordances on mv3 chrome: `execute` shows the understanding + plan and keeps
 * "▶ Have Cue handle it", `clarify` asks the ONE question and writes the answer
 * into the task's own context, `not_ai_task` stops leading with a run (it
 * offers "Mark it done", with "Ask Cue anyway" kept as the quiet override), and
 * `blocked` names the missing thing and offers the real fix. Plus the fail-open
 * case: an item with no verdict renders exactly as it did before assessment
 * existed.
 *
 * Mounted via `@testing-library/react` (happy-dom). The generated SDK is mocked
 * so the run / complete / PATCH writes resolve locally instead of reaching for
 * a daemon.
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

import type { HqWorkItem } from "@/pages/hq/use-missions";

const ASSISTANT_ID = "asst-1";
const ITEM_ID = "wi-1";
const NOW = 1_760_000_000_000;

const okResponse = { response: new Response(), error: undefined };

const sdkActual = await import("@/generated/daemon/sdk.gen");
const patchSpy = mock(async (options: { body: unknown }) => ({
  data: { item: null, ...(options.body as object) },
  ...okResponse,
}));
const runSpy = mock(async () => ({ data: { success: true }, ...okResponse }));
const completeSpy = mock(async () => ({
  data: { success: true },
  ...okResponse,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  workitemsByIdPatch: patchSpy,
  workitemsByIdRunPost: runSpy,
  workitemsByIdCompletePost: completeSpy,
}));

const { Mv3TaskSheet } = await import("./mv3-task-sheet");

function item(over: Partial<HqWorkItem> = {}): HqWorkItem {
  return {
    id: ITEM_ID,
    taskId: "task-1",
    title: "Summarise the advisory-board transcript",
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
    assessmentVerdict: null,
    assessmentUnderstanding: null,
    assessmentPlan: null,
    assessmentQuestion: null,
    assessmentMissing: null,
    assessmentConfidence: null,
    assessmentAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as HqWorkItem;
}

function renderSheet(
  workItem: HqWorkItem,
  opts: { onAttachKnowledge?: () => void } = {},
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/work"]}>
        <Mv3TaskSheet
          assistantId={ASSISTANT_ID}
          item={workItem}
          projects={[]}
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
  completeSpy.mockClear();
});

describe("Mv3TaskSheet · pre-run assessment", () => {
  test("execute shows what Cue understood and what it will do, and still offers the run", () => {
    // GIVEN an item Cue understood and can do
    renderSheet(
      item({
        assessmentVerdict: "execute",
        assessmentUnderstanding:
          "Summarise the September advisory-board transcript.",
        assessmentPlan:
          "Read the transcript from project knowledge, then write a one-page summary.",
        assessmentConfidence: 0.9,
        assessmentAt: NOW,
      }),
    );

    // THEN both halves of the read are visible before it runs
    expect(screen.getByText("Here is what I understood")).toBeDefined();
    expect(
      screen.getByText("Summarise the September advisory-board transcript."),
    ).toBeDefined();
    expect(screen.getByText("Here is my plan")).toBeDefined();

    // AND the sheet's normal primary action is untouched
    expect(
      screen.getByRole("button", { name: /Have Cue handle it/ }),
    ).toBeDefined();
  });

  test("clarify asks one question, holds the run, and writes the answer into the task context", async () => {
    // GIVEN an item parked on a single question
    renderSheet(
      item({
        assessmentVerdict: "clarify",
        assessmentQuestion: "Which session should I summarise — June or September?",
        assessmentConfidence: 0.8,
        assessmentAt: NOW,
        context: "Keep it under a page.",
      }),
    );

    // THEN the question is stated plainly and the loud ▶ stands down
    expect(
      screen.getByText("Which session should I summarise — June or September?"),
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
      target: { value: "September." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    // THEN the answer lands on the item's own context, alongside the question
    // it answers and whatever context was already there
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    const body = patchSpy.mock.calls[0]?.[0]?.body as { context: string };
    expect(body.context).toContain("Keep it under a page.");
    expect(body.context).toContain(
      "Which session should I summarise — June or September?",
    );
    expect(body.context).toContain("September.");
  });

  test("not_ai_task never leads with ▶ — it offers the human close, override kept quiet", () => {
    // GIVEN an item Cue says belongs to a person
    renderSheet(
      item({
        title: "Sign the office lease",
        assessmentVerdict: "not_ai_task",
        assessmentUnderstanding:
          "Sign the lease in person at the landlord's office.",
        assessmentConfidence: 0.9,
        assessmentAt: NOW,
      }),
    );

    // THEN it says so honestly, and ▶ is gone from the action stack
    expect(screen.getByText("This one needs a person, not Cue.")).toBeDefined();
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
    renderSheet(
      item({
        assessmentVerdict: "blocked",
        assessmentMissing: "The advisory-board transcript is not attached.",
        assessmentConfidence: 0.85,
        assessmentAt: NOW,
      }),
      { onAttachKnowledge },
    );

    // THEN the one missing thing is named, ▶ stands down, and the fix goes
    // somewhere real
    expect(
      screen.getByText("The advisory-board transcript is not attached."),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Have Cue handle it/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Attach it to this project" }),
    );
    expect(onAttachKnowledge).toHaveBeenCalledTimes(1);
  });

  test("blocked with no fix destination says what is needed instead of a dead button", () => {
    // GIVEN a blocked item whose missing thing maps to no surface we have
    renderSheet(
      item({
        assessmentVerdict: "blocked",
        assessmentMissing: "The decision on which vendor won the bid.",
        assessmentAt: NOW,
      }),
    );

    // THEN no fix button is invented, and the phone offers the write-back that
    // actually un-sticks it (the sheet has no Context editor to point at)
    expect(
      screen.getByText("The decision on which vendor won the bid."),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Connect an account/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Attach it to this project/ }),
    ).toBeNull();
    expect(screen.getByLabelText("Your answer")).toBeDefined();
  });

  test("an unassessed item renders exactly as before", () => {
    // GIVEN an item with no verdict (never dispatched, or assessment failed
    // open)
    renderSheet(item());

    // THEN there is no panel at all — no empty shell, no pending spinner
    expect(screen.queryByText("Here is what I understood")).toBeNull();
    expect(
      screen.queryByText(/I need one thing before I can run this/),
    ).toBeNull();
    expect(screen.queryByLabelText("Your answer")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Have Cue handle it/ }),
    ).toBeDefined();
  });
});
