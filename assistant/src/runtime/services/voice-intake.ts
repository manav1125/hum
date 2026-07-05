/**
 * Service: generateVoiceIntake
 *
 * The "talk to Cue" magic. The user dictates a spoken brain-dump; this turns it
 * into a real working thread:
 *   1. Creates a conversation (`source: "voice"`) and persists the transcript
 *      as the user's first message — so the thread shows exactly what they said.
 *   2. Makes a single forced tool call (`capture_voice_intake`) to extract a
 *      warm read-back summary + the distinct action items the user asked for.
 *   3. Bridges every open action item into an executable work item (Activity →
 *      Cued) via the shared {@link actionItemsToWorkItems}, tagged `voice` and
 *      idempotent on `(voice, conversationId, title)`.
 *   4. Writes the first **assistant** message into the thread: the summary, the
 *      numbered action-item list, and an offer to start — so the thread is ready
 *      to "go to work" the moment the user lands in it.
 *   5. Best-effort: runs the generic graph extraction so what the user said is
 *      written to memory, tagged with the voice conversation.
 *
 * Reuses the meeting-recap call-site provider (the same structured-extraction
 * model) so no new provider config is required. When the provider is
 * unconfigured/capped the thread is still created with the raw transcript and a
 * graceful assistant message, so the user is never left with nothing.
 */

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";
import {
  type ActionItemInput,
  actionItemsToWorkItems,
  type ActionItemWorkItemRef,
} from "./action-item-work-items.js";

const log = getLogger("voice-intake-service");

/** Provenance tag for work items minted from a voice brain-dump. */
const VOICE_SOURCE_TYPE = "voice";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The structured intake returned to the client after a voice dictation. */
export interface VoiceIntakeResult {
  /** The freshly-created thread the user is navigated into. */
  conversationId: string;
  /** A warm 1–2 sentence read-back of what the user wants. */
  summary: string;
  /** The distinct action items extracted from the dictation. */
  actionItems: ActionItemInput[];
  /** The executable work items minted (or reused) from the action items. */
  workItems: ActionItemWorkItemRef[];
}

export interface VoiceIntakeError {
  error: {
    kind: string;
    status: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Tool schema + prompt
// ---------------------------------------------------------------------------

const VOICE_INTAKE_TOOL_SCHEMA = {
  name: "capture_voice_intake",
  description:
    "Capture what the user just dictated: a short, warm read-back summary and the distinct action items they want done.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description:
          "A warm 1–2 sentence read-back of what the user wants, written in the second person ('You want to…'). If they only mused, briefly reflect that back.",
      },
      action_items: {
        type: "array",
        description:
          "Every distinct, actionable thing the user asked for. Split a compound request ('do X and Y') into separate items. Empty array if the dictation contains no actionable request.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The action to take, phrased as a clear, self-contained imperative task.",
            },
            owner: {
              type: ["string", "null"],
              description:
                "Who the user said should own it (a name), or null when it's theirs / unassigned.",
            },
            done: {
              type: "boolean",
              description:
                "Always false — these are new requests the user is handing to Cue.",
            },
          },
          required: ["text", "owner", "done"],
        },
      },
    },
    required: ["summary", "action_items"],
  },
} as const;

const VOICE_INTAKE_SYSTEM_PROMPT = `You are Cue, an AI chief of staff. The user just spoke to you out loud; a transcript of their dictation follows. Call capture_voice_intake exactly once.
- summary: a warm, brief read-back (1–2 sentences, second person) of what they want.
- action_items: every distinct, actionable request, each phrased as a clear, self-contained imperative task. Split "do X and Y" into two items. Preserve concrete details (names, dates, amounts) inside the task text. If they only thought out loud or asked a question with no task, return an empty action_items array.
Do not invent tasks the user did not ask for. Keep each action item concise.`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

interface ParsedIntake {
  summary: string;
  actionItems: ActionItemInput[];
}

function parseVoiceIntakeInput(input: Record<string, unknown>): ParsedIntake {
  const rawItems = (input as { action_items?: unknown }).action_items;
  const actionItems: ActionItemInput[] = Array.isArray(rawItems)
    ? rawItems.flatMap((item): ActionItemInput[] => {
        if (typeof item !== "object" || item === null) return [];
        const obj = item as Record<string, unknown>;
        const text = asString(obj.text).trim();
        if (!text) return [];
        return [
          {
            text,
            owner: typeof obj.owner === "string" ? obj.owner : null,
            // Voice intake is always net-new requests; never pre-complete.
            done: false,
          },
        ];
      })
    : [];

  return {
    summary: asString((input as { summary?: unknown }).summary).trim(),
    actionItems,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** A short, human thread title derived from the transcript's opening words. */
function deriveTitle(transcript: string): string {
  const oneLine = transcript.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 48) return oneLine || "Voice note";
  return `${oneLine.slice(0, 48).trimEnd()}…`;
}

/**
 * Compose the first assistant message: the read-back, the numbered action-item
 * list, and an offer to start — markdown rendered in the thread. This is what
 * makes the thread feel like it "went to work" the instant the user lands.
 */
function composeAssistantMessage(
  summary: string,
  actionItems: ActionItemInput[],
): string {
  const lines: string[] = [];
  lines.push(summary || "Got it — here's what I heard.");

  if (actionItems.length > 0) {
    lines.push("");
    lines.push(
      actionItems.length === 1 ? "**Action item**" : "**Action items**",
    );
    actionItems.forEach((item, i) => {
      const owner =
        item.owner && item.owner.toLowerCase() !== "you"
          ? ` _(${item.owner})_`
          : "";
      lines.push(`${i + 1}. ${item.text}${owner}`);
    });
    lines.push("");
    lines.push(
      actionItems.length === 1
        ? "I've queued this as a task — run it from here or anytime in Activity. Want me to start on it?"
        : "I've queued these as tasks — run them from here or anytime in Activity. Want me to start on them?",
    );
  } else {
    lines.push("");
    lines.push(
      "I didn't catch a specific task in that — tell me what you'd like me to do, or just keep talking.",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function generateVoiceIntake(
  transcript: string,
): Promise<VoiceIntakeResult | VoiceIntakeError> {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return {
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Transcript is empty",
      },
    };
  }

  // 1. Create the voice thread and persist the transcript as the first message.
  const conversation = createConversation({
    title: deriveTitle(trimmed),
    source: VOICE_SOURCE_TYPE,
  });
  const conversationId = conversation.id;
  await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text: trimmed }]),
  );

  // 2. Resolve the structured-extraction provider (shared with meeting recap).
  //    When unavailable, still hand back a usable thread with the raw words.
  const provider = await getConfiguredProvider("meetingRecap");
  if (!provider) {
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify([
        {
          type: "text",
          text: `Here's what you said:\n\n> ${trimmed}\n\nI couldn't turn this into tasks just now (no language model is configured). Set one in Settings → Models & Services, or tell me what you'd like me to do.`,
        },
      ]),
    );
    return { conversationId, summary: "", actionItems: [], workItems: [] };
  }

  // 3. One forced tool call → summary + action items.
  let parsed: ParsedIntake;
  try {
    const response = await provider.sendMessage(
      [userMessage(`## Voice transcript\n\n${trimmed}`)],
      {
        tools: [VOICE_INTAKE_TOOL_SCHEMA],
        systemPrompt: VOICE_INTAKE_SYSTEM_PROMPT,
        config: {
          callSite: "meetingRecap" as const,
          tool_choice: { type: "tool" as const, name: "capture_voice_intake" },
        },
      },
    );
    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      // No structured output — degrade gracefully rather than fail the thread.
      log.warn(
        { conversationId },
        "No tool_use block in voice-intake response",
      );
      parsed = { summary: "", actionItems: [] };
    } else {
      parsed = parseVoiceIntakeInput(toolBlock.input);
    }
  } catch (err) {
    log.error({ err, conversationId }, "Voice-intake provider call failed");
    parsed = { summary: "", actionItems: [] };
  }

  // 4. Bridge open action items into executable work items (idempotent). Each
  //    item is triaged (filed onto its best-matching project → mission, ranked,
  //    and — per the autonomy guard — auto-run or left for review), and the
  //    resolved filing is folded into the refs so the client can show the real
  //    ⟡ project/mission tag.
  const workItems = await actionItemsToWorkItems(
    parsed.actionItems,
    VOICE_SOURCE_TYPE,
    conversationId,
  );

  // 5. Write the first assistant message so the thread is immediately useful.
  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([
      {
        type: "text",
        text: composeAssistantMessage(parsed.summary, parsed.actionItems),
      },
    ]),
  );

  // 6. Best-effort: capture what the user said into memory, tagged with this
  //    conversation. Never fails the intake the user already has. (Extraction
  //    skips transcripts under ~100 chars — fine; the thread is unaffected.)
  try {
    const config = getConfig();
    const { runGraphExtraction } =
      await import("../../memory/graph/extraction.js");
    await runGraphExtraction(conversationId, "default", config, {
      transcript: trimmed,
    });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Graph extraction for voice intake failed (intake still returned)",
    );
  }

  return {
    conversationId,
    summary: parsed.summary,
    actionItems: parsed.actionItems,
    workItems,
  };
}
