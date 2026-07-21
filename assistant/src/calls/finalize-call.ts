import { getLogger } from "../util/logger.js";
import { kickCallActionItemCapture } from "./call-action-item-capture.js";
import { persistCallCompletionMessage } from "./call-conversation-messages.js";
import { fireCallCompletionNotifier } from "./call-state.js";
import { expirePendingQuestions } from "./call-store.js";

const log = getLogger("finalize-call");

export function finalizeCall(
  callSessionId: string,
  conversationId: string,
): void {
  expirePendingQuestions(callSessionId);
  persistCallCompletionMessage(conversationId, callSessionId).catch((err) => {
    log.error(
      { err, conversationId, callSessionId },
      "Failed to persist call completion message",
    );
  });
  fireCallCompletionNotifier(conversationId, callSessionId);
  // Turn the finished transcript into work items (best-effort, idempotent per
  // session — the Twilio terminal status callback may also reach here).
  kickCallActionItemCapture(callSessionId, conversationId);
}
