/**
 * Work's header chrome — the ruling that Library is a VIEW, not a destination.
 *
 * v23 revised its own R1: with four tab slots the mark sits off-centre, so the
 * fourth was cut and Library became Work's third view. "Desktop already does
 * this. Library IS work output, so it belongs inside the tab called Work
 * rather than competing with it."
 *
 * Two things must stay true or that ruling quietly un-ships:
 *  · the control has EXACTLY three segments, and Library is one of them —
 *    three is stated as the phone's ceiling, so a fourth is a regression, and
 *    a missing Library means the destination was dropped without a home;
 *  · the counts line never prints a leg it cannot back.
 *
 * Both are read off {@link WORK_VIEWS}, the same declaration desktop's
 * switcher renders, so this also guards against the two platforms disagreeing
 * about what Work contains.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

let navCounts = { things: 5, everything: 31, agentsWorking: true };
let needsYou = { count: 3, approvals: 0 };

const navCountsActual = await import("@/components/nav/use-nav-counts");
mock.module("@/components/nav/use-nav-counts", () => ({
  ...navCountsActual,
  useNavCounts: () => navCounts,
}));

const badgeActual = await import("@/hooks/use-needs-you-badge");
mock.module("@/hooks/use-needs-you-badge", () => ({
  ...badgeActual,
  useNeedsYouBadge: () => needsYou,
}));

const { WorkCountsLine, WorkSegmented } = await import("./work-kit");

afterEach(() => {
  cleanup();
  navCounts = { things: 5, everything: 31, agentsWorking: true };
  needsYou = { count: 3, approvals: 0 };
});

describe("the segmented control", () => {
  test("has exactly three segments — three is the phone's ceiling", () => {
    render(
      <MemoryRouter>
        <WorkSegmented current="things" />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  test("Library is one of them, beside Things and Everything", () => {
    render(
      <MemoryRouter>
        <WorkSegmented current="things" />
      </MemoryRouter>,
    );
    expect(
      screen.getAllByRole("tab").map((t) => t.textContent),
    ).toEqual(["Things", "Everything", "Library"]);
  });

  test("the current view is the selected tab — including Library", () => {
    render(
      <MemoryRouter>
        <WorkSegmented current="library" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Library",
    );
  });

  test("every segment is reachable — no view you cannot get back out of", () => {
    render(
      <MemoryRouter>
        <WorkSegmented current="library" />
      </MemoryRouter>,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-selected")).toBeTruthy();
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("the counts line", () => {
  test("reads the same two sources the rail's badges do", () => {
    render(<WorkCountsLine assistantId="asst-1" />);
    expect(screen.getByText("5 things · 31 open · 3 need you")).toBeTruthy();
  });

  test("drops the legs it cannot back rather than printing zeros", () => {
    navCounts = { things: 1, everything: 0, agentsWorking: false };
    needsYou = { count: 0, approvals: 0 };
    render(<WorkCountsLine assistantId="asst-1" />);
    expect(screen.getByText("1 thing")).toBeTruthy();
  });

  test("Library replaces the line with what it actually made", () => {
    render(
      <WorkCountsLine
        assistantId="asst-1"
        override="48 things Cue made · 11 this week"
      />,
    );
    expect(
      screen.getByText("48 things Cue made · 11 this week"),
    ).toBeTruthy();
    expect(screen.queryByText(/need you/)).toBeNull();
  });
});
