/**
 * Tests for the first-run explainer's ONE promise: `once`.
 *
 * The shipped version wrote its seen-flag from the dismiss button and from
 * nothing else, so a user who scrolled past the block — the natural thing to do
 * when it sits between the composer and the work — got it back on every visit
 * forever. Nothing gated it on the account being new either, so an account with
 * missions and ninety-odd tracked items was still shown "here's how Cue works".
 *
 * The mutations this suite is calibrated against:
 *
 *   1. move the `markShown()` write back into `dismiss` only — "being shown is
 *      itself the once" fails;
 *   2. drop the `established` gate — "an account with work in it is never
 *      taught the loop" fails;
 *   3. drop the storage write from `dismiss` — "dismissing stays dismissed"
 *      fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HqFirstRun, useHqFirstRun } from "@/pages/hq/hq-firstrun";

const STORAGE_KEY = "cue:hq:firstrun:v1";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

/** The exact wiring HQ uses: the hook decides, the block renders, `Got it` dismisses. */
function Host({ established = false }: { established?: boolean }) {
  const firstRun = useHqFirstRun({ established });
  return firstRun.show ? (
    <HqFirstRun onDismiss={firstRun.dismiss} />
  ) : (
    <div>no explainer</div>
  );
}

describe("who sees it", () => {
  test("a genuinely new account gets the loop, in one line", () => {
    render(<Host />);
    expect(screen.getByText("It picks things up")).toBeTruthy();
    expect(screen.getByText("It does the work")).toBeTruthy();
    expect(screen.getByText("You sign off")).toBeTruthy();
  });

  test("an account that already has work in it is never taught the loop", () => {
    render(<Host established />);
    expect(screen.queryByText("It picks things up")).toBeNull();
    // …and it does not burn the once: a fresh profile that is merely mid-load
    // must still get its one showing.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("once means once", () => {
  test("dismissing makes it stay dismissed", () => {
    render(<Host />);
    fireEvent.click(screen.getByText("Got it"));
    expect(screen.queryByText("It picks things up")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // A whole new visit — the component remounts and re-reads storage.
    cleanup();
    render(<Host />);
    expect(screen.getByText("no explainer")).toBeTruthy();
  });

  test("being shown is itself the once — scrolling past does not buy a rerun", () => {
    render(<Host />);
    expect(screen.getByText("It picks things up")).toBeTruthy();
    // The user never clicks; they navigate away.
    cleanup();

    render(<Host />);
    expect(screen.getByText("no explainer")).toBeTruthy();
  });
});
