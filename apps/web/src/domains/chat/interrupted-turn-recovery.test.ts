import { describe, expect, test } from "bun:test";

import { markMessageInterrupted } from "@/domains/chat/interrupted-turn-recovery";
import type { DisplayMessage } from "@/domains/chat/types/types";

function msg(overrides: Partial<DisplayMessage>): DisplayMessage {
  return { id: "m", role: "assistant", ...overrides };
}

describe("markMessageInterrupted", () => {
  test("flags the row matching the id", () => {
    const messages = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1" }),
      msg({ id: "a2" }),
    ];
    const next = markMessageInterrupted(messages, "a2");
    expect(next.find((m) => m.id === "a2")?.interrupted).toBe(true);
    expect(next.find((m) => m.id === "a1")?.interrupted).toBeUndefined();
    expect(next.find((m) => m.id === "u1")?.interrupted).toBeUndefined();
  });

  test("flags a consolidated row via mergedMessageIds", () => {
    const messages = [msg({ id: "a1", mergedMessageIds: ["a2", "a3"] })];
    const next = markMessageInterrupted(messages, "a3");
    expect(next[0].interrupted).toBe(true);
  });

  test("returns the same array when nothing matches or already flagged", () => {
    const messages = [msg({ id: "a1" })];
    expect(markMessageInterrupted(messages, "zz")).toBe(messages);
    const flagged = [msg({ id: "a1", interrupted: true })];
    expect(markMessageInterrupted(flagged, "a1")).toBe(flagged);
  });
});
