/**
 * Static-markup tests for `LatestTurnRow`'s render structure.
 *
 * The repo doesn't run DOM-based tests (no `@testing-library/react`). We
 * exercise the component via `renderToStaticMarkup` and mock the LEAF
 * rendering deps (`ChatMarkdownMessage`, `MessageHoverActions`, `ToolCallChip`,
 * `surfaces`, `ChatAttachments`) so the real `TranscriptRow` runs and
 * produces queryable text content. We deliberately do NOT mock
 * `./TranscriptRow` — `mock.module()` is process-global in bun:test and
 * stubbing TranscriptRow at the module level here leaks into other test
 * files (e.g. `Transcript.test.tsx`) that still need the real component.
 *
 * The latest-edge region's avatar slot, flex-1 spacer, and
 * `data-latest-edge` sentinel all live in `Transcript` itself — see
 * `transcript.test.tsx` for their tests.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module(
  "@/domains/chat/components/message-hover-actions/message-hover-actions",
  () => ({
    // Marker for the retry-threading tests: rows whose hover actions were
    // handed an `onRetry` callback render `data-has-retry="true"`.
    MessageHoverActions: ({ onRetry }: { onRetry?: () => void }) => (
      <div
        data-testid="hover-actions"
        data-has-retry={onRetry ? "true" : undefined}
      />
    ),
  }),
);

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call-chip" />,
}));

mock.module("@/components/assistant/surfaces", () => ({
  SurfaceRouter: () => <div data-testid="surface-router" />,
}));

mock.module(
  "@/domains/chat/components/chat-attachments/message-attachments",
  () => ({
    MessageAttachments: () => <div data-testid="message-attachments" />,
  }),
);

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { LatestTurnRow } from "@/domains/chat/transcript/latest-turn-row";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
function userMessageItem(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessageItem(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

const noop = () => {};

const sharedProps = {
  onSurfaceAction: noop,
  onSecretSubmit: noop,
  onConfirmationDecision: noop,
};

describe("LatestTurnRow render order", () => {
  test("anchor first, then responseItems in order", () => {
    const anchor = userMessageItem("u1", "ANCHOR_CONTENT");
    const responseItems: TranscriptItem[] = [
      assistantMessageItem("a1", "FIRST_RESPONSE"),
      assistantMessageItem("a2", "SECOND_RESPONSE"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        {...sharedProps}
      />,
    );

    const anchorIdx = html.indexOf("ANCHOR_CONTENT");
    const firstIdx = html.indexOf("FIRST_RESPONSE");
    const secondIdx = html.indexOf("SECOND_RESPONSE");

    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);

    expect(anchorIdx).toBeLessThan(firstIdx);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("no avatar slot / latest-edge sentinel rendered (both live in Transcript)", () => {
    const anchor = userMessageItem("u1", "hello");
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={[]}
        {...sharedProps}
      />,
    );
    expect(html).not.toContain('data-latest-assistant-avatar="true"');
    expect(html).not.toContain('data-latest-edge="true"');
  });

  test("data-latest-turn marker stays on the root", () => {
    const anchor = userMessageItem("u1", "hello");
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={[]}
        {...sharedProps}
      />,
    );
    expect(html).toContain('data-latest-turn="true"');
  });
});

describe("LatestTurnRow retry threading", () => {
  // Under static markup zustand reads the turn store's INITIAL state
  // (phase "idle"), i.e. a settled turn — the case where retry attaches.

  test("only the LAST assistant response row carries the retry action", () => {
    const anchor = userMessageItem("u1", "question");
    const responseItems: TranscriptItem[] = [
      assistantMessageItem("a1", "FIRST_RESPONSE"),
      assistantMessageItem("a2", "SECOND_RESPONSE"),
    ];
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={responseItems}
        {...sharedProps}
        onRetryLatestTurn={() => {}}
      />,
    );
    const markers = html.match(/data-has-retry="true"/g) ?? [];
    expect(markers.length).toBe(1);
    // The marker sits after the second response's content in document order.
    expect(html.indexOf('data-has-retry="true"')).toBeGreaterThan(
      html.indexOf("SECOND_RESPONSE"),
    );
  });

  test("no retry marker when onRetryLatestTurn is absent", () => {
    const anchor = userMessageItem("u1", "question");
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={[assistantMessageItem("a1", "RESPONSE")]}
        {...sharedProps}
      />,
    );
    expect(html).not.toContain('data-has-retry="true"');
  });

  test("interrupted rows keep their own notice and get no hover retry", () => {
    const anchor = userMessageItem("u1", "question");
    const interrupted = assistantMessageItem("a1", "PARTIAL");
    interrupted.message.interrupted = true;
    const html = renderToStaticMarkup(
      <LatestTurnRow
        anchorMessage={anchor}
        responseItems={[interrupted]}
        {...sharedProps}
        onRetryLatestTurn={() => {}}
      />,
    );
    expect(html).not.toContain('data-has-retry="true"');
  });
});
