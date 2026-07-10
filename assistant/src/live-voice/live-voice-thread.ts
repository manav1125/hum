/**
 * Persist a live-voice (Gemini Live) conversation as a real, continuable chat
 * thread — the "post-call summary" the realtime engine was missing. Unlike the
 * cascade (which runs through the full Conversation object and persists as a
 * side effect), the Gemini Live session is otherwise ephemeral, so this owns:
 *
 *   1. `ensureLiveVoiceThread` — lazily create a surfaced, standard conversation
 *      so the call shows up in chat history the moment the user says something.
 *   2. `persistLiveVoiceTurn` — save each turn's user utterance + assistant reply
 *      (from Gemini's input/output transcription) as messages, so the full
 *      transcript is there to reopen and continue in text.
 *   3. `finalizeLiveVoiceThread` — on hang-up, write a short recap (summary +
 *      any tasks captured) and auto-title the thread from the transcript.
 *
 * All writes are best-effort: a persistence failure must never break the live
 * call. Continuing the thread in text "just works" because it is an ordinary
 * standard conversation under the same id.
 */

import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { setConversationSurfaced } from "../memory/conversation-crud.js";
import { queueRegenerateConversationTitle } from "../memory/conversation-title-service.js";
import {
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice-thread");

/** Message content is stored as a JSON array of content blocks. */
function textBlocks(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

/**
 * Create the conversation for this voice session if it doesn't exist yet, as a
 * standard + surfaced thread so it appears in the chat/recents list. Idempotent.
 */
export function ensureLiveVoiceThread(conversationId: string): void {
  if (getConversation(conversationId)) return;
  try {
    createConversation({
      id: conversationId,
      conversationType: "standard",
      source: "live-voice",
      title: "Voice conversation",
    });
    setConversationSurfaced(conversationId, true);
  } catch (err) {
    log.warn({ err, conversationId }, "ensureLiveVoiceThread failed");
  }
}

/** Persist one completed voice turn (user utterance + assistant reply). */
export async function persistLiveVoiceTurn(
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const u = userText.trim();
  const a = assistantText.trim();
  if (!u && !a) return;
  try {
    if (u) await addMessage(conversationId, "user", textBlocks(u));
    if (a) await addMessage(conversationId, "assistant", textBlocks(a));
  } catch (err) {
    log.warn({ err, conversationId }, "persistLiveVoiceTurn failed");
  }
}

/** Extract plain text from stored content-block JSON (best-effort). */
function messageText(content: string): string {
  try {
    const blocks = JSON.parse(content) as Array<{
      type?: string;
      text?: string;
    }>;
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
    }
  } catch {
    // Older/plain content — use as-is.
  }
  return content.trim();
}

function composeRecap(summary: string, taskTitles: string[]): string {
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (taskTitles.length > 0) {
    parts.push(
      [
        "",
        "Captured from our conversation:",
        ...taskTitles.map((t) => `• ${t}`),
      ].join("\n"),
    );
  }
  parts.push("", "Pick up right here anytime — just type below.");
  return parts.join("\n");
}

/**
 * On session end, write a recap and auto-title the thread. `taskTitles` are the
 * tasks captured during the call (already real work items) so the recap can list
 * them. Best-effort and non-throwing.
 */
export async function finalizeLiveVoiceThread(
  conversationId: string,
  opts: { taskTitles: string[] },
): Promise<void> {
  const conv = getConversation(conversationId);
  if (!conv) return;
  const messages = getMessages(conversationId);
  if (messages.length === 0) return;

  try {
    const provider = await getConfiguredProvider("meetingRecap");
    let summary = "";
    if (provider) {
      // Label the assistant's lines "Cue (me)" so the recap writer — which IS
      // Cue — knows those are its own words and writes the recap in first person.
      const transcript = messages
        .map(
          (m) =>
            `${m.role === "assistant" ? "Cue (me)" : "User"}: ${messageText(m.content)}`,
        )
        .filter((line) => line.length > 8)
        .join("\n");
      if (/\n?User: |\n?Cue \(me\): /.test(transcript)) {
        const response = await provider.sendMessage(
          [
            userMessage(
              `Below is the transcript of a voice conversation you (Cue) just had with your user. Lines marked "Cue (me)" are your own words; lines marked "User" are theirs. Write a brief recap of the conversation in 2-3 warm, concise sentences, in the FIRST PERSON ("I") and addressed to them as "you". Never refer to yourself as "Cue" or in the third person. Plain text only.\n\n${transcript}`,
            ),
          ],
          {
            systemPrompt:
              "You are Cue, the user's personal AI chief-of-staff, writing a short friendly recap of a voice conversation you just had. Always first person ('I'), never refer to yourself by name or in the third person.",
            config: { callSite: "meetingRecap" as const },
          },
        );
        summary = extractText(response).trim();
      }
    }
    const recap = composeRecap(summary, opts.taskTitles);
    if (recap.trim()) {
      await addMessage(conversationId, "assistant", textBlocks(recap));
    }
  } catch (err) {
    log.warn({ err, conversationId }, "finalizeLiveVoiceThread recap failed");
  }

  // Auto-title from the transcript (best-effort, runs in the background).
  queueRegenerateConversationTitle({ conversationId });
}
