/**
 * Tests for the `ChatBody` layout behavior.
 *
 * Verifies the conditional CSS class logic and slot rendering that
 * enables centered empty-state layout (LUM-1566): greeting + composer +
 * conversation-starter chips center as one visual group via
 * `justify-content: safe center`.
 *
 * Uses bun:test + react-dom/server (renderToStaticMarkup) matching the
 * existing project test convention. Complex child components are stubbed
 * via `mock.module` so the test focuses on the composition logic inside
 * `ChatBody` itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { ChatBodyProps } from "@/domains/chat/components/chat-body";

// Stub child components that require browser APIs or complex hooks.
// NOTE: Do NOT mock chat-scroll-area itself — that leaks across test
// files via bun's shared module registry and breaks chat-scroll-area's
// own tests. Instead, mock ChatScrollArea's deep dependencies.
mock.module("@/domains/chat/transcript/transcript", () => ({
  Transcript: () => <div data-testid="transcript">TRANSCRIPT</div>,
}));

mock.module("@/domains/chat/components/maintenance-recovery-card", () => ({
  MaintenanceRecoveryCard: () => <div>MAINTENANCE</div>,
}));

mock.module("@/domains/chat/components/chat-skeleton", () => ({
  ChatSkeleton: () => <div>SKELETON</div>,
}));

mock.module("@/domains/chat/components/scroll-to-latest-button", () => ({
  ScrollToLatestButton: ({ onClick }: { onClick: () => void }) => (
    <button data-testid="scroll-to-latest" onClick={onClick}>
      SCROLL_TO_LATEST
    </button>
  ),
}));

mock.module("@/domains/chat/components/chat-composer/chat-composer", () => ({
  ChatComposer: () => <div data-testid="composer">COMPOSER</div>,
}));

// Spread the real design library and override only the pieces this test
// drives. Listing exports exhaustively is what broke this file: the tree
// below `ChatBody` later began importing `MarkdownMessage` from here, the
// hand-written mock did not have it, and the import threw at load — the
// whole suite erroring before a single test ran.
const designLibrary = await import("@vellumai/design-library");

mock.module("@vellumai/design-library", () => ({
  ...designLibrary,
  Button: ({
    children,
    iconOnly,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{iconOnly ?? children}</button>
  ),
  Notice: ({ children }: { children: string }) => (
    <div data-testid="notice">{children}</div>
  ),
  ResizablePanel: () => <div data-testid="resizable-panel" />,
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

mock.module("@/domains/chat/refresh-feedback-pill", () => ({
  RefreshFeedbackPill: () => <div>REFRESH_PILL</div>,
}));

mock.module("@/domains/chat/components/question-prompt-slot", () => ({
  QuestionPromptSlot: () => <div data-testid="question-prompt-slot" />,
}));

// The desktop call-ladder projections. Stubbed to echo the conversation they
// were bound to, because that id — not their appearance — is what the voice
// binding cases below assert on. Spread from the real module so any other
// export it grows stays intact for later files in the run.
const voiceSlot =
  await import("@/domains/chat/voice/voice-call-conversation-slot");
mock.module("@/domains/chat/voice/voice-call-conversation-slot", () => ({
  ...voiceSlot,
  ConversationVoiceBar: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="voice-bar" data-cid={conversationId} />
  ),
  ConversationVoiceRoomOverlay: ({
    conversationId,
  }: {
    conversationId?: string;
  }) => <div data-testid="voice-room" data-cid={conversationId} />,
}));

// Import after mocks are registered.
const { ChatBody } = await import("@/domains/chat/components/chat-body");

const { auditHomeCanvas, canvasElement, canvasRegion } =
  await import("@/domains/chat/home-canvas/home-canvas-model");

const noop = () => {};
const noopDrag = () => {};

function baseProps(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return {
    variant: "main",
    scrollAreaProps: {
      isLoadingHistory: false,
      messageCount: 0,
      showMaintenanceRecoveryCard: false,
      showEmptyState: false,
      emptyStateProps: {},
      transcriptRef: null,
      transcriptProps: { messages: [], onScrollToMessage: noop } as never,
    },
    composerProps: {} as never,
    dragHandlers: {
      onDragEnter: noopDrag,
      onDragOver: noopDrag,
      onDragLeave: noopDrag,
      onDrop: noopDrag,
    },
    isAttachmentDragOver: false,
    showScrollToLatest: false,
    onScrollToLatest: noop,
    refreshFeedback: null,
    onDismissRefreshFeedback: noop,
    onRetryRefresh: noop,
    genericChatError: null,
    isChannelReadonly: false,
    ...overrides,
  };
}

function withEmptyState(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return baseProps({
    scrollAreaProps: {
      ...baseProps().scrollAreaProps,
      showEmptyState: true,
    },
    ...overrides,
  });
}

/**
 * `ChatBody` mounts `SpawnedWorkSlot`, which reads react-query and renders
 * react-router `Link`s. Neither is what this file asserts on, but both throw
 * without their context, so every case renders through the same providers.
 * Providers contribute no markup of their own, so the `toContain` and
 * `indexOf` assertions below still see exactly `ChatBody`'s output.
 */
function renderBody(props: ChatBodyProps): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChatBody {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatBody — empty-state centering (LUM-1566)", () => {
  test("applies safe_center and overflow-y-auto when empty state is visible", () => {
    const html = renderBody(withEmptyState());
    expect(html).toContain("[justify-content:safe_center]");
    expect(html).toContain("overflow-y-auto");
  });

  test("does NOT apply safe_center or overflow-y-auto when empty state is hidden", () => {
    const html = renderBody(baseProps());
    expect(html).not.toContain("[justify-content:safe_center]");
    expect(html).not.toContain("overflow-y-auto");
  });

  test("uses flex-1 in outer class for main variant", () => {
    const html = renderBody(baseProps({ variant: "main" }));
    // The outer container class for the main variant.
    expect(html).toContain("relative flex min-h-0 flex-1 flex-col");
  });

  test("uses h-full in outer class for side-panel variant", () => {
    const html = renderBody(baseProps({ variant: "side-panel" }));
    // The outer container class for the side-panel variant.
    expect(html).toContain("relative flex h-full min-h-0 flex-col");
  });
});

describe("ChatBody — banner overlay suppression (LUM-1566)", () => {
  test("suppresses banner overlay on empty state to prevent greeting overlap", () => {
    const html = renderBody(
      withEmptyState({
        bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
      }),
    );
    // The banner node is passed but the overlay container should not
    // render it on the empty state — it would overlap the greeting.
    expect(html).not.toContain("BANNER_CONTENT");
  });

  test("renders banner overlay when empty state is hidden and bannerSlot is provided", () => {
    const html = renderBody(
      baseProps({
        bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
      }),
    );
    expect(html).toContain("BANNER_CONTENT");
  });
});

describe("ChatBody — startersSlot rendering", () => {
  test("renders startersSlot content when provided", () => {
    const html = renderBody(
      withEmptyState({
        startersSlot: <div data-testid="starters">STARTER_CHIPS</div>,
      }),
    );
    expect(html).toContain("STARTER_CHIPS");
  });

  test("omits starters when startersSlot is undefined", () => {
    const html = renderBody(withEmptyState());
    expect(html).not.toContain("STARTER_CHIPS");
  });
});

describe("ChatBody — read-only cancellation", () => {
  test("renders the read-only banner without a stop control while idle", () => {
    const html = renderBody(
      baseProps({
        isChannelReadonly: true,
        composerProps: { onStopGenerating: noop } as never,
      }),
    );

    expect(html).toContain("Read-only conversation");
    expect(html).not.toContain('aria-label="Stop generating"');
    expect(html).not.toContain("COMPOSER");
  });

  test("renders the stop control for an active read-only turn", () => {
    const html = renderBody(
      baseProps({
        isChannelReadonly: true,
        canStopGenerating: true,
        composerProps: { onStopGenerating: noop } as never,
      }),
    );

    expect(html).toContain("Read-only conversation");
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).toContain('title="Stop generation"');
    expect(html).not.toContain("COMPOSER");
  });
});

describe("ChatBody — channel footer slot", () => {
  test("renders channelFooterSlot immediately above the composer", () => {
    const html = renderBody(
      baseProps({
        channelFooterSlot: (
          <div data-testid="channel-footer">CHANNEL_FOOTER</div>
        ),
      }),
    );

    expect(html).toContain("CHANNEL_FOOTER");
    expect(html.indexOf("CHANNEL_FOOTER")).toBeLessThan(
      html.indexOf("COMPOSER"),
    );
  });
});

// ---------------------------------------------------------------------------
// The home canvas — positions 1 and 2
// ---------------------------------------------------------------------------

/**
 * `ChatBody` owns two of the six elements design ruled onto the home canvas
 * (`docs/design/handoff-2026-08-02/FINAL-NAV-BRIEF.md` §4): the greeting, and
 * the composer — which §8 lists as an invariant because it has been
 * accidentally dropped twice.
 *
 * They cannot be rendered from the manifest the way positions 3–4 are: the
 * composer has to hold a fixed position in the React tree or it loses its
 * focus, draft and attachments on first send. So they are *marked* where they
 * live, and this is the assertion that the marks are there and are singular.
 */
describe("ChatBody — the home canvas (FINAL-NAV-BRIEF §4)", () => {
  function auditMarkup(html: string) {
    const host = document.createElement("div");
    host.innerHTML = html;
    return { host, audit: auditHomeCanvas(host) };
  }

  test("the empty state carries the mark and the composer, once each", () => {
    const { audit } = auditMarkup(
      renderBody(
        withEmptyState({
          // Stand-ins for positions 3–4, composed through the same marker
          // helper the real region uses. `home-canvas.test.tsx` drives the
          // real ones.
          startersSlot: (
            <div {...canvasRegion()}>
              <div {...canvasElement("prompts")} />
              <div {...canvasElement("door")} />
            </div>
          ),
        }),
      ),
    );

    expect(audit.ok).toBe(true);
    expect([...audit.found].sort()).toEqual([
      "composer",
      "door",
      "mark",
      "prompts",
    ]);
    expect(audit.duplicated).toEqual([]);
  });

  test("the composer survives the empty→active transition", () => {
    // §8's invariant. Both renders must carry position 2 — the composer is not
    // an empty-state decoration, it is furniture.
    expect(auditMarkup(renderBody(withEmptyState())).audit.found).toContain(
      "composer",
    );
    expect(auditMarkup(renderBody(baseProps())).audit.found).toContain(
      "composer",
    );
  });

  test("the greeting is an empty-state element only", () => {
    expect(auditMarkup(renderBody(baseProps())).audit.found).not.toContain(
      "mark",
    );
  });

  test("a read-only channel replaces the composer, and says so", () => {
    // The one case where position 2 is legitimately absent: there is nothing
    // to type into. It must not be silently missing — the banner takes its
    // place, so the canvas is short an element for a stated reason.
    const html = renderBody(baseProps({ isChannelReadonly: true }));
    expect(auditMarkup(html).audit.found).not.toContain("composer");
    expect(html).toContain("Read-only conversation");
  });
});

/**
 * Which conversation a call started from the composer mic belongs to.
 *
 * `composerProps.conversationId` is a lookup into the server's conversation
 * list, so it is `undefined` on a thread whose first message has not been sent
 * — which is the state the app opens in. On 2026-08-17 that sent the mic down
 * the unbound path: the daemon fell back to the session id and minted an orphan
 * conversation per call. Two calls thirty seconds apart produced two separate
 * threads, neither of them the one on screen, and the conversation history the
 * voice model is seeded with read a thread that had never held a message.
 */
describe("ChatBody — which conversation the mic binds a call to", () => {
  test("an unsent thread still binds the call, using its draft id", () => {
    const html = renderBody(
      baseProps({
        composerProps: {
          assistantId: "a1",
          // Absent, exactly as it is before the first message is sent.
          conversationId: undefined,
        } as never,
        voiceConversationId: "draft-42",
      }),
    );

    // The ladder engaged (it is gated on having a conversation at all)...
    expect(html).toContain('data-testid="voice-room"');
    // ...and it is bound to the thread the user is looking at.
    expect(html).toContain('data-cid="draft-42"');
  });

  test("the server-side id still wins when the parent supplies no draft-aware one", () => {
    const html = renderBody(
      baseProps({
        composerProps: { assistantId: "a1", conversationId: "conv-9" } as never,
      }),
    );

    expect(html).toContain('data-cid="conv-9"');
  });

  test("with no thread on either prop there is nothing to bind and no ladder", () => {
    const html = renderBody(
      baseProps({ composerProps: { assistantId: "a1" } as never }),
    );

    expect(html).not.toContain('data-testid="voice-room"');
  });
});
