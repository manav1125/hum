import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import { ThreadPinToggle } from "@/domains/chat/components/thread-pin-toggle";
import type { Conversation } from "@/types/conversation-types";

// Every glyph in this slot is `aria-hidden`, they all share one 14px box, and
// hovering replaces whichever one is showing with the pin — so the symbol is
// unreadable by inspection. These tests pin the labels that say what each
// state means.

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: "conv-1",
    title: "Thread",
    ...overrides,
  } as Conversation;
}

describe("ThreadPinToggle status labels", () => {
  test("names the needs-attention state", () => {
    render(
      <ThreadPinToggle
        conversation={conversation()}
        needsAttention
        onPinToggle={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /needs you — waiting on your approval/i,
      }),
    ).toBeTruthy();
  });

  test("names the working state", () => {
    render(
      <ThreadPinToggle
        conversation={conversation()}
        isProcessing
        onPinToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /working on it/i })).toBeTruthy();
  });

  test("names the unread state", () => {
    render(
      <ThreadPinToggle
        conversation={conversation({
          hasUnseenLatestAssistantMessage: true,
        })}
        onPinToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /new reply/i })).toBeTruthy();
  });

  test("needs-attention outranks working and unread", () => {
    render(
      <ThreadPinToggle
        conversation={conversation({
          hasUnseenLatestAssistantMessage: true,
        })}
        needsAttention
        isProcessing
        onPinToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /needs you/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /working on it/i })).toBeNull();
  });

  test("keeps the pin action reachable alongside the status", () => {
    render(
      <ThreadPinToggle
        conversation={conversation()}
        needsAttention
        onPinToggle={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /pin conversation/i }),
    ).toBeTruthy();
  });

  test("a plain row with no status stays silent for assistive tech", () => {
    const { container } = render(
      <ThreadPinToggle conversation={conversation()} />,
    );
    const slot = container.firstElementChild;
    expect(slot?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.getAttribute("title")).toBeNull();
  });

  test("a non-interactive row still announces its status", () => {
    render(<ThreadPinToggle conversation={conversation()} needsAttention />);
    expect(
      screen.getByRole("img", {
        name: /needs you — waiting on your approval/i,
      }),
    ).toBeTruthy();
  });
});
