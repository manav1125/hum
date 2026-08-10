/**
 * The review panel printed the item body twice.
 *
 * `extractWorkItemResult` (assistant/src/work-items/work-item-run-result.ts)
 * stores the last assistant message as `summary`, then scans that *same* text
 * for bullet lines and stores them as `highlights`. Any run whose prose
 * contained bullets therefore had two fields carrying the same sentences, and
 * the panel rendered both — prose first, then the identical list underneath.
 *
 * It also stored prose-derived entries with their leading "-" while
 * tool-derived ones had none, so the renderer's own `- ${h}` produced "- -".
 */

import { describe, expect, test } from "vitest";

import { novelHighlights } from "./run-output";

describe("novelHighlights", () => {
  test("drops bullets the summary already contains", () => {
    const summary = "Here is what I did:\n- Emailed Priya\n- Booked the room";
    expect(
      novelHighlights(summary, ["- Emailed Priya", "- Booked the room"]),
    ).toEqual([]);
  });

  test("keeps tool outcomes the prose never mentioned", () => {
    const summary = "Here is what I did:\n- Emailed Priya";
    expect(
      novelHighlights(summary, ["- Emailed Priya", "Read 12 calendar events"]),
    ).toEqual(["Read 12 calendar events"]);
  });

  test("strips the leading marker so the renderer cannot double it", () => {
    // The renderer emits `- ${h}`; a stored "- x" would have rendered "- - x".
    expect(novelHighlights(null, ["- one", "* two", "three"])).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("matches across differing whitespace", () => {
    const summary = "Did the thing:\n-   Emailed    Priya";
    expect(novelHighlights(summary, ["- Emailed Priya"])).toEqual([]);
  });

  test("with no summary every highlight is novel", () => {
    expect(novelHighlights(null, ["- a", "- b"])).toEqual(["a", "b"]);
  });

  test("discards entries that were only a bullet marker", () => {
    expect(novelHighlights(null, ["-", "  ", "- real"])).toEqual(["real"]);
  });
});
