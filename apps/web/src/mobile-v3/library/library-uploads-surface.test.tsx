/**
 * Library search reaches uploads — on the screen, not just in the model.
 *
 * Three claims that only a rendered surface can prove, and each is one the
 * pure-function tests structurally cannot:
 *
 *  1. **An upload-only match still appears.** Before this, the results region
 *     short-circuited on `visible.length === 0` and rendered "Nothing in your
 *     library matches…" — so the one search that most needed the uploads
 *     section was the one that swallowed it. That branch is the bug; this is
 *     the test that holds it fixed.
 *  2. **Failing open.** A failed uploads search must not blank the
 *     made-with-Cue results beside it. The two are separate queries, and this
 *     asserts the separation is real rather than intended.
 *  3. **The header's claim stays true.** The main grid never gains an upload,
 *     so "N things made with Cue" keeps covering exactly what is above the
 *     rule.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { LibraryEntry } from "./library-model";
import type { UploadHit, UploadSearchState } from "./library-search";

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
  entry({ id: "a", title: "Acme one-pager v2", projectId: "acme" }),
  entry({ id: "b", title: "Pricing v3", kind: "spreadsheet" }),
];

function hit(id: string, filename: string): UploadHit {
  return {
    id,
    original_filename: filename,
    mime_type: "application/pdf",
    size_bytes: 10,
    kind: "document",
    created_at: NOW - 3 * 86_400_000,
    thumbnail_base64: null,
    sourceConversation: { id: "conv-9", title: "Acme renewal" },
  } as UploadHit;
}

let outputs = { entries: ENTRIES, isLoading: false, isError: false };
let uploadState: UploadSearchState = { status: "idle" };

// Only the two fetch seams are replaced. The model, the grid, the section and
// the sheet shell are all real — the whole point is that the wiring between
// them is what is under test. Both factories spread the real module (the
// mock.module registry is process-global; a hand-written export list would
// delete the rest for every file that runs after this one).
const outputsActual = await import("./use-library-outputs");
mock.module("./use-library-outputs", () => ({
  ...outputsActual,
  useLibraryOutputs: () => ({ ...outputs, refetch: () => {} }),
}));

const uploadActual = await import("./use-upload-search");
mock.module("./use-upload-search", () => ({
  ...uploadActual,
  useUploadSearch: () => uploadState,
}));

const { Mv3LibrarySheet } = await import("./library-sheet");

function Host() {
  return (
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <Mv3LibrarySheet
          assistantId="asst-1"
          open
          onClose={() => {}}
          contextProjectId={null}
          contextProjectTitle={null}
          thingTitleOf={() => null}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * Render the sheet and drive its REAL search affordance — open the box, type
 * the query. Reaching in with a test-only prop would leave the one branch that
 * caused the bug (the results region's short-circuit) untested.
 */
function renderSearching(query: string): void {
  render(<Host />);
  fireEvent.click(screen.getByLabelText("Search the library"));
  fireEvent.change(screen.getByLabelText("Search your library"), {
    target: { value: query },
  });
}

afterEach(() => {
  cleanup();
  outputs = { entries: ENTRIES, isLoading: false, isError: false };
  uploadState = { status: "idle" };
});

const SECTION = "Things you sent · in their chats";

describe("uploads reach the screen", () => {
  test("an upload-only match is NOT swallowed by the empty state", () => {
    // Nothing made with Cue matches, but the owner did send a matching file.
    // This is the exact search the old short-circuit lost.
    uploadState = {
      status: "whole",
      query: "contract",
      rows: [hit("u1", "acme-contract.pdf")],
      truncated: false,
    };
    renderSearching("contract");

    expect(screen.getByText(SECTION)).toBeTruthy();
    expect(screen.getByText("acme-contract.pdf")).toBeTruthy();
    // …and the surface does not simultaneously claim nothing matched.
    expect(screen.queryByText(/^Nothing matches/)).toBeNull();
  });

  test("the row is a door back to the thread it lives in", () => {
    uploadState = {
      status: "whole",
      query: "contract",
      rows: [hit("u1", "acme-contract.pdf")],
      truncated: false,
    };
    renderSearching("contract");

    const row = screen.getByLabelText("acme-contract.pdf, in Acme renewal");
    expect(row.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Acme renewal ›")).toBeTruthy();
  });

  test("uploads and made-with-Cue results appear together, separated", () => {
    uploadState = {
      status: "whole",
      query: "acme",
      rows: [hit("u1", "acme-contract.pdf")],
      truncated: false,
    };
    renderSearching("acme");

    // The made-with-Cue result is still in the main grid…
    expect(screen.getByText("Acme one-pager v2")).toBeTruthy();
    // …and the upload is under its own heading, not mixed into it.
    expect(screen.getByText(SECTION)).toBeTruthy();
    expect(screen.getByText("acme-contract.pdf")).toBeTruthy();
  });
});

describe("failing open", () => {
  test("a failed uploads search does not blank the main results", () => {
    uploadState = {
      status: "failed",
      query: "acme",
      note: "I couldn't search the things you sent (500). Your files are still in their chats.",
    };
    renderSearching("acme");

    // The main result survives the side query's failure — the whole point.
    expect(screen.getByText("Acme one-pager v2")).toBeTruthy();
    // And the failure is stated rather than rendered as "you sent nothing".
    expect(screen.getByText(/couldn't search the things you sent/)).toBeTruthy();
  });

  test("with no main results either, the empty state admits it is partial", () => {
    uploadState = {
      status: "failed",
      query: "zzz",
      note: "I couldn't search the things you sent. Your files are still in their chats.",
    };
    renderSearching("zzz");

    // Never a flat "nothing matches" over a search that only half happened.
    expect(screen.getByText(/couldn't search the things you sent/)).toBeTruthy();
  });

  test("a search that DID reach everything and found nothing says so plainly", () => {
    uploadState = { status: "whole", query: "zzz", rows: [], truncated: false };
    renderSearching("zzz");

    const note = screen.getByText(/^Nothing matches/);
    expect(note.textContent).toContain("what you sent it");
    expect(note.textContent).not.toMatch(/couldn't/);
    // No heading over an empty section.
    expect(screen.queryByText(SECTION)).toBeNull();
  });
});

describe("the header's claim stays true", () => {
  test("an upload never enters the made-with-Cue grid", () => {
    uploadState = {
      status: "whole",
      query: "acme",
      rows: [hit("u1", "acme-contract.pdf")],
      truncated: false,
    };
    renderSearching("acme");

    // The upload's filename appears exactly once on the screen, and it is
    // below the section heading — not as a card in the gallery above it.
    const section = screen.getByText(SECTION);
    const file = screen.getByText("acme-contract.pdf");
    expect(
      section.compareDocumentPosition(file) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("a capped uploads answer says so rather than printing a total", () => {
    uploadState = {
      status: "whole",
      query: "report",
      rows: [hit("u1", "report-1.pdf"), hit("u2", "report-2.pdf")],
      truncated: true,
    };
    renderSearching("report");

    expect(screen.getByText(/most recent — there are more/)).toBeTruthy();
    expect(screen.queryByText(/^2 things you sent/)).toBeNull();
  });
});
