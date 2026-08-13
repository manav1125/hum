/**
 * The temporary-approval countdown chip: local ticking against the echoed
 * expiry, conversation scoping, and tap-to-revoke via
 * POST /v1/approval-override/clear.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const clearCalls: { assistantId: string; conversationId: string }[] = [];
const interactionsActual = await import("@/domains/chat/api/interactions");
mock.module("@/domains/chat/api/interactions", () => ({
  ...interactionsActual,
  clearApprovalOverride: mock(
    async (assistantId: string, conversationId: string) => {
      clearCalls.push({ assistantId, conversationId });
      return { ok: true };
    },
  ),
}));

const { ApprovalOverrideChip } = await import("./approval-override-chip");
const { useApprovalOverrideStore } =
  await import("@/domains/chat/approval-override-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useStreamStore } = await import("@/domains/chat/stream-store");

afterEach(() => {
  cleanup();
  clearCalls.length = 0;
  useApprovalOverrideStore.getState().clearActiveOverride();
});

function grantTimed(expiresInMs = 10 * 60 * 1000) {
  useApprovalOverrideStore.getState().setActiveOverride({
    conversationId: "conv-1",
    conversationKey: "key-1",
    kind: "timed",
    expiresAt: Date.now() + expiresInMs,
  });
}

function setActiveConversation(key: string | null) {
  useConversationStore.setState({ activeConversationId: key } as never);
}

function setStreamContext() {
  useStreamStore.setState({
    streamContext: { assistantId: "asst-1" },
  } as never);
}

describe("ApprovalOverrideChip", () => {
  test("renders nothing without an active override", () => {
    setActiveConversation("key-1");
    render(<ApprovalOverrideChip />);
    expect(
      document.querySelector('[data-slot="approval-override-chip"]'),
    ).toBeNull();
  });

  test("shows a live countdown for a timed grant", () => {
    setActiveConversation("key-1");
    grantTimed();
    render(<ApprovalOverrideChip />);
    const chip = document.querySelector('[data-slot="approval-override-chip"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toMatch(/auto-approving · (9:5\d|10:00) left/);
  });

  test("labels a conversation grant with its scope, not a timer", () => {
    setActiveConversation("key-1");
    useApprovalOverrideStore.getState().setActiveOverride({
      conversationId: "conv-1",
      conversationKey: "key-1",
      kind: "conversation",
      expiresAt: null,
    });
    render(<ApprovalOverrideChip />);
    const chip = document.querySelector('[data-slot="approval-override-chip"]');
    expect(chip!.textContent).toContain("this conversation");
    expect(chip!.textContent).not.toContain("left");
  });

  test("is scoped to the conversation that granted it", () => {
    setActiveConversation("some-other-conversation");
    grantTimed();
    render(<ApprovalOverrideChip />);
    expect(
      document.querySelector('[data-slot="approval-override-chip"]'),
    ).toBeNull();
  });

  test("an already-lapsed grant renders nothing — expiry returns to ask", () => {
    setActiveConversation("key-1");
    grantTimed(-1000);
    render(<ApprovalOverrideChip />);
    expect(
      document.querySelector('[data-slot="approval-override-chip"]'),
    ).toBeNull();
  });

  test("tap revokes: clears locally and calls the clear endpoint", async () => {
    setActiveConversation("key-1");
    setStreamContext();
    grantTimed();
    render(<ApprovalOverrideChip />);
    const chip = document.querySelector(
      '[data-slot="approval-override-chip"]',
    ) as HTMLButtonElement;
    fireEvent.click(chip);

    expect(useApprovalOverrideStore.getState().activeOverride).toBeNull();
    await waitFor(() =>
      expect(clearCalls).toEqual([
        { assistantId: "asst-1", conversationId: "conv-1" },
      ]),
    );
  });
});
