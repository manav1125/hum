/**
 * Inline notice rendered under an assistant message whose turn died before
 * finishing (a daemon restart/crash mid-generation — see
 * `DisplayMessage.interrupted`). Replaces the old failure mode where the
 * transcript showed a silent empty bubble forever.
 *
 * The Retry button re-sends the original user message through the normal
 * send pipeline; the owner (`chat-route-content`) resolves that text from
 * the transcript, so this component only reports the assistant row's id.
 */

import { RotateCcw } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

export interface InterruptedTurnNoticeProps {
  /** Id of the interrupted assistant row, forwarded to `onRetry`. */
  messageId: string;
  /** True when the row holds partially-streamed content — the copy then
   *  clarifies that what's shown above is incomplete. */
  hasPartialContent: boolean;
  /** Re-send the original user message. Omitted ⇒ notice only, no button
   *  (e.g. render contexts without a send pipeline). */
  onRetry?: (assistantMessageId: string) => void;
}

export function InterruptedTurnNotice({
  messageId,
  hasPartialContent,
  onRetry,
}: InterruptedTurnNoticeProps) {
  return (
    <div
      data-testid="interrupted-turn-notice"
      className="flex w-fit max-w-full items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-lift)] px-3 py-2"
    >
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        {hasPartialContent
          ? "This response was interrupted before it finished."
          : "This response was interrupted."}
      </Typography>
      {onRetry && (
        <Button
          variant="outlined"
          size="compact"
          onClick={() => onRetry(messageId)}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
