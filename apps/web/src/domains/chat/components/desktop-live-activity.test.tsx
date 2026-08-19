/**
 * Tests for `DesktopLiveActivity`, the pinned "Cue is working" strip above
 * the desktop composer.
 *
 * What these pin is the distinction the strip exists to make: a turn that is
 * grinding away must look different from one that has died, and a turn that
 * is waiting on the USER must look different from both. Desktop previously
 * had no way to tell any of them apart once the transcript scrolled.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

// Spread the real module — mock.module is process-global, and a hand-written
// export list would delete every other export for later test files.
const actualHook = await import("@/domains/chat/components/use-live-activity");

type Activity = ReturnType<typeof actualHook.useLiveActivity>;

let activity: Activity;
const checkStatus = mock(() => {});

mock.module("@/domains/chat/components/use-live-activity", () => ({
  ...actualHook,
  useLiveActivity: () => activity,
}));

const { DesktopLiveActivity } =
  await import("@/domains/chat/components/desktop-live-activity");

function makeActivity(over: Partial<Activity> = {}): Activity {
  return {
    view: {
      state: "working",
      text: "Searching the web",
      label: "",
      detail: "",
    },
    isWaiting: false,
    visibleSteps: [],
    subParts: [],
    showWatchdog: false,
    silentFor: 0,
    checking: false,
    checkStatus,
    ...over,
  } as Activity;
}

afterEach(() => {
  cleanup();
  checkStatus.mockClear();
});

describe("DesktopLiveActivity", () => {
  test("renders nothing when there is no live view", () => {
    activity = makeActivity({ view: null as unknown as Activity["view"] });
    const { container } = render(<DesktopLiveActivity />);
    expect(container.firstChild).toBeNull();
  });

  test("a working turn shows the activity and an animated pulse", () => {
    // The pulse is the whole point: a static row is what made a live turn
    // and a dead one indistinguishable.
    activity = makeActivity({ subParts: ["Step 4", "1m 12s"] });
    render(<DesktopLiveActivity />);

    expect(screen.getByText("Searching the web")).toBeTruthy();
    expect(screen.getByText("Step 4 · 1m 12s")).toBeTruthy();
    expect(screen.getByTestId("desktop-live-activity-pulse")).toBeTruthy();
  });

  test("waiting on the user drops the pulse and hides the step stream", () => {
    // A pending question is not progress — showing running steps under it
    // would tell the user to keep waiting when Cue has stopped for them.
    activity = makeActivity({
      view: {
        state: "waiting",
        text: "",
        label: "Waiting on you",
        detail: "",
      } as Activity["view"],
      isWaiting: true,
      visibleSteps: [
        {
          toolUseId: "t1",
          toolName: "web_search",
          input: {},
          endedAt: null,
        } as unknown as Activity["visibleSteps"][number],
      ],
    });
    render(<DesktopLiveActivity />);

    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.queryByTestId("desktop-live-activity-pulse")).toBeNull();
    expect(screen.queryByText("Searching the web")).toBeNull();
  });

  test("prolonged silence offers a check-status rescue that reconciles", () => {
    activity = makeActivity({ showWatchdog: true, silentFor: 130_000 });
    render(<DesktopLiveActivity />);

    const btn = screen.getByRole("button", { name: "Check status" });
    btn.click();
    expect(checkStatus).toHaveBeenCalledTimes(1);
  });

  test("the rescue button is disabled while a check is in flight", () => {
    activity = makeActivity({ showWatchdog: true, checking: true });
    render(<DesktopLiveActivity />);

    const btn = screen.getByRole("button", { name: "Checking…" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  test("is announced politely to assistive tech", () => {
    activity = makeActivity();
    render(<DesktopLiveActivity />);
    const el = screen.getByTestId("desktop-live-activity");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
});
