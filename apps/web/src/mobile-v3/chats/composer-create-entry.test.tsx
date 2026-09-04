/**
 * The Create affordance's two widths.
 *
 * On a ≤439px viewport the composer's action row holds six unshrinkable 44px
 * affordances; the word "Create" was the ~53px that pushed the dictation mic
 * off the right edge of a 402px iPhone. Compact mode trades the word for the
 * fit — but only the word: the pencil, the sheet, and the accessible name are
 * the same button in both modes. These tests pin that trade so a future
 * "restore the label" edit cannot silently re-clip the mic, and a future
 * "always compact" edit cannot silently strip the label from wide phones.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { ComposerCreateEntry } from "./composer-create-entry";

afterEach(cleanup);

describe("ComposerCreateEntry", () => {
  test("renders the visible Create label by default", () => {
    render(<ComposerCreateEntry />);
    const button = screen.getByRole("button", { name: "Create something" });
    expect(button.textContent).toContain("Create");
  });

  test("compact drops the label but keeps the accessible name", () => {
    render(<ComposerCreateEntry compact />);
    const button = screen.getByRole("button", { name: "Create something" });
    expect(button.textContent).toBe("");
  });
});
