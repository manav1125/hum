/**
 * Where reading became visible — the `N2` ruling.
 *
 * Reading happens on close, so two of `N2`'s four states happen when nobody
 * is looking at the note any more. The failed one is the defect that matters:
 * the note was fine, and nobody was ever told that the reading was not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { ReadState } from "./notes-page";

afterEach(() => {
  cleanup();
});

describe("the two states read-on-close orphaned", () => {
  test("a read in flight says so, where the person actually is", () => {
    render(<ReadState state="reading" />);
    expect(screen.getByText("Reading what you wrote…")).toBeTruthy();
  });

  test("REGRESSION: a failed read is visible at all", () => {
    // It used to happen entirely after close, so a note whose reading failed
    // looked exactly like a note with nothing to file. The reassurance is on
    // the part that matters: the writing survived.
    render(<ReadState state="failed" />);
    expect(
      screen.getByText(
        "I couldn’t read this one just now — your note is saved.",
      ),
    ).toBeTruthy();
  });

  test("a finished read says nothing — a note is allowed to just be a note", () => {
    const { container } = render(<ReadState state="done" />);
    expect(container.textContent).toBe("");
  });

  test("nor does one that has not started", () => {
    const { container } = render(<ReadState state="idle" />);
    expect(container.textContent).toBe("");
  });

  test("the two states are different sentences, not one with a flag", () => {
    // `N2`: distinct BY RULE — one is about the note, the other about the
    // request. The shared-component version is what ships the day somebody's
    // writing looks like it is gone.
    const reading = render(<ReadState state="reading" />).container.textContent;
    cleanup();
    const failed = render(<ReadState state="failed" />).container.textContent;
    expect(reading).not.toBe(failed);
    expect(failed).toContain("your note is saved");
  });
});
