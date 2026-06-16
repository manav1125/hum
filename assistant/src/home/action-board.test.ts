/**
 * Unit tests for the pure action-board enrichment logic.
 */

import { describe, expect, it } from "bun:test";

import { detectConflicts } from "./action-board.js";

interface E {
  summary: string;
  start: string;
  end: string;
  attendees: number;
  location: string;
}
const ev = (summary: string, start: string, end: string): E => ({
  summary,
  start,
  end,
  attendees: 0,
  location: "",
});

describe("detectConflicts", () => {
  it("flags overlapping timed events", () => {
    const conflicts = detectConflicts([
      ev("A", "2026-06-17T09:00:00Z", "2026-06-17T10:00:00Z"),
      ev("B", "2026-06-17T09:30:00Z", "2026-06-17T10:30:00Z"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0][0].summary).toBe("A");
    expect(conflicts[0][1].summary).toBe("B");
  });

  it("does NOT flag back-to-back events (half-open intervals)", () => {
    const conflicts = detectConflicts([
      ev("A", "2026-06-17T09:00:00Z", "2026-06-17T10:00:00Z"),
      ev("B", "2026-06-17T10:00:00Z", "2026-06-17T11:00:00Z"),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("ignores all-day events (date-only, unparseable as timestamps)", () => {
    const conflicts = detectConflicts([
      ev("All day", "2026-06-17", "2026-06-18"),
      ev("Meeting", "2026-06-17T09:00:00Z", "2026-06-17T10:00:00Z"),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("finds every overlapping pair among three concurrent events", () => {
    const conflicts = detectConflicts([
      ev("A", "2026-06-17T09:00:00Z", "2026-06-17T11:00:00Z"),
      ev("B", "2026-06-17T09:30:00Z", "2026-06-17T10:30:00Z"),
      ev("C", "2026-06-17T10:00:00Z", "2026-06-17T12:00:00Z"),
    ]);
    // A∩B, A∩C, B∩C
    expect(conflicts).toHaveLength(3);
  });

  it("returns nothing for a clear schedule", () => {
    expect(
      detectConflicts([
        ev("A", "2026-06-17T09:00:00Z", "2026-06-17T09:30:00Z"),
        ev("B", "2026-06-17T14:00:00Z", "2026-06-17T15:00:00Z"),
      ]),
    ).toHaveLength(0);
  });
});
