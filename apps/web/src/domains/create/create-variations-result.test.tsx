/**
 * Regression tests for the make-variations panel.
 *
 * The shipped bug: the panel always rendered a "4 variations" grid of empty
 * grey gradient tiles labelled FAITHFUL / CENTERED / SPLIT-LAYOUT / DARK. No
 * preview was ever produced for them (no host passes `preview` in), so the
 * boxes read as images that failed to load and the user had to choose blind.
 *
 * These tests pin the two modes apart: without previews the panel is an honest
 * CHOOSER that describes each direction in words and generates the one picked;
 * with previews it is the comparison grid (Pick / Merge).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { DEFAULT_VARIATIONS } from "./create-remix";
import {
  VariationsResult,
  type VariationResult,
} from "./create-variations-result";

afterEach(() => {
  cleanup();
});

const DIRECTIONS: VariationResult[] = DEFAULT_VARIATIONS.map((v) => ({
  index: v.index,
  variant: v.variant,
  description: v.description,
}));

const RESULTS: VariationResult[] = DIRECTIONS.map((v) => ({
  ...v,
  preview: <div data-testid={`preview-${v.index}`} />,
}));

function renderPanel(
  variations: VariationResult[],
  props: Partial<React.ComponentProps<typeof VariationsResult>> = {},
) {
  return render(
    <VariationsResult
      title="Make a variation"
      variations={variations}
      onRegenerateAll={() => {}}
      onPick={() => {}}
      onMerge={() => {}}
      {...props}
    />,
  );
}

function buttonWith(text: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`expected a button containing "${text}"`);
  return button;
}

describe("chooser mode (no previews — the situation today)", () => {
  test("every card states what its direction changes, in words", () => {
    renderPanel(DIRECTIONS);
    for (const v of DEFAULT_VARIATIONS) {
      expect(v.description.length).toBeGreaterThan(20);
      expect(document.body.textContent).toContain(v.description);
    }
  });

  test("cards say they have not been made, rather than implying a result", () => {
    renderPanel(DIRECTIONS);
    expect(document.body.textContent).toContain("not made yet");
    expect(document.body.textContent).toContain(
      "Nothing is generated yet — pick a direction to make",
    );
  });

  test("the primary action names what it does and reports the chosen index", () => {
    const onPick = mock((_index: number) => {});
    renderPanel(DIRECTIONS, { onPick });
    const make = buttonWith("Make this one");
    expect(make.disabled).toBe(false);
    // Select the split-layout direction, then make it.
    fireEvent.click(buttonWith("Direction 3"));
    fireEvent.click(make);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe(3);
  });

  test("merge and regenerate-all are absent — there is nothing to merge or redo", () => {
    renderPanel(DIRECTIONS);
    expect(document.body.textContent).not.toContain("Merge");
    expect(document.body.textContent).not.toContain("Regenerate all");
  });
});

describe("results mode (host injected real previews)", () => {
  test("renders the injected previews and the pick/merge grid", () => {
    renderPanel(RESULTS);
    expect(document.querySelector('[data-testid="preview-1"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Pick this");
    expect(document.body.textContent).toContain("Merge selected");
    expect(document.body.textContent).toContain("Regenerate all");
    expect(document.body.textContent).not.toContain("not made yet");
  });

  test("merge needs two selections and reports them sorted", () => {
    const onMerge = mock((_indexes: number[]) => {});
    renderPanel(RESULTS, { onMerge });
    expect(buttonWith("Merge selected").disabled).toBe(true);
    fireEvent.click(buttonWith("Variation 3"));
    const merge = buttonWith("Merge selected");
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(onMerge.mock.calls[0][0]).toEqual([1, 3]);
  });
});
