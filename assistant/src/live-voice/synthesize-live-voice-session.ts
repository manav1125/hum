/**
 * End-of-session synthesis for a live voice conversation. When a call ends, this
 * takes the full transcript and:
 *
 *   1. Extracts any NEW to-dos the user asked to be remembered/done that were
 *      NOT already captured as tasks during the call, and mints them as PARKED
 *      work items (reminders that surface in the recap + Activity, never
 *      auto-run) — so "oh, and remind me to…" said mid-conversation isn't lost.
 *   2. Writes what was said into memory (best-effort graph extraction), so the
 *      conversation durably updates what Cue knows about the user.
 *
 * Both engines call this at close(); it is engine-agnostic (reads the persisted
 * thread, not engine state) and entirely best-effort — a failure never affects
 * the call, and it returns the titles of any newly-parked tasks so the recap can
 * list them alongside the tasks already handled during the call.
 *
 * De-duplication: tasks created DURING the call carry `originConversationId ===
 * conversationId`, so their titles are handed to the extractor as "already
 * handled — do not repeat", and `actionItemsToWorkItems` is additionally
 * idempotent on `(sourceType, conversationId, title)`. Two layers so a residual
 * to-do is captured once, never twice.
 */

import { getConfig } from "../config/loader.js";
import { getConversation, getMessages } from "../memory/conversation-crud.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { actionItemsToWorkItems } from "../runtime/services/action-item-work-items.js";
import { getLogger } from "../util/logger.js";
import { listWorkItemsByOriginConversation } from "../work-items/work-item-store.js";

const log = getLogger("live-voice-synthesis");

/** Provenance tag for items minted at the end of a live voice call. */
const VOICE_LIVE_SOURCE_TYPE = "voice-live";

/** Below this transcript length there's nothing worth extracting. */
const MIN_TRANSCRIPT_CHARS = 120;

const SYNTHESIS_TOOL_SCHEMA = {
  name: "capture_session_followups",
  description:
    "Capture the NEW follow-up to-dos the user asked to be remembered or done during a finished voice conversation, excluding anything already handled.",
  input_schema: {
    type: "object" as const,
    properties: {
      action_items: {
        type: "array",
        description:
          "Every NEW distinct to-do the user asked Cue to remember or do that is NOT already in the already-handled list. Empty array if there is nothing new.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The to-do phrased as a clear, self-contained imperative task, preserving concrete details (names, dates, amounts).",
            },
          },
          required: ["text"],
        },
      },
    },
    required: ["action_items"],
  },
} as const;

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

export interface LiveVoiceSynthesisResult {
  /** Titles of tasks newly parked from residual to-dos (for the recap). */
  newTaskTitles: string[];
}

/**
 * Run end-of-session synthesis. Never throws. Returns the titles of any newly
 * parked follow-up tasks (empty when there were none or on any failure).
 */
export async function synthesizeLiveVoiceSession(
  conversationId: string,
): Promise<LiveVoiceSynthesisResult> {
  const empty: LiveVoiceSynthesisResult = { newTaskTitles: [] };
  try {
    if (!getConversation(conversationId)) return empty;
    const messages = getMessages(conversationId);
    if (messages.length === 0) return empty;

    const transcript = messages
      .map(
        (m) =>
          `${m.role === "assistant" ? "Cue (me)" : "User"}: ${messageText(m.content)}`,
      )
      .filter((line) => line.length > 8)
      .join("\n");
    if (transcript.length < MIN_TRANSCRIPT_CHARS) return empty;

    // Titles already captured DURING the call — passed to the extractor as
    // "already handled" so it only returns genuinely new residual to-dos.
    const alreadyCaptured = listWorkItemsByOriginConversation(conversationId)
      .map((w) => w.title)
      .filter((t) => typeof t === "string" && t.trim().length > 0);

    // Memory first (best-effort, independent of the action-item extraction) so
    // what was said durably updates what Cue knows — even if no new tasks.
    void (async () => {
      try {
        const config = getConfig();
        const { runGraphExtraction } =
          await import("../memory/graph/extraction.js");
        await runGraphExtraction(conversationId, "default", config, {
          transcript,
        });
      } catch (err) {
        log.warn(
          { err, conversationId },
          "live-voice memory extraction failed",
        );
      }
    })();

    const provider = await getConfiguredProvider("meetingRecap");
    if (!provider) return empty;

    const alreadyBlock =
      alreadyCaptured.length > 0
        ? `\n\n## Already handled during the call (do NOT repeat these)\n${alreadyCaptured.map((t) => `- ${t}`).join("\n")}`
        : "";

    const response = await provider.sendMessage(
      [
        userMessage(
          `## Voice conversation transcript\n\n${transcript}${alreadyBlock}`,
        ),
      ],
      {
        tools: [SYNTHESIS_TOOL_SCHEMA],
        systemPrompt:
          "You are Cue. The voice conversation above has just ended. Call capture_session_followups exactly once with only the NEW to-dos the user explicitly asked you to remember or do that are NOT already in the already-handled list. Split compound requests into separate items. Do NOT invent tasks the user did not ask for, do NOT include things you already did or already captured, and do NOT include mere musings or questions. Return an empty array if there is nothing new.",
        config: {
          callSite: "meetingRecap" as const,
          tool_choice: {
            type: "tool" as const,
            name: "capture_session_followups",
          },
        },
      },
    );

    const toolBlock = extractToolUse(response);
    if (!toolBlock) return empty;
    const rawItems = (toolBlock.input as { action_items?: unknown })
      .action_items;
    const actionItems = Array.isArray(rawItems)
      ? rawItems.flatMap(
          (item): Array<{ text: string; owner: null; done: false }> => {
            if (typeof item !== "object" || item === null) return [];
            const text = String((item as { text?: unknown }).text ?? "").trim();
            if (!text) return [];
            return [{ text, owner: null, done: false }];
          },
        )
      : [];
    if (actionItems.length === 0) return empty;

    // Park them: reminders the user runs themselves; never auto-fired at hang-up.
    const refs = await actionItemsToWorkItems(
      actionItems,
      VOICE_LIVE_SOURCE_TYPE,
      conversationId,
      { parked: true },
    );
    return { newTaskTitles: refs.map((r) => r.title) };
  } catch (err) {
    log.warn({ err, conversationId }, "live-voice session synthesis failed");
    return empty;
  }
}
