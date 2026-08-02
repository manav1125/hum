/**
 * Long work leaves the chat.
 *
 * Anything over ~30s becomes a task with a live line, never a spinner, and the
 * conversation must never block. Both halves of that already exist in this
 * codebase — `useBackgroundRun` stamps `originConversationId` on the work item
 * and `SpawnedWorkSlot` reads it back as a live row; `deriveLiveStatus` keeps a
 * long foreground turn textual. These tests pin the behaviour so a later change
 * cannot quietly put a spinner back or let a long turn swallow the composer.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { deriveLiveStatus } from "@/domains/chat/transcript/live-turn-status";
import type { SpawnedWorkItem } from "@/domains/chat/hooks/use-spawned-work";

/** ~30s: the point past which work is expected to have left the chat. */
const LONG_WORK_MS = 30_000;

// Spread the real module and override only the query seam — an exhaustive
// hand-written factory here is exactly the pattern that has silently killed
// whole test files in this repo.
const spawnedWorkModule = await import("@/domains/chat/hooks/use-spawned-work");
let spawnedItems: SpawnedWorkItem[] = [];
mock.module("@/domains/chat/hooks/use-spawned-work", () => ({
  ...spawnedWorkModule,
  useSpawnedWork: () => ({
    items: spawnedItems,
    isLoading: false,
    isError: false,
  }),
}));

const { SpawnedWorkSlot } =
  await import("@/domains/chat/components/spawned-work-slot");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

afterEach(() => {
  cleanup();
  spawnedItems = [];
});

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    phase: "streaming" as const,
    statusText: null,
    pendingQueuedCount: 0,
    thinkingTail: "",
    thinkingAt: null,
    runningTools: [],
    turnStartedAt: 0,
    now: LONG_WORK_MS + 15_000,
    fallbackActive: false,
    ...overrides,
  };
}

describe("a long foreground turn", () => {
  test("stays a live line, never a bare spinner", () => {
    const view = deriveLiveStatus(baseStatus({ phase: "thinking" }));
    expect(view).not.toBeNull();
    // Something readable, with the elapsed time on it.
    expect(view!.text.trim().length).toBeGreaterThan(0);
    expect(view!.detail).toBe("45s");
  });

  test("says it is waiting on YOU the moment the ball changes court", () => {
    const view = deriveLiveStatus(baseStatus({ phase: "awaiting_user_input" }));
    expect(view!.state).toBe("waiting");
    expect(view!.label).toBe("Waiting on you");
  });

  test("never claims progress it cannot observe", () => {
    const view = deriveLiveStatus(
      baseStatus({ phase: "thinking", sseConnected: false }),
    );
    expect(view!.state).toBe("blocked");
    expect(view!.label).toBe("Reconnecting");
  });
});

describe("work that left the chat", () => {
  test("returns a live line in the thread, not a spinner", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    useConversationStore.setState({ activeConversationId: "c1" });
    spawnedItems = [
      {
        id: "wi-1",
        title: "Pull the Northwind renewal numbers",
        status: "running",
        lastRunConversationId: null,
        lastProgressNote: "Reading the pricing model",
        projectId: null,
        createdAt: 1,
      },
    ];

    const { getByTestId, getByText } = render(
      <MemoryRouter>
        <SpawnedWorkSlot />
      </MemoryRouter>,
    );

    const slot = getByTestId("spawned-work-slot");
    expect(slot.textContent).toContain("Pull the Northwind renewal numbers");
    // A word, a state and somewhere to go — not an indeterminate spinner.
    expect(getByText("Running")).toBeTruthy();
    expect(getByText("Watch it run")).toBeTruthy();
  });

  test("offers no result for work that has not produced one", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    useConversationStore.setState({ activeConversationId: "c1" });
    spawnedItems = [
      {
        id: "wi-2",
        title: "Chase Rachel on the questionnaire",
        status: "queued",
        lastRunConversationId: null,
        lastProgressNote: null,
        projectId: null,
        createdAt: 1,
      },
    ];

    const { getByTestId, queryByText } = render(
      <MemoryRouter>
        <SpawnedWorkSlot />
      </MemoryRouter>,
    );
    expect(getByTestId("spawned-work-slot").textContent).toContain("Queued");
    expect(queryByText("See the result")).toBeNull();
  });

  test("a thread that started nothing shows nothing", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    useConversationStore.setState({ activeConversationId: "c1" });
    const { container } = render(
      <MemoryRouter>
        <SpawnedWorkSlot />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe("");
  });
});
