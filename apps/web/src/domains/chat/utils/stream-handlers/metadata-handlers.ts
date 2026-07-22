import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import { useLiveStatusStore } from "@/domains/chat/live-status-store";
import { saveContextWindowUsage } from "@/domains/chat/utils/context-window-storage";
import { resolveConversationId } from "@/domains/chat/utils/stream-handlers/message-handlers";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  CompactionCircuitClosedEvent,
  CompactionCircuitOpenEvent,
  TurnProfileAutoRoutedEvent,
  UsageProgressEvent,
  UsageUpdateEvent,
} from "@vellumai/assistant-api";

export function handleUsageUpdate(
  event: UsageUpdateEvent,
  ctx: StreamHandlerContext,
): void {
  const tokens = event.contextWindowTokens;
  const maxTokens = event.contextWindowMaxTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return;

  const resolvedMax =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? maxTokens
      : null;
  const fillRatio =
    resolvedMax != null ? Math.min(1, Math.max(0, tokens / resolvedMax)) : null;
  const usage: ContextWindowUsage = {
    tokens,
    maxTokens: resolvedMax,
    fillRatio,
  };
  const streamCtx = ctx.streamContext;
  if (streamCtx) {
    ctx.setContextWindowUsageForConversation(streamCtx.conversationId, usage);
    saveContextWindowUsage(
      streamCtx.assistantId,
      streamCtx.conversationId,
      usage,
    );
  }
  ctx.setContextWindowUsage(usage);
}

/**
 * Per-call token deltas (`usage_progress`). The top-level chat surface reads
 * running context-window totals from `usage_update`; this handler additionally
 * feeds the live status line's quiet per-turn token burn-down counter, scoped
 * to the EVENT's conversation so a background turn's tokens never surface in
 * the transcript being viewed. Unattributable events are dropped.
 */
export function handleUsageProgress(
  event: UsageProgressEvent,
  ctx: StreamHandlerContext,
): void {
  const liveConvId = resolveConversationId(event, ctx);
  if (!liveConvId) return;
  useLiveStatusStore.getState().noteUsageProgress(liveConvId, {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
  });
}

export function handleCompactionCircuitOpen(
  event: CompactionCircuitOpenEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setCompactionCircuitOpenUntil(new Date(event.openUntil));
}

export function handleCompactionCircuitClosed(
  _event: CompactionCircuitClosedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setCompactionCircuitOpenUntil(null);
}

export function handleTurnProfileAutoRouted(
  event: TurnProfileAutoRoutedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onProfileAutoRouted(event.profileLabel);
}
