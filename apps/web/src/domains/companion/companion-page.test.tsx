/**
 * Tests for the desktop companion page (slice 1):
 *
 *   1. Status-awareness — the orb renders the pushed assistant status
 *      (idle default, `thinking` while a run is active), and the one-shot
 *      pull backfills the initial status without overwriting a push.
 *   2. Actions — expanding reports the resize to main, and the Talk /
 *      Open Cue buttons fire their IPC bridge stubs and collapse the card.
 *
 * The bridge module is mocked wholesale: the page is presentation over
 * `companion-bridge`, and the bridge's own off-Electron no-op behavior is
 * a one-liner guard per function, exercised implicitly by the default
 * `window.vellum`-less happy-dom environment.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AssistantStatus } from "@/runtime/is-electron";

let statusListeners: Array<(status: AssistantStatus) => void> = [];
let pulledStatus: AssistantStatus | null = "idle";

const setExpandedSpy = mock((_expanded: boolean) => Promise.resolve());
const talkSpy = mock(() => Promise.resolve());
const openCueSpy = mock(() => Promise.resolve());
const hideSpy = mock(() => Promise.resolve());
const getStatusSpy = mock(() => Promise.resolve(pulledStatus));

mock.module("@/domains/companion/companion-bridge", () => ({
  setCompanionExpanded: setExpandedSpy,
  companionTalk: talkSpy,
  companionOpenCue: openCueSpy,
  hideCompanion: hideSpy,
  getCompanionStatus: getStatusSpy,
  subscribeCompanionStatus: (callback: (status: AssistantStatus) => void) => {
    statusListeners.push(callback);
    return () => {
      statusListeners = statusListeners.filter((l) => l !== callback);
    };
  },
}));

const { CompanionPage } = await import("./companion-page");

const pushStatus = (status: AssistantStatus): void => {
  act(() => {
    for (const listener of [...statusListeners]) listener(status);
  });
};

const flushMicrotasks = () => act(async () => {});

beforeEach(() => {
  statusListeners = [];
  pulledStatus = "idle";
  setExpandedSpy.mockClear();
  talkSpy.mockClear();
  openCueSpy.mockClear();
  hideSpy.mockClear();
  getStatusSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CompanionPage status", () => {
  test("renders the idle orb by default and flips to thinking on a pushed status", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(screen.getByRole("status").dataset.state).toBe("idle");

    pushStatus("thinking");
    expect(screen.getByRole("status").dataset.state).toBe("thinking");

    pushStatus("idle");
    expect(screen.getByRole("status").dataset.state).toBe("idle");
  });

  test("backfills the initial status from the one-shot pull", async () => {
    pulledStatus = "thinking";
    render(<CompanionPage />);
    await flushMicrotasks();

    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").dataset.state).toBe("thinking");
  });

  test("a pushed status wins over a slower pull", async () => {
    let resolvePull: (status: AssistantStatus | null) => void = () => {};
    getStatusSpy.mockImplementationOnce(
      () =>
        new Promise<AssistantStatus | null>((resolve) => {
          resolvePull = resolve;
        }),
    );
    render(<CompanionPage />);

    pushStatus("thinking");
    await act(async () => {
      resolvePull("idle");
    });

    expect(screen.getByRole("status").dataset.state).toBe("thinking");
  });

  test("non-run statuses render the calm idle orb with a descriptive label", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    pushStatus("disconnected");
    const orb = screen.getByRole("status");
    expect(orb.dataset.state).toBe("idle");
    expect(orb.getAttribute("aria-label")).toBe("Disconnected");
  });
});

describe("CompanionPage actions", () => {
  test("clicking the orb expands to the mini card and reports the resize", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    );

    expect(setExpandedSpy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Talk" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Cue" })).toBeTruthy();
    expect(screen.getByTestId("companion-status").textContent).toBe("Idle");
  });

  test("Talk fires the talk IPC stub and collapses", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Talk" }));

    expect(talkSpy).toHaveBeenCalledTimes(1);
    expect(setExpandedSpy).toHaveBeenLastCalledWith(false);
    expect(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    ).toBeTruthy();
  });

  test("Open Cue fires the openCue IPC stub and collapses", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Cue" }));

    expect(openCueSpy).toHaveBeenCalledTimes(1);
    expect(setExpandedSpy).toHaveBeenLastCalledWith(false);
  });

  test("the collapse chevron returns to the orb", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Cue companion" }),
    );

    expect(setExpandedSpy).toHaveBeenLastCalledWith(false);
    expect(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    ).toBeTruthy();
  });

  test("the expanded card reflects a live status change", async () => {
    render(<CompanionPage />);
    await flushMicrotasks();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Cue companion" }),
    );

    pushStatus("thinking");

    expect(screen.getByTestId("companion-status").textContent).toBe("Working…");
    expect(screen.getByRole("status").dataset.state).toBe("thinking");
  });
});
