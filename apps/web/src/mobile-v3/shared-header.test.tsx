/**
 * SharedMobileHeader — the frame-54 header grammar:
 *  · ≤2 icon actions (extras dropped);
 *  · count rides only on the ACTIVE pill;
 *  · pill taps report through onPillChange;
 *  · condense math is pure and clamped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

import {
  CONDENSE_RANGE,
  condenseProgress,
  pillLabel,
  SharedMobileHeader,
  type SharedHeaderPill,
} from "./shared-header";

afterEach(cleanup);

describe("condenseProgress", () => {
  test("clamps 0→1 across the condense range", () => {
    expect(condenseProgress(-30)).toBe(0);
    expect(condenseProgress(0)).toBe(0);
    expect(condenseProgress(CONDENSE_RANGE / 2)).toBeCloseTo(0.5);
    expect(condenseProgress(CONDENSE_RANGE)).toBe(1);
    expect(condenseProgress(CONDENSE_RANGE * 4)).toBe(1);
  });
});

describe("pillLabel", () => {
  const pill: SharedHeaderPill = { value: "all", label: "All", count: 214 };

  test("shows the count only while active", () => {
    expect(pillLabel(pill, true)).toBe("All · 214");
    expect(pillLabel(pill, false)).toBe("All");
  });

  test("active pill without a count keeps the bare label", () => {
    expect(pillLabel({ value: "x", label: "Frequent" }, true)).toBe("Frequent");
  });
});

describe("SharedMobileHeader", () => {
  test("renders back label, title, and drops actions beyond two", () => {
    render(
      createElement(SharedMobileHeader, {
        backLabel: "You",
        onBack: () => {},
        title: "Contacts",
        actions: [
          { key: "a", label: "Search", icon: "⌕", onPress: () => {} },
          { key: "b", label: "Add", icon: "+", onPress: () => {} },
          { key: "c", label: "Never shown", icon: "x", onPress: () => {} },
        ],
      }),
    );
    expect(screen.getByText(/‹ You/)).toBeTruthy();
    // Large title + hidden compact copy both carry the text.
    expect(screen.getAllByText("Contacts").length).toBe(2);
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Never shown" })).toBeNull();
  });

  test("pills: count on active only, taps report through onPillChange", () => {
    const changes: string[] = [];
    render(
      createElement(SharedMobileHeader, {
        backLabel: "You",
        onBack: () => {},
        title: "Contacts",
        pills: [
          { value: "all", label: "All", count: 214 },
          { value: "agents", label: "Agents", count: 3 },
        ],
        activePill: "all",
        onPillChange: (v: string) => changes.push(v),
      }),
    );
    expect(screen.getByText("All · 214")).toBeTruthy();
    // Inactive pill hides its count.
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.queryByText("Agents · 3")).toBeNull();

    fireEvent.click(screen.getByText("Agents"));
    expect(changes).toEqual(["agents"]);
  });

  test("back button fires onBack", () => {
    let backs = 0;
    render(
      createElement(SharedMobileHeader, {
        backLabel: "You",
        onBack: () => {
          backs += 1;
        },
        title: "Files",
      }),
    );
    fireEvent.click(screen.getByText(/‹ You/));
    expect(backs).toBe(1);
  });
});
