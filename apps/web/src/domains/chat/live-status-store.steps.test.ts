/**
 * Step-history + last-event coverage for the live-status store — the slice
 * the mobile live-activity block's step counter / mini-stream / watchdog
 * read. (The pre-existing thinking/runningTools behavior is covered by the
 * live-turn-status tests via `deriveLiveStatus`.)
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useLiveStatusStore } from "@/domains/chat/live-status-store";

const CONV = "conv-1";

describe("live-status step history", () => {
  beforeEach(() => {
    useLiveStatusStore.getState().resetAll();
  });

  test("tool start appends a running step and bumps the counter", () => {
    const s = useLiveStatusStore.getState();
    s.noteTurnStart(CONV);
    s.noteToolStart(CONV, { toolUseId: "t1", toolName: "bash" });
    const slice = useLiveStatusStore.getState().byConversation[CONV]!;
    expect(slice.stepCount).toBe(1);
    expect(slice.steps).toHaveLength(1);
    expect(slice.steps[0]!.endedAt).toBeNull();
    expect(slice.lastEventAt).not.toBeNull();
  });

  test("tool end marks the step finished but keeps it in history", () => {
    const s = useLiveStatusStore.getState();
    s.noteTurnStart(CONV);
    s.noteToolStart(CONV, { toolUseId: "t1", toolName: "bash" });
    s.noteToolEnd(CONV, "t1");
    const slice = useLiveStatusStore.getState().byConversation[CONV]!;
    expect(slice.runningTools).toHaveLength(0);
    expect(slice.steps).toHaveLength(1);
    expect(slice.steps[0]!.endedAt).not.toBeNull();
    expect(slice.stepCount).toBe(1);
  });

  test("step counter survives history eviction past the cap", () => {
    const s = useLiveStatusStore.getState();
    s.noteTurnStart(CONV);
    for (let i = 0; i < 20; i++) {
      s.noteToolStart(CONV, { toolUseId: `t${i}`, toolName: "bash" });
      s.noteToolEnd(CONV, `t${i}`);
    }
    const slice = useLiveStatusStore.getState().byConversation[CONV]!;
    expect(slice.stepCount).toBe(20);
    expect(slice.steps.length).toBeLessThanOrEqual(12);
    // Latest step retained.
    expect(slice.steps[slice.steps.length - 1]!.toolUseId).toBe("t19");
  });

  test("turn boundary clears steps, counter, and lastEventAt", () => {
    const s = useLiveStatusStore.getState();
    s.noteTurnStart(CONV);
    s.noteToolStart(CONV, { toolUseId: "t1", toolName: "bash" });
    s.noteTurnBoundary(CONV);
    const slice = useLiveStatusStore.getState().byConversation[CONV]!;
    expect(slice.steps).toHaveLength(0);
    expect(slice.stepCount).toBe(0);
    expect(slice.lastEventAt).toBeNull();
    expect(slice.turnStartedAt).not.toBeNull();
  });

  test("thinking deltas stamp lastEventAt", () => {
    const s = useLiveStatusStore.getState();
    s.noteTurnStart(CONV);
    s.noteThinkingDelta(CONV, "pondering");
    const slice = useLiveStatusStore.getState().byConversation[CONV]!;
    expect(slice.lastEventAt).not.toBeNull();
  });
});
