/**
 * Service: generateMeetingRecap
 *
 * Turns a raw meeting transcript into a structured recap (summary, action
 * items, decisions, people + tone) and persists what it learns into the
 * 8-type graph memory, tagged by a freshly-created meeting conversation so
 * the recap and its memories are traceable back to a single meeting.
 *
 * Two modes:
 *   - **stub** (`RECAP_STUB` env set): returns a fixed RecapJson and writes a
 *     couple of canned memory nodes via `applyDiff`. No provider call — used
 *     for wiring/integration tests and when no LLM spend is available.
 *   - **live**: resolves the `meetingRecap` call-site provider, makes a single
 *     forced tool call (`build_meeting_recap`) for the structured recap, and
 *     additionally runs the generic graph extraction so the standard 8-type
 *     pipeline writes memory tagged with the meeting conversation id.
 *
 * The provider is resolved through the provider abstraction
 * (`getConfiguredProvider`) — when it returns `null` (unconfigured or capped)
 * the service returns a clean error instead of throwing.
 */

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { applyDiff } from "../../memory/graph/store.js";
import type {
  EmotionalCharge,
  MemoryType,
  NewNode,
} from "../../memory/graph/types.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("meeting-recap-service");

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface RecapActionItem {
  text: string;
  owner: string | null;
  done: boolean;
}

export interface RecapPerson {
  name: string;
  tone: string;
  note?: string;
}

/** The structured recap returned to the client and rendered on the page. */
export interface RecapJson {
  summary: string;
  actionItems: RecapActionItem[];
  decisions: string[];
  people: RecapPerson[];
  tone: string;
  conversationId: string;
  memoryNodeIds: string[];
}

export interface GenerateMeetingRecapOptions {
  /** Title for the meeting conversation. Defaults to "Meeting — recap". */
  title?: string;
}

export interface MeetingRecapError {
  error: {
    kind: string;
    status: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Tool schema (template mirrored from EXTRACT_TOOL_SCHEMA in extraction.ts)
// ---------------------------------------------------------------------------

const RECAP_TOOL_SCHEMA = {
  name: "build_meeting_recap",
  description:
    "Produce a structured recap of the meeting transcript: summary, action items, decisions, people and tone.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "A 2–3 sentence summary of the meeting and its outcome.",
      },
      action_items: {
        type: "array",
        description: "Concrete follow-ups that came out of the meeting.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "The action to take." },
            owner: {
              type: ["string", "null"],
              description:
                "Who owns the action (a name), or null when unassigned.",
            },
            done: {
              type: "boolean",
              description: "Whether the action was already completed.",
            },
          },
          required: ["text", "owner", "done"],
        },
      },
      decisions: {
        type: "array",
        description: "Decisions reached during the meeting.",
        items: { type: "string" },
      },
      people: {
        type: "array",
        description: "People who participated and how they came across.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            tone: {
              type: "string",
              description:
                "Their tone/disposition (e.g. 'positive', 'decision-maker', 'skeptical').",
            },
            note: {
              type: "string",
              description: "Optional short note about this person.",
            },
          },
          required: ["name", "tone"],
        },
      },
      tone: {
        type: "string",
        description:
          "Overall tone of the meeting (e.g. 'warm', 'tense', 'productive').",
      },
    },
    required: ["summary", "action_items", "decisions", "people", "tone"],
  },
} as const;

const RECAP_SYSTEM_PROMPT = `You are summarizing a meeting from its transcript.
Call the build_meeting_recap tool exactly once with a faithful, concise recap.
- summary: 2–3 sentences capturing the outcome.
- action_items: only real follow-ups; set owner to a name when clear, otherwise null; done=false unless the transcript says it is already done.
- decisions: concrete decisions reached, one per entry.
- people: each named participant with their tone; add a short note only when useful.
- tone: one or two words for the overall mood.
Do not invent details that are not supported by the transcript.`;

// ---------------------------------------------------------------------------
// Stub recap
// ---------------------------------------------------------------------------

/** Build a fixed RecapJson body (no conversationId/memoryNodeIds yet). */
function buildStubRecapBody(): Omit<RecapJson, "conversationId" | "memoryNodeIds"> {
  return {
    summary:
      "Renewal is on track for Q3 and pricing stays as-is. Dana wants the forecast before legal review, with one open risk on timeline.",
    actionItems: [
      { text: "Share the Q3 forecast with Dana", owner: "you", done: false },
      { text: "Introduce Dana to Legal for the review", owner: "you", done: false },
      { text: "Send the pricing one-pager", owner: "you", done: true },
    ],
    decisions: [
      "Pricing stays unchanged for the renewal.",
      "Proceed to legal review once the forecast is shared.",
    ],
    people: [
      { name: "Dana", tone: "positive", note: "decision-maker; wants the forecast first" },
      { name: "Sam", tone: "engaged", note: "needs the deck" },
    ],
    tone: "warm",
  };
}

/**
 * Build the canned memory nodes written in stub mode. A decision (semantic)
 * and a follow-up (prospective), both tagged with the meeting conversation.
 */
function buildStubNodes(conversationId: string): NewNode[] {
  const now = Date.now();
  const neutralCharge: EmotionalCharge = {
    valence: 0,
    intensity: 0,
    decayCurve: "linear",
    decayRate: 0.05,
    originalIntensity: 0,
  };
  const base = {
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null as number | null,
    emotionalCharge: neutralCharge,
    fidelity: "vivid" as const,
    confidence: 0.7,
    significance: 0.6,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [conversationId],
    sourceType: "direct" as const,
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
  };
  return [
    {
      ...base,
      content:
        "In the Acme quarterly sync we decided pricing stays unchanged for the Q3 renewal.",
      type: "semantic" as MemoryType,
      stability: 14,
    },
    {
      ...base,
      content:
        "I need to share the Q3 forecast with Dana before the legal review.",
      type: "prospective" as MemoryType,
      stability: 5,
    },
  ];
}

// ---------------------------------------------------------------------------
// Live recap parsing
// ---------------------------------------------------------------------------

interface RawRecapInput {
  summary?: unknown;
  action_items?: unknown;
  decisions?: unknown;
  people?: unknown;
  tone?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseRecapToolInput(
  input: Record<string, unknown>,
): Omit<RecapJson, "conversationId" | "memoryNodeIds"> {
  const raw = input as RawRecapInput;

  const actionItems: RecapActionItem[] = Array.isArray(raw.action_items)
    ? raw.action_items.flatMap((item): RecapActionItem[] => {
        if (typeof item !== "object" || item === null) return [];
        const obj = item as Record<string, unknown>;
        const text = asString(obj.text);
        if (!text) return [];
        return [
          {
            text,
            owner: typeof obj.owner === "string" ? obj.owner : null,
            done: obj.done === true,
          },
        ];
      })
    : [];

  const decisions: string[] = Array.isArray(raw.decisions)
    ? raw.decisions.filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];

  const people: RecapPerson[] = Array.isArray(raw.people)
    ? raw.people.flatMap((p): RecapPerson[] => {
        if (typeof p !== "object" || p === null) return [];
        const obj = p as Record<string, unknown>;
        const name = asString(obj.name);
        if (!name) return [];
        const person: RecapPerson = { name, tone: asString(obj.tone) };
        if (typeof obj.note === "string" && obj.note.length > 0) {
          person.note = obj.note;
        }
        return [person];
      })
    : [];

  return {
    summary: asString(raw.summary),
    actionItems,
    decisions,
    people,
    tone: asString(raw.tone),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function generateMeetingRecap(
  transcript: string,
  opts: GenerateMeetingRecapOptions = {},
): Promise<RecapJson | MeetingRecapError> {
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

  // a. Create the meeting conversation and persist the transcript as a message.
  const conversation = createConversation({
    title: opts.title ?? "Meeting — recap",
    source: "meeting",
  });
  const conversationId = conversation.id;
  await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text: trimmed }]),
  );

  // b. Stub path — fixed recap + canned memory nodes, no provider call.
  if (process.env.RECAP_STUB) {
    const nodes = buildStubNodes(conversationId);
    const result = applyDiff(
      {
        createNodes: nodes,
        updateNodes: [],
        deleteNodeIds: [],
        createEdges: [],
        deleteEdgeIds: [],
        createTriggers: [],
        deleteTriggerIds: [],
        reinforceNodeIds: [],
      },
      { conversationId, source: "manual" },
    );
    return {
      ...buildStubRecapBody(),
      conversationId,
      memoryNodeIds: result.createdNodeIds,
    };
  }

  // c. Live path — resolve the provider through the abstraction. A null
  //    result means unconfigured or spend-capped; return a clean error.
  const provider = await getConfiguredProvider("meetingRecap");
  if (!provider) {
    return {
      error: {
        kind: "PROVIDER_UNAVAILABLE",
        status: 503,
        message:
          "No language model is configured for meeting recaps right now. Set a model in Settings → Models & Services and try again.",
      },
    };
  }

  let recapBody: Omit<RecapJson, "conversationId" | "memoryNodeIds">;
  try {
    const response = await provider.sendMessage(
      [userMessage(`## Meeting Transcript\n\n${trimmed}`)],
      {
        tools: [RECAP_TOOL_SCHEMA],
        systemPrompt: RECAP_SYSTEM_PROMPT,
        config: {
          callSite: "meetingRecap" as const,
          tool_choice: { type: "tool" as const, name: "build_meeting_recap" },
        },
      },
    );
    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      log.warn({ conversationId }, "No tool_use block in recap response");
      return {
        error: {
          kind: "RECAP_FAILED",
          status: 502,
          message: "The model did not return a structured recap. Please try again.",
        },
      };
    }
    recapBody = parseRecapToolInput(toolBlock.input);
  } catch (err) {
    log.error({ err, conversationId }, "Meeting recap provider call failed");
    return {
      error: {
        kind: "RECAP_FAILED",
        status: 502,
        message: "Couldn't generate the recap. Please try again.",
      },
    };
  }

  // d. Run the generic 8-type extraction so memory is written tagged with the
  //    meeting conversation id. Best-effort: a failure here must not fail the
  //    recap the user already has. Note: extraction skips transcripts <100
  //    chars — that's fine; the recap itself is unaffected.
  const memoryNodeIds: string[] = [];
  try {
    const config = getConfig();
    const { runGraphExtraction } = await import(
      "../../memory/graph/extraction.js"
    );
    await runGraphExtraction(conversationId, "default", config, {
      transcript: trimmed,
    });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Graph extraction for meeting recap failed (recap still returned)",
    );
  }

  // e. Return the recap. `memoryNodeIds` from the generic extraction are not
  //    surfaced individually (runGraphExtraction returns counts, not ids); the
  //    field is populated in stub mode and left empty here. Memory is still
  //    written and tagged via `sourceConversations: [conversationId]`.
  return {
    ...recapBody,
    conversationId,
    memoryNodeIds,
  };
}
