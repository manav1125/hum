/**
 * Coach-mark tour gating — the "stop showing me this" contract.
 *
 * The reported bug was tips replaying at random on an account that had been
 * using Cue for weeks. Three properties are pinned here, each one a mechanism
 * that produced that:
 *
 *  1. A tour ENDS when the user ends it. "Got it" / × retires the whole
 *     surface, so the remaining tips can never come back one at a time on a
 *     later visit.
 *  2. A tour never CASCADES. If the step it wants to point at isn't on this
 *     surface, it waits — it does not skip ahead to whichever later anchor
 *     happens to be mounted (which is how a lone "4 of 4" tip appeared out of
 *     nowhere, long after landing on the page).
 *  3. "Skip tour" is offered on every surface — including the single-tip ones,
 *     which is most of them — and means never again, anywhere.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`). The
 * DOM anchors are planted by hand, exactly as a real surface would render them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { routes } from "@/utils/routes";

import { FeatureTour } from "./feature-tour";
import { COACH_DISABLED_KEY } from "./use-feature-tour";

/** Both HQ one-time welcomes settled, so the HQ tour is allowed to run. */
function settleHqWelcomes(): void {
  localStorage.setItem("cue:hq-orientation-seen", "native");
  localStorage.setItem("cue:hq:firstrun:v1", "1");
}

function plantAnchor(anchor: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-coach", anchor);
  el.textContent = anchor;
  document.body.append(el);
  return el;
}

function renderTour(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FeatureTour />
    </MemoryRouter>,
  );
}

/** The hook waits `SETTLE_MS` (450) before showing a resolved target. */
const SETTLED = 700;

/** Let the settle timer fire, with React's state updates wrapped for act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, SETTLED));
  });
}

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("FeatureTour · when a tip is allowed to show", () => {
  test("ending the tour retires the whole surface — no tip-by-tip replay later", async () => {
    settleHqWelcomes();
    // GIVEN every HQ anchor is on the page, so all four steps are showable
    plantAnchor("hq-capture");
    plantAnchor("hq-lanes");
    plantAnchor("hq-rings");
    plantAnchor("hq-agents");

    const first = renderTour(routes.hq);
    await settle();
    expect(screen.getByText("Drop anything here")).toBeDefined();

    // WHEN the user ends the run on the FIRST step rather than walking it
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss tip" }));
    });
    expect(screen.queryByText("Drop anything here")).toBeNull();
    first.unmount();
    cleanup();

    // THEN a fresh visit brings back nothing — not step 2, not step 4
    renderTour(routes.hq);
    await settle();
    expect(screen.queryByText("Drop anything here")).toBeNull();
    expect(screen.queryByText("Your work, in motion")).toBeNull();
    expect(screen.queryByText("Who's on the clock")).toBeNull();
  });

  test("a missing anchor does not cascade to a later mounted one", async () => {
    settleHqWelcomes();
    // GIVEN the HQ layout that has no capture/lanes/rings — only the agents
    // strip — which is what a pulse-layout HQ actually renders
    plantAnchor("hq-agents");

    renderTour(routes.hq);
    await settle();

    // THEN nothing is shown: step 1's target isn't here, and the tour does not
    // go hunting for step 4 to point at instead.
    expect(screen.queryByText("Who's on the clock")).toBeNull();
    expect(screen.queryByText("Drop anything here")).toBeNull();
  });

  test("a single-tip surface still offers a permanent opt-out", async () => {
    // GIVEN a surface whose tour is one step (most of them are)
    plantAnchor("projects-new");
    const first = renderTour(routes.projects);
    await settle();
    expect(screen.getByText("Group work into things")).toBeDefined();

    // THEN "Skip tour" is offered here too — not only on multi-step surfaces
    const skip = screen.getByRole("button", { name: "Skip tour" });

    // WHEN it's used
    act(() => {
      fireEvent.click(skip);
    });
    expect(localStorage.getItem(COACH_DISABLED_KEY)).not.toBeNull();
    first.unmount();
    cleanup();

    // THEN it means never again — on this surface or any other
    document.body.replaceChildren();
    plantAnchor("memory-teach");
    renderTour(routes.memory);
    await settle();
    expect(screen.queryByText("What Cue remembers")).toBeNull();
  });

  test("a surface already marked done in storage never arms", async () => {
    settleHqWelcomes();
    localStorage.setItem("cue:coach:surface:hq", "1");
    plantAnchor("hq-capture");

    renderTour(routes.hq);
    await settle();

    expect(screen.queryByText("Drop anything here")).toBeNull();
  });
});
