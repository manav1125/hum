/**
 * W4 — CallTranscriptPanel presentational render + the pure helpers. The panel
 * takes a CallView fixture (no daemon, no router), so this verifies the
 * transcript surface renders caller/Cue turns, typed extracted items, and the
 * Call-back / File-all affordances.
 */
import type { ReactNode } from "react";
import { createElement } from "react";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

import {
  CallTranscriptPanel,
  type CallView,
  cleanSpokenLine,
  formatDuration,
} from "./call-transcript";

const FIXTURE: CallView = {
  callSessionId: "CS-1",
  conversationId: "conv-1",
  direction: "inbound",
  counterparty: "+1 (555) 555-0142",
  status: "completed",
  startedAt: Date.parse("2026-07-21T15:00:00"),
  endedAt: Date.parse("2026-07-21T15:03:20"),
  transcript: [
    {
      speaker: "cue",
      text: "Hey there, this is Ava — Sam's assistant. How can I help?",
    },
    {
      speaker: "caller",
      text: "Can you have Sam send the signed contract by Friday?",
    },
    { speaker: "cue", text: "Absolutely, I'll pass that along." },
  ],
  items: [
    {
      id: "wi-1",
      type: "action",
      title: "Send the signed contract to the caller",
      status: "queued",
      assignee: "Inbox",
    },
    { id: "wi-2", type: "decision", title: "Agreed to a Friday deadline" },
  ],
};

function renderPanel(
  overrides: Partial<Parameters<typeof CallTranscriptPanel>[0]> = {},
) {
  return render(
    createElement(CallTranscriptPanel, {
      view: FIXTURE,
      ...overrides,
    }) as ReactNode,
  );
}

afterEach(cleanup);

describe("pure helpers", () => {
  test("cleanSpokenLine strips control markers", () => {
    expect(cleanSpokenLine("Sure thing. [ASK_GUARDIAN: ok?] [END_CALL]")).toBe(
      "Sure thing.",
    );
  });

  test("formatDuration renders m/s", () => {
    const start = Date.parse("2026-07-21T15:00:00");
    expect(formatDuration(start, start + 200_000)).toBe("3m 20s");
    expect(formatDuration(start, start + 12_000)).toBe("12s");
    expect(formatDuration(null, null)).toBe("—");
  });
});

describe("CallTranscriptPanel", () => {
  test("renders caller, direction, duration and the transcript", () => {
    renderPanel();
    expect(screen.getByTestId("call-transcript")).toBeTruthy();
    expect(screen.getByText("+1 (555) 555-0142")).toBeTruthy();
    expect(screen.getByText(/Inbound call/)).toBeTruthy();
    expect(screen.getByText("3m 20s")).toBeTruthy();
    expect(
      screen.getByText(/Can you have Sam send the signed contract by Friday/),
    ).toBeTruthy();
  });

  test("renders typed extracted items with the action's status", () => {
    renderPanel();
    expect(
      screen.getByText("Send the signed contract to the caller"),
    ).toBeTruthy();
    expect(screen.getByText("Agreed to a Friday deadline")).toBeTruthy();
    // The action carries its queue status/assignee.
    expect(screen.getByText(/queued · Inbox/)).toBeTruthy();
  });

  test("Call back and File all fire their handlers", () => {
    let calledBack = 0;
    let filed = 0;
    renderPanel({
      onCallBack: () => {
        calledBack += 1;
      },
      onFileAll: () => {
        filed += 1;
      },
    });
    fireEvent.click(screen.getByText("Call back"));
    fireEvent.click(screen.getByText(/^File all/));
    expect(calledBack).toBe(1);
    expect(filed).toBe(1);
  });

  test("empty call shows the honest no-follow-ups copy", () => {
    renderPanel({ view: { ...FIXTURE, items: [], transcript: [] } });
    expect(screen.getByText(/left no follow-ups/)).toBeTruthy();
    expect(screen.getByText(/No transcript was captured/)).toBeTruthy();
  });
});
