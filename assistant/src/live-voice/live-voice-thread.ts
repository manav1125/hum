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
 *   4. `buildLiveVoiceThreadContext` — the read side of (2): the recent tail of
 *      an existing thread, so a call started inside a conversation opens
 *      knowing what was already said in it.
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
  getMessagesPaginated,
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
    // `voiceTurn` is the durable voice marker (same key the cascade path
    // stamps via the voice-session bridge) so reloaded history can render
    // spoken turns distinctly.
    if (u) {
      await addMessage(conversationId, "user", textBlocks(u), {
        metadata: { voiceTurn: true },
      });
    }
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

/**
 * Bounds on the session-start thread recap. Same spirit as `buildLiveBriefing`'s
 * caps: enough for the model to continue the conversation it is sitting inside,
 * never enough to slow session start or crowd the realtime context window.
 */
const MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 2000;
const MAX_MESSAGE_CHARS = 400;

/**
 * The recent tail of the conversation this call is bound to, formatted as the
 * same compact `User:` / `You:` recap the mid-call reconnect note uses.
 *
 * Why this exists: a live session's model reasons entirely from its setup-time
 * system instruction. `buildLiveBriefing` gives it the user's world (memory,
 * missions, tasks) but nothing about THIS thread — so voice started inside an
 * existing conversation answered as if the conversation had never happened,
 * asking "when did it start?" about an injury discussed three messages earlier.
 * The caller appends this to the system instruction (rather than injecting it
 * after connect) so it is replayed verbatim on every upstream reconnect.
 *
 * Returns "" when there is nothing to seed — a brand-new voice-initiated thread
 * has no rows yet, and callers treat "" as "append nothing", exactly like an
 * empty briefing. Never throws: the call must start even if this read fails.
 *
 * Only spoken/typed conversation is included. `messageText` keeps `text` blocks
 * only, so `thinking` blocks and tool-result rows contribute nothing and drop
 * out — spoken context wants the conversation, not the machinery.
 */
export function buildLiveVoiceThreadContext(
  conversationId: string,
  opts?: { maxMessages?: number; maxChars?: number },
): string {
  try {
    // No thread yet → a fresh voice-initiated call. Nothing to recap, and no
    // reason to pay for a query.
    if (!getConversation(conversationId)) return "";
    const maxMessages = opts?.maxMessages ?? MAX_CONTEXT_MESSAGES;
    const maxChars = opts?.maxChars ?? MAX_CONTEXT_CHARS;
    // Newest `maxMessages` visible rows, returned oldest-first. Paginated (not
    // `getMessages`) so a long-running thread is a bounded read, not a full
    // transcript load on the session-start path.
    const { messages } = getMessagesPaginated(
      conversationId,
      maxMessages,
      undefined,
      (row) =>
        (row.role === "user" || row.role === "assistant") &&
        messageText(row.content).length > 0,
    );
    const lines: string[] = [];
    for (const row of messages) {
      const text = messageText(row.content);
      if (!text) continue;
      const clipped =
        text.length > MAX_MESSAGE_CHARS
          ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
          : text;
      lines.push(`${row.role === "assistant" ? "You" : "User"}: ${clipped}`);
    }
    if (lines.length === 0) return "";
    // Trim from the OLDEST end until the recap fits: the most recent exchange
    // is the one the caller is most likely still talking about.
    while (lines.length > 1 && lines.join("\n").length > maxChars) {
      lines.shift();
    }
    let body = lines.join("\n");
    if (body.length > maxChars) body = `${body.slice(0, maxChars)}…`;
    return [
      'CONVERSATION SO FAR — this call is continuing a conversation you are already having with them, which may have been in text. Below is its recent tail in order, oldest first; "User:" is them, "You:" is you. Treat it as your own memory of what was just said: refer back to it naturally, and answer follow-ups ("how is this related to what we just spoke about?") from it. Do NOT read it aloud, recap it unprompted, or mention that you were given it.',
      "",
      body,
    ].join("\n");
  } catch (err) {
    log.warn({ err, conversationId }, "buildLiveVoiceThreadContext failed");
    return "";
  }
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
