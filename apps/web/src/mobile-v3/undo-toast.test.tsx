/**
 * useDismissTask / UndoToast — the round-4.1 (frame 65) additions on the
 * shared undo machinery:
 *  · the pill carries a VISIBLE countdown on the Undo chip ("Undo · 5s")
 *    in the resting (bottom-anchored) state, not just promoted
 *  · rapid dismissals COALESCE into one pill ("2 archived — Undo") and one
 *    Undo restores every item in the batch
 *  · after the pill clears, the next dismissal starts a FRESH batch (single
 *    "Archived —" line again)
 * The engine (dismiss-core PATCHes) is mocked — these tests exercise the
 * presentation contract only.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

import type { HqWorkItem } from "@/pages/hq/use-missions";

const undoCalls: string[] = [];

mock.module("@/pages/projects/dismiss-core", () => ({
  // Fake engine: archive always lands synchronously; undo records the id.
  useDismissEngine: (
    _assistantId: string,
    handlers: {
      onArchived: (item: HqWorkItem, undo: () => void) => void;
    },
  ) => ({
    dismiss: (item: HqWorkItem) =>
      handlers.onArchived(item, () => undoCalls.push(item.id)),
    gone: new Set<string>(),
    leavingId: null,
  }),
}));

import { useDismissTask } from "./undo-toast";

function item(id: string): HqWorkItem {
  return { id, title: `Task ${id}`, status: "pending" } as HqWorkItem;
}

function Harness() {
  const { dismiss, toastNode } = useDismissTask("assistant-1");
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { onClick: () => dismiss(item("t1"), { immediate: true }) },
      "dismiss-1",
    ),
    createElement(
      "button",
      { onClick: () => dismiss(item("t2"), { immediate: true }) },
      "dismiss-2",
    ),
    toastNode,
  );
}

afterEach(() => {
  cleanup();
  undoCalls.length = 0;
});

describe("useDismissTask (frame 65)", () => {
  test("single dismissal: honest line + visible countdown at rest", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("dismiss-1"));
    expect(
      screen.getByText("Archived — Cue learns from what you skip"),
    ).toBeTruthy();
    // The countdown is visible on the RESTING pill (no sheet open → 5s).
    expect(screen.getByText("Undo · 5s")).toBeTruthy();
  });

  test("rapid dismissals coalesce; one Undo restores the whole batch", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("dismiss-1"));
    fireEvent.click(screen.getByText("dismiss-2"));
    // One pill max — the label states the count.
    expect(screen.getByText("2 archived")).toBeTruthy();
    expect(
      screen.queryByText("Archived — Cue learns from what you skip"),
    ).toBeNull();
    // Undo restores BOTH.
    fireEvent.click(screen.getByText("Undo · 5s"));
    expect(undoCalls).toEqual(["t1", "t2"]);
    // The pill is gone after Undo.
    expect(screen.queryByText("2 archived")).toBeNull();
  });

  test("a cleared pill resets the batch — the next dismissal is single again", () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("dismiss-1"));
    fireEvent.click(screen.getByText("Undo · 5s"));
    expect(undoCalls).toEqual(["t1"]);
    // Fresh batch: back to the single-archive line, not "2 archived".
    fireEvent.click(screen.getByText("dismiss-2"));
    expect(
      screen.getByText("Archived — Cue learns from what you skip"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Undo · 5s"));
    expect(undoCalls).toEqual(["t1", "t2"]);
  });
});
