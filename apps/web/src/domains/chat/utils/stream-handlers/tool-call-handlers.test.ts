import { describe, expect, it } from "bun:test";

import { useLiveStatusStore } from "@/domains/chat/live-status-store";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleToolResult,
  handleToolUseStart,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";

describe("handleToolUseStart", () => {
  it("cancels reconciliation and creates tool call with generated id", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "test" },
      },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.onToolUseStart).toHaveBeenCalled();
    expect(ctx.toolCallIdCounterRef.current).toBe(1);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("uses provided toolUseId when available", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "custom-id",
      },
      ctx,
    );
    expect(ctx.toolCallIdCounterRef.current).toBe(0);
  });

  it("creates a new bubble when there is no assistant tail to fold into", () => {
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalled();
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (
      prev: never[],
    ) => Array<{ role: string; toolCalls: Array<{ id: string }> }>;
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0]?.role).toBe("assistant");
    expect(next[0]?.toolCalls).toHaveLength(1);
    expect(next[0]?.toolCalls[0]?.id).toBe("tc-1");
  });

  it("forwards event.messageId to the new bubble (adopts as row id, no isOptimistic)", () => {
    // Anchor protocol: tool_use_start carries messageId from event zero —
    // the daemon has committed to the assistant message existing. The new
    // bubble adopts that id rather than being stamped optimistic.
    const ctx = makeCtx();
    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-1",
        messageId: "server-msg-1",
      },
      ctx,
    );
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (
      prev: never[],
    ) => Array<{ id: string; isOptimistic?: boolean }>;
    const next = updater([]);
    expect(next[0]?.id).toBe("server-msg-1");
    expect(next[0]?.isOptimistic).toBeUndefined();
  });

  // NOTE: these live-status tests use conversation ids no other test file's
  // mounted components use as their active conversation — component trees
  // leaked by earlier suite files react to live-status store writes and
  // re-stamp a slice for THEIR active id ("conv-1"), which would otherwise
  // race these assertions in a full-suite run.
  it("routes live tool activity to the EVENT's conversation, not the stream anchor", () => {
    // Regression: a background conversation's tool starts fed the global
    // live-status line shown in whichever transcript was open. The run
    // must land under the event's own conversation id.
    useLiveStatusStore.getState().resetAll();
    const ctx = makeCtx({
      // The viewed conversation (stream anchor).
      streamContext: { assistantId: "ast-1", conversationId: "conv-live-a" },
    });

    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-b",
        conversationId: "conv-live-b",
      },
      ctx,
    );

    const { byConversation } = useLiveStatusStore.getState();
    expect(byConversation["conv-live-a"]).toBeUndefined();
    expect(byConversation["conv-live-b"]?.runningTools).toHaveLength(1);
    expect(byConversation["conv-live-b"]?.runningTools[0]?.toolUseId).toBe(
      "tc-b",
    );
  });

  it("falls back to the stream anchor when the event carries no conversation id", () => {
    useLiveStatusStore.getState().resetAll();
    const ctx = makeCtx({
      streamContext: { assistantId: "ast-1", conversationId: "conv-live-a" },
    });

    handleToolUseStart(
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "tc-1",
      },
      ctx,
    );

    expect(
      useLiveStatusStore.getState().byConversation["conv-live-a"]?.runningTools,
    ).toHaveLength(1);
  });

  it("folds three sequential tool_use_starts with the same messageId into one bubble", () => {
    // Concrete reproduction of the bug behind the screenshot: three
    // tool_use_starts arriving back-to-back with the same anchor messageId
    // must produce ONE assistant row with three tool calls, not three
    // overlapping bubbles or a duplicate.
    const ctx = makeCtx();
    let current: Array<{
      id: string;
      toolCalls?: Array<{ id: string }>;
      isOptimistic?: boolean;
    }> = [];
    const setMessages = ctx.setMessages as unknown as {
      mock: { calls: unknown[][] };
    };

    for (const [i, toolUseId] of ["tc-1", "tc-2", "tc-3"].entries()) {
      handleToolUseStart(
        {
          type: "tool_use_start",
          toolName: "web_search",
          input: {},
          toolUseId,
          messageId: "anchor-1",
        },
        ctx,
      );
      const updater = setMessages.mock.calls[i]![0] as (
        prev: typeof current,
      ) => typeof current;
      current = updater(current);
    }

    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe("anchor-1");
    expect(current[0]!.isOptimistic).toBeUndefined();
    expect(current[0]!.toolCalls).toHaveLength(3);
    expect(current[0]!.toolCalls!.map((tc) => tc.id)).toEqual([
      "tc-1",
      "tc-2",
      "tc-3",
    ]);
  });
});

describe("handleToolResult", () => {
  it("only pops the tool run from the EVENT's conversation", () => {
    useLiveStatusStore.getState().resetAll();
    const live = useLiveStatusStore.getState();
    live.noteToolStart("conv-live-a", { toolUseId: "tc-1", toolName: "bash" });
    live.noteToolStart("conv-live-b", {
      toolUseId: "tc-1",
      toolName: "web_fetch",
    });

    const ctx = makeCtx({
      streamContext: { assistantId: "ast-1", conversationId: "conv-live-a" },
    });
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_fetch",
        result: "done",
        toolUseId: "tc-1",
        conversationId: "conv-live-b",
      },
      ctx,
    );

    const { byConversation } = useLiveStatusStore.getState();
    // The viewed conversation's identically-ided run survives.
    expect(byConversation["conv-live-a"]?.runningTools).toHaveLength(1);
    expect(byConversation["conv-live-b"]?.runningTools).toHaveLength(0);
  });

  it("dispatches TOOL_RESULT and updates messages", () => {
    const ctx = makeCtx();
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "Found 3 results",
        toolUseId: "tc-1",
      },
      ctx,
    );
    expect(ctx.turnActions.onToolResult).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("routes activityMetadata to onToolActivityMetadata action when present", () => {
    const ctx = makeCtx();
    const metadata = {
      webSearch: {
        query: "tigers",
        provider: "anthropic-native" as const,
        resultCount: 1,
        durationMs: 100,
        results: [
          {
            rank: 1,
            title: "Tigers - Wikipedia",
            url: "https://en.wikipedia.org/wiki/Tiger",
            domain: "en.wikipedia.org",
          },
        ],
      },
    };
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "...",
        toolUseId: "tc-1",
        activityMetadata: metadata,
      },
      ctx,
    );
    expect(ctx.turnActions.onToolActivityMetadata).toHaveBeenCalledWith(
      "tc-1",
      metadata,
    );
  });

  it("does NOT route activityMetadata when toolUseId is missing", () => {
    const ctx = makeCtx();
    handleToolResult(
      {
        type: "tool_result",
        toolName: "web_search",
        result: "...",
        activityMetadata: { webSearch: undefined },
      },
      ctx,
    );
    expect(ctx.turnActions.onToolActivityMetadata).not.toHaveBeenCalled();
  });
});
