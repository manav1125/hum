import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  useMobileLayout: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { CommandPalette } =
  await import("@/components/command-palette/command-palette");
const { useCommandPalette } =
  await import("@/components/command-palette/use-command-palette");

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
});

describe("CommandPalette", () => {
  test("uses compact desktop styling inside the floating window even at mobile widths", () => {
    isMobileRef.value = true;

    render(
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => undefined}
        query=""
        onQueryChange={() => undefined}
        selectedIndex={0}
        sections={[
          {
            id: "actions",
            label: "Actions",
            items: [{ id: "new", title: "New Conversation" }],
          },
        ]}
        onKeyDown={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog.className).toContain("bg-transparent");
    expect(dialog.className).not.toContain("absolute");

    const panel = dialog.firstElementChild as HTMLElement | null;
    expect(panel?.className).toContain("bg-[var(--surface-base)]");

    const selected = screen.getByRole("option", { selected: true });
    expect(selected.className).toContain("h-10");
    expect(selected.className).toContain("text-sm");
  });
});

/**
 * The bug, driven end to end: the real hook, the real fetch seam, the real
 * component. `searchGlobal` used to swallow a 500 into four empty arrays, and
 * this palette painted that as "No results" — telling the user their data does
 * not exist when the truth was that we could not look.
 *
 * Every assertion below fails against that old behaviour: there was no alert to
 * find, and "No results" was exactly what appeared.
 */
describe("what the palette says when the search itself failed", () => {
  /** The real hook wired to the real component — nothing between them. */
  function Harness({ assistantId }: { assistantId: string | null }) {
    const palette = useCommandPalette({
      itemCount: 0,
      assistantId,
      isOpen: true,
    });
    return (
      <CommandPalette
        isOpen
        onClose={palette.close}
        query={palette.query}
        onQueryChange={palette.setQuery}
        selectedIndex={palette.selectedIndex}
        // Empty on purpose: this isolates the server half of the palette, the
        // half that used to lie.
        sections={[]}
        isSearching={palette.isSearching}
        searchOutcome={palette.searchOutcome}
        onKeyDown={palette.handleKeyDown}
      />
    );
  }

  async function typeQuery(
    stub: (typeof globalThis)["fetch"],
    value: string,
    assistantId: string | null = "assistant-1",
  ) {
    const real = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      render(<Harness assistantId={assistantId} />);
      fireEvent.change(screen.getByLabelText("Search"), { target: { value } });
      // The hook debounces 150ms before it asks the daemon anything.
      await waitFor(
        () => expect(screen.queryByText("Searching…")).toBeNull(),
        { timeout: 2000 },
      );
    } finally {
      globalThis.fetch = real;
    }
  }

  test("a 500 shows Cue's own words in an alert — and never 'No results'", async () => {
    await typeQuery(
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      "acme",
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("I couldn't reach my search index");
    expect(alert.textContent).toContain("500");
    expect(alert.textContent).toContain("Nothing was searched");

    // The whole point: a failure must not be dressed as an absence.
    expect(screen.queryByText("No results")).toBeNull();
    expect(screen.queryByText(/Nothing matched/)).toBeNull();
  });

  test("a dropped connection reads the same way", async () => {
    await typeQuery(
      (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
      "acme",
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was searched");
    expect(screen.queryByText("No results")).toBeNull();
  });

  test("a genuine no-match says so, and says what was searched", async () => {
    await typeQuery(
      (async () =>
        new Response(
          JSON.stringify({
            query: "zzz",
            results: {
              conversations: [],
              memories: [],
              schedules: [],
              contacts: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      "zzz",
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Nothing matched “zzz”/).textContent,
      ).toContain("I searched your conversations, schedules and people"),
    );
    // No alarm, no red: an empty answer is not a failure either.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("no assistant yet says why instead of showing an empty list", async () => {
    await typeQuery(
      (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
      "acme",
      null,
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("I'm not connected to your Cue yet");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No results")).toBeNull();
  });
});
