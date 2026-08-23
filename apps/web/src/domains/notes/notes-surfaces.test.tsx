/**
 * The Notes surfaces actually render, and say the honest thing in each state.
 *
 * These exist because the two real defects found by running the app both
 * passed typecheck and lint cleanly:
 *
 *   · `CornerPage` called `useActiveAssistantId()`, which THROWS outside the
 *     auth gate — on a route whose whole point is being outside it;
 *   · the Notes list sat on "Loading…" forever, and a failed request drew the
 *     empty state, which tells someone they have no notes when the truth is
 *     that we could not ask.
 *
 * A type checker cannot see either. Rendering can. So each panel below is
 * mounted for real, and the assertions are about the sentence a person ends
 * up reading — particularly in the states where the honest sentence and the
 * convenient one differ.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";

/**
 * Stub only the query seams these panels read. The rest of the generated
 * module stays real — an exhaustive factory would delete every other export
 * for every file that runs after this one.
 */
const queryGenActual =
  await import("@/generated/daemon/@tanstack/react-query.gen");

/** What each stubbed endpoint returns, swapped per test. */
const responses: Record<string, unknown> = {};

const optionsFor = (key: string) => () => ({
  queryKey: [key],
  queryFn: () => Promise.resolve(responses[key] ?? null),
});

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...queryGenActual,
  notesAcceptratesGetOptions: optionsFor("acceptRates"),
  notesByIdCreateoptionsGetOptions: optionsFor("createOptions"),
  notesAskPostMutation: () => ({
    mutationFn: () => Promise.resolve(responses.ask ?? null),
  }),
}));

const { NoteAcceptRate } = await import("./note-accept-rate");
const { NoteCreateOptions } = await import("./note-create-options");

function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, node),
    ),
  );
}

/** Wait for a query-backed panel to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  cleanup();
  for (const key of Object.keys(responses)) delete responses[key];
});

describe("the accept-rate readout", () => {
  test("renders nothing until something has actually been decided", async () => {
    responses.acceptRates = {
      rates: [
        {
          kind: "task",
          confidenceTier: "confident",
          proposed: 3,
          accepted: 0,
          dismissed: 0,
        },
      ],
    };
    const { container } = mount(
      createElement(NoteAcceptRate, { assistantId: "a1" }),
    );
    await settle();

    // Three proposals nobody has decided is not a rate. Inventing one would
    // be worse than showing none.
    expect(container.textContent).not.toContain("%");
  });

  test("reports accepted-of-decided, split by tier", async () => {
    responses.acceptRates = {
      rates: [
        {
          kind: "task",
          confidenceTier: "confident",
          proposed: 0,
          accepted: 3,
          dismissed: 1,
        },
        {
          kind: "task",
          confidenceTier: "unsure",
          proposed: 0,
          accepted: 1,
          dismissed: 3,
        },
      ],
    };
    mount(createElement(NoteAcceptRate, { assistantId: "a1" }));
    await settle();

    expect(screen.getByText(/3 of 4 kept/)).toBeDefined();
    expect(screen.getByText(/1 of 4 kept/)).toBeDefined();
    // The tiers fail differently, so they are never merged into one number.
    expect(screen.getByText(/less sure/)).toBeDefined();
  });

  test("states the response to a low rate, so it cannot be argued later", async () => {
    responses.acceptRates = {
      rates: [
        {
          kind: "task",
          confidenceTier: "confident",
          proposed: 0,
          accepted: 1,
          dismissed: 9,
        },
      ],
    };
    mount(createElement(NoteAcceptRate, { assistantId: "a1" }));
    await settle();

    // "Fewer and better, not asking more often" is the decision the brief
    // makes in advance — a feature that responds to being ignored by asking
    // louder is how a rail becomes a thing people scroll past.
    expect(screen.getByText(/fewer and better/)).toBeDefined();
  });
});

describe("note → Create", () => {
  test("offers the note's plausible outputs", async () => {
    responses.createOptions = {
      options: [
        { kind: "deck", label: "A deck", prompt: "…" },
        { kind: "email", label: "An email", prompt: "…" },
      ],
    };
    mount(
      createElement(NoteCreateOptions, { assistantId: "a1", noteId: "n1" }),
    );
    await settle();

    expect(screen.getByText("A deck")).toBeDefined();
    expect(screen.getByText("An email")).toBeDefined();
  });

  test("states that provenance runs one way", async () => {
    responses.createOptions = {
      options: [{ kind: "deck", label: "A deck", prompt: "…" }],
    };
    mount(
      createElement(NoteCreateOptions, { assistantId: "a1", noteId: "n1" }),
    );
    await settle();

    // The same rule as note → task: deleting the note never deletes the deck.
    expect(screen.getByText(/never deletes it/)).toBeDefined();
  });

  test("renders nothing at all when there is nothing to make", async () => {
    responses.createOptions = { options: [] };
    const { container } = mount(
      createElement(NoteCreateOptions, { assistantId: "a1", noteId: "n1" }),
    );
    await settle();

    // A "make something from this" heading over no options is a dead button.
    expect(container.textContent).toBe("");
  });
});
