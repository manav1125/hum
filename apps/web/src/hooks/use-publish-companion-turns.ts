/**
 * Publish the conversation's tail to the companion card.
 *
 * **Only this window owns a conversation, and only main may publish to the
 * companion.** So the app's window sends the tail here, main relays it, and
 * the card draws it — which is upstream's arrangement, and the reason the card
 * can hold a second exchange at all.
 *
 * The card shipped without this. The retired corner's rule — one exchange,
 * then done — was applied to the companion, a different surface with a
 * different job, so every question went into a brand-new conversation in the
 * app and the answer arrived somewhere the owner was not looking.
 *
 * Lives in `hooks/` rather than inside `domains/companion` because it is read
 * by chat and drawn by the companion, and per CONVENTIONS.md a hook two
 * domains need is a top-level hook — the alternative is a cross-domain import,
 * which is how one domain quietly becomes another's library.
 *
 * Truncation happens here rather than in the card: what crosses the process
 * boundary is already a glance, so a very long thread never becomes a very
 * large IPC message on every token.
 */

import { useEffect, useRef } from "react";

import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { isElectron } from "@/runtime/is-electron";

/**
 * How much of the thread the card carries.
 *
 * Four is two exchanges: enough to see what you asked and what came back, and
 * the one before it for context. The app is where the thread lives.
 */
export const COMPANION_TURN_TAIL = 4;

export interface CompanionTurnRow {
  role: "user" | "assistant";
  text: string;
}

/** The tail, flattened to what the card draws. Exported for its test. */
export function companionTurnsFrom(
  messages: DisplayMessage[],
  tail = COMPANION_TURN_TAIL,
): CompanionTurnRow[] {
  const rows: CompanionTurnRow[] = [];
  for (const message of messages) {
    // Only the two roles the card can draw. A system row is not one side of
    // an exchange, and rendering it as one would put words in somebody's
    // mouth.
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messagePlainText(message).trim();
    // A row whose text has not arrived yet is skipped rather than sent empty:
    // an empty bubble in the card reads as an answer that said nothing.
    if (!text) continue;
    rows.push({ role: message.role, text });
  }
  return rows.slice(-tail);
}

export function usePublishCompanionTurns(
  messages: DisplayMessage[],
  thinking: boolean,
): void {
  // Publishing on every token would be an IPC message per frame. The
  // serialised tail is the honest change signal: it only differs when
  // something the card can actually draw has changed.
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectron()) return;
    const turns = companionTurnsFrom(messages);
    const signature = JSON.stringify({ turns, thinking });
    if (signature === lastSent.current) return;
    lastSent.current = signature;
    void window.vellum?.companion?.publishTurns?.(turns, thinking);
  }, [messages, thinking]);
}
