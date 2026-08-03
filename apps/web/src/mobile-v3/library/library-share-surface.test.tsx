/**
 * The share, as the phone actually renders it.
 *
 * The unit tests prove the runner reports a rejection as `failed`. That is
 * only half the promise — the other half is that the SURFACE does something
 * with it. A share that resolves `failed` into a card that dims and un-dims is
 * still a no-op, just one with a correct return type.
 *
 * So this file asserts, at the DOM:
 *
 *  · the ⇪ exists on outputs that have something behind it, and does not
 *    exist on the ones that don't, or on a shell that can't reach anywhere;
 *  · a failing share paints an error the user can read AND withholds the
 *    completion haptic — the mutation guard is that BOTH must hold, because
 *    "show the error and buzz success anyway" is the shape a half-fix takes;
 *  · a completed share buzzes `.medium` exactly once and says nothing;
 *  · a dismissed sheet is silent in both channels;
 *  · the footer prints the line the reach can back up.
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

import type { LibraryEntry } from "./library-model";
import type { ShareReach, ShareResult } from "./library-share";

const NOW = Date.now();

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "o1",
    workItemId: "w1",
    missionId: null,
    projectId: null,
    attachmentId: null,
    externalUrl: null,
    kind: "document",
    title: "Acme one-pager",
    why: null,
    agent: null,
    reviewState: "approved",
    createdAt: NOW,
    attachment: null,
    ...over,
  } as LibraryEntry;
}

const FILE_BACKED = entry({
  id: "f",
  attachmentId: "att-1",
  attachment: {
    id: "att-1",
    filename: "acme-one-pager.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    hasThumbnail: false,
  },
});
const BARE = entry({ id: "b", title: "Filed note" });

/* ------------------------------- the seams -------------------------------- */

let reach: ShareReach = "ios-sheet";
let outcome: ShareResult = { status: "shared" };
let shareCalls = 0;

const shareActual = await import("./library-share");
mock.module("./library-share", () => ({
  ...shareActual,
  detectShareReach: () => reach,
  shareLibraryEntry: async () => {
    shareCalls += 1;
    return outcome;
  },
}));

const buzzes: string[] = [];
const hapticsActual = await import("@/utils/haptics");
mock.module("@/utils/haptics", () => ({
  ...hapticsActual,
  haptic: {
    ...hapticsActual.haptic,
    light: () => {
      buzzes.push("light");
    },
    medium: () => {
      buzzes.push("medium");
    },
    error: () => {
      buzzes.push("error");
    },
  },
}));

// The cover fetch is the only network the grid does; it is irrelevant here
// and would otherwise 404 loudly for every card.
const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  attachmentsByIdContentGet: async () => ({ data: null }),
}));

const { LibraryGrid, LibraryFooterNote } = await import("./library-gallery");

function Wall({ entries }: { entries: LibraryEntry[] }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <LibraryGrid
        assistantId="asst-1"
        entries={entries}
        thingTitleOf={() => null}
        now={NOW}
        onOpen={() => {}}
      />
      <LibraryFooterNote entries={entries} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  reach = "ios-sheet";
  outcome = { status: "shared" };
  shareCalls = 0;
  buzzes.length = 0;
});

/* --------------------------- the affordance ------------------------------- */

describe("the ⇪ appears only where it leads somewhere", () => {
  test("a file-backed output on the iOS shell gets one", () => {
    render(<Wall entries={[FILE_BACKED]} />);
    expect(screen.getByLabelText("Share Acme one-pager")).toBeTruthy();
  });

  test("an output with no bytes and no URL gets none", () => {
    render(<Wall entries={[BARE]} />);
    expect(screen.queryByLabelText("Share Filed note")).toBeNull();
  });

  test("a shell that cannot share shows no ⇪ at all", () => {
    reach = "none";
    render(<Wall entries={[FILE_BACKED]} />);
    expect(screen.queryByLabelText("Share Acme one-pager")).toBeNull();
  });

  test("a link-only shell shows no ⇪ on a file-only output", () => {
    reach = "web-link";
    render(<Wall entries={[FILE_BACKED]} />);
    expect(screen.queryByLabelText("Share Acme one-pager")).toBeNull();
  });

  test("sharing does not also open the card", () => {
    let opened = 0;
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <LibraryGrid
          assistantId="asst-1"
          entries={[FILE_BACKED]}
          thingTitleOf={() => null}
          now={NOW}
          onOpen={() => {
            opened += 1;
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByLabelText("Share Acme one-pager"));
    expect(opened).toBe(0);
    expect(shareCalls).toBe(1);
  });
});

/* ------------------------------- outcomes --------------------------------- */

describe("what the surface does with the outcome", () => {
  /**
   * THE mutation check. Both halves are asserted on purpose: a surface that
   * renders the error but still fires `.medium` has "reported success" just
   * as surely as one that renders nothing, because the haptic IS the
   * completion signal on a phone.
   */
  test("a failed share renders as a failure — and does NOT report success", async () => {
    outcome = { status: "failed", message: "Couldn’t open the share sheet." };
    render(<Wall entries={[FILE_BACKED]} />);
    fireEvent.click(screen.getByLabelText("Share Acme one-pager"));

    const pill = await screen.findByRole("status");
    expect(pill.textContent).toContain("Couldn’t open the share sheet.");
    // The user is told the artefact did not leave the device.
    expect(pill.textContent).toContain("Nothing was sent.");
    expect(buzzes).toContain("error");
    expect(buzzes).not.toContain("medium");
  });

  test("bytes that never arrive surface as a failure too", async () => {
    outcome = { status: "failed", message: "Couldn’t fetch the file." };
    render(<Wall entries={[FILE_BACKED]} />);
    fireEvent.click(screen.getByLabelText("Share Acme one-pager"));

    const pill = await screen.findByRole("status");
    expect(pill.textContent).toContain("Couldn’t fetch the file.");
    expect(buzzes).not.toContain("medium");
  });

  test("a completed share buzzes .medium once and says nothing", async () => {
    outcome = { status: "shared" };
    render(<Wall entries={[FILE_BACKED]} />);
    fireEvent.click(screen.getByLabelText("Share Acme one-pager"));

    await waitFor(() => expect(buzzes).toContain("medium"));
    expect(buzzes.filter((b) => b === "medium")).toHaveLength(1);
    expect(buzzes).not.toContain("error");
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("no haptic fires on appear — only on a completed share", () => {
    render(<Wall entries={[FILE_BACKED]} />);
    expect(buzzes).toHaveLength(0);
  });

  test("backing out of the sheet is silent in both channels", async () => {
    outcome = { status: "dismissed" };
    render(<Wall entries={[FILE_BACKED]} />);
    fireEvent.click(screen.getByLabelText("Share Acme one-pager"));

    await waitFor(() => expect(shareCalls).toBe(1));
    expect(buzzes).not.toContain("medium");
    expect(buzzes).not.toContain("error");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/* -------------------------------- the copy -------------------------------- */

describe("the footer prints only what this shell can back up", () => {
  test("the iOS shell gets design's line", () => {
    render(<Wall entries={[FILE_BACKED]} />);
    expect(
      screen.getByText("Tap opens it here. ⇪ shares to Files, Mail, AirDrop."),
    ).toBeTruthy();
  });

  test("a shell with no share reach keeps the smaller, true line", () => {
    reach = "none";
    render(<Wall entries={[FILE_BACKED]} />);
    expect(screen.getByText("Tap opens it here.")).toBeTruthy();
    expect(screen.queryByText(/AirDrop/)).toBeNull();
  });

  test("the copy and the button never disagree: no ⇪ on the wall, no share promise in the footer", () => {
    render(<Wall entries={[BARE]} />);
    expect(screen.queryByLabelText(/^Share /)).toBeNull();
    expect(screen.getByText("Tap opens it here.")).toBeTruthy();
  });
});
