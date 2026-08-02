/**
 * The phone's ⓜ menu — the corner that holds everything the three tabs dropped.
 *
 * What is actually at risk here is not the pixels, it is agreement. This menu
 * spent a release listing `CUE_NAV`'s six (Agents · Skills · Rhythms · Memory ·
 * Library · Watching) while the desktop rail had already retired that grouping
 * for two destinations and a door — so the two platforms were describing
 * different products from one codebase. The tests below hold the menu to the
 * SHARED model rather than to a hardcoded list of labels, which is the only
 * version of this assertion that cannot go stale the same way.
 *
 * And one navigation fact, because it is the bug that hid the longest: every
 * leaf on the phone's You screen carries `back={routes.channels}`, but until
 * the Your Cue row existed nothing navigated FORWARD there. The mode dial, the
 * track record and thirteen rows were reachable only by backing out of one of
 * their own children.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";

import {
  SIDEBAR_DESTINATIONS,
  YOUR_CUE_DOOR,
} from "@/components/nav/nav-model";
import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";

let userName: string | null = "Manav";

const homeQueryActual =
  await import("@/domains/home/hooks/use-home-state-query");
mock.module("@/domains/home/hooks/use-home-state-query", () => ({
  ...homeQueryActual,
  useHomeStateQuery: () => ({ data: { userName } }),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => ASSISTANT_ID },
  },
}));

const { Mv3OverflowMenu } = await import("./overflow-menu");

/** Renders the chrome plus a location probe, so navigation is observable. */
function renderMenu() {
  return render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        { initialEntries: [routes.hq] },
        createElement(Mv3OverflowMenu),
        createElement(LocationProbe),
      ),
    ),
  );
}

function LocationProbe() {
  return createElement(
    "div",
    { "data-testid": "path" },
    useLocation().pathname,
  );
}

/** Opens the right-hand menu and returns its menuitem labels, in order. */
function openAccountMenu(): string[] {
  const button = screen.getByRole("button", { name: /People, Library/i });
  fireEvent.click(button);
  return screen
    .getAllByRole("menuitem")
    .map((el) => el.textContent?.replace(/›/g, "").trim() ?? "");
}

afterEach(() => {
  userName = "Manav";
  cleanup();
});

describe("the ⓜ menu agrees with the desktop rail", () => {
  test("lists every shared sidebar destination, by the model's own label", () => {
    renderMenu();
    const labels = openAccountMenu();
    for (const destination of SIDEBAR_DESTINATIONS) {
      expect(labels.some((l) => l.startsWith(destination.label))).toBe(true);
    }
  });

  test("names the door exactly what the desktop rail names it", () => {
    renderMenu();
    const labels = openAccountMenu();
    expect(labels.some((l) => l.startsWith(YOUR_CUE_DOOR.label))).toBe(true);
  });

  test("the destinations come before the door", () => {
    renderMenu();
    const labels = openAccountMenu();
    const door = labels.findIndex((l) => l.startsWith(YOUR_CUE_DOOR.label));
    for (const destination of SIDEBAR_DESTINATIONS) {
      const at = labels.findIndex((l) => l.startsWith(destination.label));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(door);
    }
  });

  test("no longer renders the retired CUE group as destinations", () => {
    renderMenu();
    const labels = openAccountMenu();
    // These are leaves inside Your Cue now — rows on the You screen, one tap
    // behind the door. A top-level row here is the old information model.
    for (const retired of ["Agents", "Skills", "Rhythms", "Memory"]) {
      expect(labels).not.toContain(retired);
    }
  });
});

describe("a row that renders is a row that navigates", () => {
  test("Your Cue lands on the phone's You screen, not the Identity leaf", () => {
    renderMenu();
    openAccountMenu();
    const door = screen
      .getAllByRole("menuitem")
      .find((el) => el.textContent?.startsWith(YOUR_CUE_DOOR.label));
    expect(door).toBeDefined();
    fireEvent.click(door!);
    expect(screen.getByTestId("path").textContent).toBe(routes.channels);
  });

  test("People lands on People", () => {
    renderMenu();
    openAccountMenu();
    const row = screen
      .getAllByRole("menuitem")
      .find((el) => el.textContent?.startsWith("People"));
    fireEvent.click(row!);
    expect(screen.getByTestId("path").textContent).toBe(routes.people);
  });
});

describe("the button is the owner, honestly", () => {
  test("carries the signed-in user's initial", () => {
    renderMenu();
    expect(
      screen.getByRole("button", { name: /Manav — People, Library/ }),
    ).toBeDefined();
  });

  test("with no name on file it does not invent one", () => {
    userName = null;
    renderMenu();
    // Not a letter — a letter would read as an initial Cue does not have.
    const button = screen.getByRole("button", {
      name: /^You — People, Library/,
    });
    expect(button.textContent).toBe("☺");
  });
});
