import { Fragment, memo, type ReactNode } from "react";

import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import { useTurnStore } from "@/domains/chat/turn-store";
import type { ConfirmationDecision } from "@/types/event-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/**
 * Renders the newest user message (the "anchor") plus any response items
 * that have streamed in since it was sent.
 *
 * The viewport-min-height wrapper that pins the anchor to the top of the
 * viewport — and the assistant avatar that pins to the bottom of the
 * viewport — both live in `Transcript`. This component is just the
 * anchor + response cluster; it has no awareness of where it sits inside
 * the latest-edge region.
 */
export interface LatestTurnRowProps {
  anchorMessage: MessageItem;
  responseItems: TranscriptItem[];
  assistantDisplayName?: string | null;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onSummarizeUpToHere?: (messageId: string) => void;
  onInspectMessage?: (messageId: string) => void;
  renderOnboardingChoice?: () => ReactNode;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: import("@/types/interaction-ui-types").AllowlistOption[];
    scopeOptions: import("@/types/interaction-ui-types").ScopeOption[];
    directoryScopeOptions: import("@/types/interaction-ui-types").DirectoryScopeOption[];
  }) => void;
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  assistantId?: string | null;
  /** Click handler when the user clicks the "open timeline" button on an
   *  inline subagent progress card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** Retry handler for an interrupted assistant row (turn killed by a
   *  daemon restart). Forwarded to each `TranscriptRow`. */
  onRetryInterrupted?: (assistantMessageId: string) => void;
  /** Hover-action retry for the latest completed assistant message:
   *  re-sends the turn's user message as a fresh turn. Attached only to the
   *  final assistant response row, and withheld entirely while the turn is
   *  still streaming or the row is already flagged `interrupted` (that path
   *  has its own retry notice). */
  onRetryLatestTurn?: () => void;
}

export const LatestTurnRow = memo(function LatestTurnRow({
  anchorMessage,
  responseItems,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
  onSummarizeUpToHere,
  onInspectMessage,
  renderOnboardingChoice,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  onOpenApp,
  onOpenDocument,
  assistantId,
  onSubagentClick,
  onStopSubagent,
  onRetryInterrupted,
  onRetryLatestTurn,
}: LatestTurnRowProps) {
  // The response cluster is "streaming" whenever the turn is in flight. This
  // keeps each response message's last tool-call group expanded for the whole
  // turn, rather than only during the instants a tool reports `running`.
  const phase = useTurnStore.use.phase();
  const isStreaming =
    phase === "queued" || phase === "thinking" || phase === "streaming";

  // The one response row that carries the hover Retry action: the last
  // assistant message in the cluster, once the turn has settled. Interrupted
  // rows keep their dedicated inline retry notice instead.
  const retryRowKey =
    !isStreaming && onRetryLatestTurn
      ? responseItems.findLast(
          (item) =>
            item.kind === "message" &&
            item.message.role !== "user" &&
            !item.message.interrupted,
        )?.key
      : undefined;

  return (
    <div className="flex flex-col" data-latest-turn="true">
      <TranscriptRow
        item={anchorMessage}
        assistantDisplayName={assistantDisplayName}
        onSurfaceAction={onSurfaceAction}
        onForkConversation={onForkConversation}
        onSummarizeUpToHere={onSummarizeUpToHere}
        onInspectMessage={onInspectMessage}
        renderOnboardingChoice={renderOnboardingChoice}
        onOpenRuleEditor={onOpenRuleEditor}
        unknownNudgeToolCallIds={unknownNudgeToolCallIds}
        onDismissUnknownNudge={onDismissUnknownNudge}
        onConfirmationSubmit={onConfirmationSubmit}
        onAllowAndCreateRule={onAllowAndCreateRule}
        onOpenApp={onOpenApp}
        onOpenDocument={onOpenDocument}
        assistantId={assistantId}
        onSubagentClick={onSubagentClick}
        onStopSubagent={onStopSubagent}
        onRetryInterrupted={onRetryInterrupted}
      />
      {responseItems.map((response) => (
        <Fragment key={response.key}>
          <TranscriptRow
            item={response}
            assistantDisplayName={assistantDisplayName}
            onSurfaceAction={onSurfaceAction}
            onForkConversation={onForkConversation}
            onSummarizeUpToHere={onSummarizeUpToHere}
            onInspectMessage={onInspectMessage}
            renderOnboardingChoice={renderOnboardingChoice}
            onOpenRuleEditor={onOpenRuleEditor}
            unknownNudgeToolCallIds={unknownNudgeToolCallIds}
            onDismissUnknownNudge={onDismissUnknownNudge}
            onConfirmationSubmit={onConfirmationSubmit}
            onAllowAndCreateRule={onAllowAndCreateRule}
            onOpenApp={onOpenApp}
            onOpenDocument={onOpenDocument}
            assistantId={assistantId}
            onSubagentClick={onSubagentClick}
            onStopSubagent={onStopSubagent}
            onRetryInterrupted={onRetryInterrupted}
            onRetryTurn={
              response.key === retryRowKey ? onRetryLatestTurn : undefined
            }
            isStreaming={isStreaming}
          />
        </Fragment>
      ))}
    </div>
  );
});
