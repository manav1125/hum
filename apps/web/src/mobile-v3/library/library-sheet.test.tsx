/**
 * Library's second door (v24 F1) — the sheet that rises over whatever you are
 * doing.
 *
 * What is actually at risk here is not the styling; it is the promise. The
 * sheet exists so that "where's that file" does not cost you your place, and
 * that promise has exactly two halves:
 *
 *  1. **It leads with the current thing's files** and says so — "FROM RENEW
 *     ACME · 2". A sheet that opened on the generic gallery would be a
 *     navigation with extra steps.
 *  2. **Dismissing loses nothing.** The screen underneath is never unmounted
 *     and no state is thrown away, so the same sheet reopens where it was.
 *
 * Also asserted: a failed fetch is an ERROR state, not an empty gallery —
 * telling someone they have made nothing when the request merely failed is
 * the worse of the two lies.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";

import type { LibraryEntry } from "./library-model";

const NOW = Date.now();

function entry(over: Partial<LibraryEntry>): LibraryEntry {
  return {
    id: "o1",
    source: "output",
    workItemId: "w1",
    missionId: null,
    projectId: null,
    attachmentId: null,
    externalUrl: null,
    documentId: null,
    appId: null,
    kind: "document",
    title: "One-pager",
    why: null,
    agent: null,
    reviewState: "approved",
    createdAt: NOW - 86_400_000,
    attachment: null,
    ...over,
  } as LibraryEntry;
}

const ENTRIES: LibraryEntry[] = [
  entry({
    id: "a",
    title: "Acme one-pager v2",
    projectId: "acme",
    agent: "Ops",
  }),
  entry({
    id: "b",
    title: "Pricing v3",
    projectId: "acme",
    kind: "spreadsheet",
  }),
  entry({ id: "c", title: "Investor update", projectId: "seed" }),
  entry({ id: "d", title: "Halo hero", projectId: null, kind: "image" }),
];

let outputs = { entries: ENTRIES, isLoading: false, isError: false };

// Only the fetch seam is replaced — the model, the grid and the sheet shell
// are the real ones, which is the point of the test.
const outputsActual = await import("./use-library-outputs");
mock.module("./use-library-outputs", () => ({
  ...outputsActual,
  useLibraryOutputs: () => ({ ...outputs, refetch: () => {} }),
}));

const { Mv3LibrarySheet } = await import("./library-sheet");

const TITLES: Record<string, string> = {
  acme: "Renew Acme",
  seed: "Close the seed",
};

/** A host that keeps its own state, so "nothing lost" is observable. */
function Host() {
  const [open, setOpen] = useState(true);
  const [typed, setTyped] = useState("draft I was mid-way through");
  return (
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <div>
          <div data-testid="underneath">{typed}</div>
          <button type="button" onClick={() => setTyped(`${typed}!`)}>
            edit underneath
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <Mv3LibrarySheet
            assistantId="asst-1"
            open={open}
            onClose={() => setOpen(false)}
            contextProjectId="acme"
            contextProjectTitle="Renew Acme"
            thingTitleOf={(id) => (id ? (TITLES[id] ?? null) : null)}
          />
        </div>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  outputs = { entries: ENTRIES, isLoading: false, isError: false };
});

describe("opened from a thing", () => {
  test("leads with that thing's files, and says which thing", () => {
    render(<Host />);
    expect(screen.getByText("FROM RENEW ACME · 2")).toBeTruthy();
    expect(screen.getByText("EVERYTHING ELSE")).toBeTruthy();
  });

  test("the lead section holds exactly the thing's own output", () => {
    render(<Host />);
    const grid = screen.getByText("FROM RENEW ACME · 2").nextElementSibling!;
    const titles = grid.textContent ?? "";
    expect(titles).toContain("Acme one-pager v2");
    expect(titles).toContain("Pricing v3");
    expect(titles).not.toContain("Investor update");
  });

  test("every card names the agent AND the thing it was made for", () => {
    render(<Host />);
    // A real agent from the record…
    expect(screen.getByText(/◆ Ops · Renew Acme/)).toBeTruthy();
    // …and a null agent reads as Cue rather than blank.
    expect(screen.getByText(/◆ Cue · Close the seed/)).toBeTruthy();
  });

  test("nothing is dropped by the split — the whole library is still here", () => {
    render(<Host />);
    for (const e of ENTRIES) expect(screen.getByText(e.title)).toBeTruthy();
  });
});

describe("dismissal", () => {
  test("the sheet closes, the screen underneath keeps its state, and it reopens", () => {
    render(<Host />);
    fireEvent.click(screen.getByText("edit underneath"));
    expect(screen.getByTestId("underneath").textContent).toBe(
      "draft I was mid-way through!",
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByText("FROM RENEW ACME · 2")).toBeNull();
    // Nothing lost: the thing underneath never re-rendered from scratch.
    expect(screen.getByTestId("underneath").textContent).toBe(
      "draft I was mid-way through!",
    );

    fireEvent.click(screen.getByText("reopen"));
    expect(screen.getByText("FROM RENEW ACME · 2")).toBeTruthy();
  });

  test("the contract is stated on the sheet itself", () => {
    render(<Host />);
    expect(
      screen.getByText("Swipe down to go back · nothing lost"),
    ).toBeTruthy();
  });
});

describe("honest states", () => {
  test("a failed fetch is an error, never an empty gallery", () => {
    outputs = { entries: [], isLoading: false, isError: true };
    render(<Host />);
    expect(screen.getByText(/couldn’t load your library/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing here yet/i)).toBeNull();
  });

  test("a genuinely empty library says WHY it is empty, in a sentence", () => {
    outputs = { entries: [], isLoading: false, isError: false };
    render(<Host />);
    expect(
      screen.getByText(/Files, docs and apps you made with Cue/i),
    ).toBeTruthy();
    // …and says where the things it does NOT hold live, so an empty wall is
    // never mistaken for an empty account.
    expect(screen.getByText(/stay in their chat/i)).toBeTruthy();
  });
});

describe("no card wears a status the daemon did not report", () => {
  test("REVIEW rides only the entries that actually carry a review state", () => {
    // The owner's two visible cards were both badged ‖ REVIEW. That badge was
    // real for them (both work_outputs rows were `pending`) — but now that the
    // Library also holds documents, apps and files no run ever registered,
    // `reviewState` is legitimately null, and null is NOT pending.
    outputs = {
      entries: [
        entry({ id: "p", title: "Queued deck", reviewState: "pending" }),
        entry({
          id: "n",
          title: "Ubud itinerary",
          source: "document",
          documentId: "doc-1",
          workItemId: null,
          reviewState: null,
        }),
      ],
      isLoading: false,
      isError: false,
    };
    render(<Host />);
    // One badge on the wall, not two.
    expect(screen.getAllByText(/REVIEW/)).toHaveLength(1);
    expect(screen.getByText("Ubud itinerary")).toBeTruthy();
  });
});
