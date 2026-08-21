/**
 * The watchdog's wiring: that the timer really calls the repair, and really
 * stops. The decision logic is unit-tested separately; this is the half that
 * would otherwise be assumed.
 */

import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

const restoreCalls: Array<[string, string]> = [];
const actualRestore =
  await import("@/domains/chat/utils/restore-pending-interactions");
mock.module("@/domains/chat/utils/restore-pending-interactions", () => ({
  ...actualRestore,
  restorePendingInteractions: async (a: string, c: string) => {
    restoreCalls.push([a, c]);
  },
}));

const { useTurnStore } = await import("@/domains/chat/turn-store");
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { usePendingInteractionWatchdog, PENDING_INTERACTION_POLL_MS } =
  await import("@/domains/chat/hooks/use-pending-interaction-watchdog");

const CONV = "conv-1";

function mount() {
  return renderHook(() =>
    usePendingInteractionWatchdog({
      assistantId: "asst-1",
      activeConversationId: CONV,
      assistantStateKind: "active",
    }),
  );
}

function turnRunning() {
  useConversationStore.getState().setActiveConversationId(CONV);
  useTurnStore.setState({ activeTurnId: "turn-1" });
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  restoreCalls.length = 0;
  useTurnStore.setState({ activeTurnId: null });
  useInteractionStore.getState().resetAll();
});

describe("watchdog wiring", () => {
  test("asks the daemon while a turn runs with no prompt", () => {
    jest.useFakeTimers();
    turnRunning();
    mount();

    expect(restoreCalls.length).toBe(0);
    jest.advanceTimersByTime(PENDING_INTERACTION_POLL_MS + 10);
    expect(restoreCalls).toEqual([["asst-1", CONV]]);
  });

  test("keeps asking past 60s — the ceiling the reconciliation loop stops at", () => {
    // The reported stall lasted 30+ minutes; a repair that expires at one
    // minute never reaches it.
    jest.useFakeTimers();
    turnRunning();
    mount();

    jest.advanceTimersByTime(5 * 60_000);
    expect(restoreCalls.length).toBeGreaterThan(
      Math.floor(60_000 / PENDING_INTERACTION_POLL_MS),
    );
  });

  test("stops once the turn ends", () => {
    jest.useFakeTimers();
    turnRunning();
    mount();

    jest.advanceTimersByTime(PENDING_INTERACTION_POLL_MS + 10);
    const afterFirst = restoreCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    useTurnStore.setState({ activeTurnId: null });
    jest.advanceTimersByTime(PENDING_INTERACTION_POLL_MS * 3);
    expect(restoreCalls.length).toBe(afterFirst);
  });

  test("does not ask an inactive assistant", () => {
    jest.useFakeTimers();
    turnRunning();
    renderHook(() =>
      usePendingInteractionWatchdog({
        assistantId: "asst-1",
        activeConversationId: CONV,
        assistantStateKind: "starting",
      }),
    );
    jest.advanceTimersByTime(PENDING_INTERACTION_POLL_MS * 3);
    expect(restoreCalls.length).toBe(0);
  });

  test("clears its timer on unmount", () => {
    jest.useFakeTimers();
    turnRunning();
    const { unmount } = mount();
    unmount();
    jest.advanceTimersByTime(PENDING_INTERACTION_POLL_MS * 3);
    expect(restoreCalls.length).toBe(0);
  });
});
