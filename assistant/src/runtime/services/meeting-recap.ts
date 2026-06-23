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
import type { ServerMessage } from "../../daemon/message-protocol.js";
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
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { createTask } from "../../tasks/task-store.js";
import { getLogger } from "../../util/logger.js";
import {
  createWorkItemWithPermissions,
  findActiveWorkItemBySource,
} from "../../work-items/work-item-store.js";

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
  /**
   * Work items minted from this recap's open action items (executable tasks
   * that land in Activity → Cued). Each entry maps one action item to its
   * work item id; the UI uses the count to render "Added to your tasks".
   * Already-existing items (idempotent re-run) are still listed with
   * `created: false` so re-running a recap reports the same set without
   * inflating the count of newly-minted rows.
   */
  workItems: RecapWorkItemRef[];
}

/** A reference to a work item created (or reused) from a recap action item. */
export interface RecapWorkItemRef {
  /** The work item id (row in the `work_items` table). */
  id: string;
  /** The action-item text that became this work item's title. */
  title: string;
  /** True when this run minted the row; false when an active match was reused. */
  created: boolean;
}

/**
 * The recap content produced by the model (or the stub), before the
 * conversation-tagging, memory ids, and work-item bridging fields are
 * attached. Built by {@link buildStubRecapBody} / {@link parseRecapToolInput}.
 */
type RecapBody = Omit<
  RecapJson,
  "conversationId" | "memoryNodeIds" | "workItems"
>;

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
function buildStubRecapBody(): RecapBody {
  return {
    summary:
      "Renewal is on track for Q3 and pricing stays as-is. Dana wants the forecast before legal review, with one open risk on timeline.",
    actionItems: [
      { text: "Share the Q3 forecast with Dana", owner: "you", done: false },
      {
        text: "Introduce Dana to Legal for the review",
        owner: "you",
        done: false,
      },
      { text: "Send the pricing one-pager", owner: "you", done: true },
    ],
    decisions: [
      "Pricing stays unchanged for the renewal.",
      "Proceed to legal review once the forecast is shared.",
    ],
    people: [
      {
        name: "Dana",
        tone: "positive",
        note: "decision-maker; wants the forecast first",
      },
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

function parseRecapToolInput(input: Record<string, unknown>): RecapBody {
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
    ? raw.decisions.filter(
        (d): d is string => typeof d === "string" && d.length > 0,
      )
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
// Action items → executable work items
// ---------------------------------------------------------------------------

/**
 * Source tag stamped onto every work item minted from a meeting recap. The
 * meeting conversation id is the `sourceId`, so the dedup key is
 * `(meeting, conversationId, title)` — re-running the recap on the same
 * meeting reuses the existing rows instead of duplicating them, while two
 * different meetings that happen to share an action text stay distinct.
 */
const MEETING_WORK_ITEM_SOURCE_TYPE = "meeting";

/**
 * Map a recap's open action items to executable work items so the user can
 * run them from Activity → Cued (or have them auto-run per autonomy policy).
 *
 * Behaviour:
 *   - Only **open** action items (`done === false`) become work items — an
 *     action the meeting already completed is not work to do.
 *   - **Idempotent**: keyed on `(sourceType=meeting, sourceId=conversationId,
 *     title)` via {@link findActiveWorkItemBySource}, so re-running the recap
 *     on the same meeting reuses the existing active rows rather than minting
 *     duplicates. Two recap runs that produce the same action text collapse
 *     to one work item.
 *   - Each item gets a lightweight task template (the executor needs a
 *     `taskId`); the action text is the template (the instruction the model
 *     receives at run time) and the work item title.
 *   - Priority defaults to medium (tier 1); status is `queued` (the default
 *     from `createWorkItem`).
 *
 * Works for the self-host **local owner**: work-item/task creation is keyed on
 * the conversation, not on a principal — there is no actor gate here — so a
 * `local:` owner with `actorPrincipalId` undefined gets the same rows.
 *
 * Best-effort and isolated per item: a failure on one action item is logged
 * and skipped; the others (and the recap itself) are unaffected.
 */
function createWorkItemsFromActionItems(
  actionItems: RecapActionItem[],
  conversationId: string,
): RecapWorkItemRef[] {
  const refs: RecapWorkItemRef[] = [];
  const seenTitles = new Set<string>();

  for (const item of actionItems) {
    if (item.done) continue;
    const title = item.text.trim();
    if (!title) continue;

    // Collapse intra-recap duplicates (the same action emitted twice) before
    // touching the store.
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    try {
      // Idempotency: reuse an active work item already minted for this
      // (meeting, conversation, title) — re-running recap must not duplicate.
      const existing = findActiveWorkItemBySource({
        title,
        sourceType: MEETING_WORK_ITEM_SOURCE_TYPE,
        sourceId: conversationId,
      });
      if (existing) {
        refs.push({ id: existing.id, title: existing.title, created: false });
        continue;
      }

      // The executor runs against a task template, so mint a lightweight one.
      const task = createTask({
        title,
        template: title,
        createdFromConversationId: conversationId,
      });
      const workItem = createWorkItemWithPermissions({
        taskId: task.id,
        title,
        notes: item.owner ? `Owner: ${item.owner}` : undefined,
        priorityTier: 1, // medium
        sourceType: MEETING_WORK_ITEM_SOURCE_TYPE,
        sourceId: conversationId,
      });
      refs.push({ id: workItem.id, title: workItem.title, created: true });
    } catch (err) {
      log.warn(
        { err, conversationId, title },
        "Failed to create work item from recap action item (skipped)",
      );
    }
  }

  // If this run minted any new rows, tell Activity to refresh live.
  if (refs.some((r) => r.created)) {
    broadcastMessage({ type: "tasks_changed" } as ServerMessage);
  }

  return refs;
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
    const stubBody = buildStubRecapBody();
    const stubWorkItems = createWorkItemsFromActionItems(
      stubBody.actionItems,
      conversationId,
    );
    return {
      ...stubBody,
      conversationId,
      memoryNodeIds: result.createdNodeIds,
      workItems: stubWorkItems,
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

  let recapBody: RecapBody;
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
          message:
            "The model did not return a structured recap. Please try again.",
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
    const { runGraphExtraction } =
      await import("../../memory/graph/extraction.js");
    await runGraphExtraction(conversationId, "default", config, {
      transcript: trimmed,
    });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Graph extraction for meeting recap failed (recap still returned)",
    );
  }

  // e. Bridge the recap's open action items into executable work items
  //    (Activity → Cued). Idempotent on re-run; best-effort so it never fails
  //    the recap the user already has.
  const workItems = createWorkItemsFromActionItems(
    recapBody.actionItems,
    conversationId,
  );

  // f. Return the recap. `memoryNodeIds` from the generic extraction are not
  //    surfaced individually (runGraphExtraction returns counts, not ids); the
  //    field is populated in stub mode and left empty here. Memory is still
  //    written and tagged via `sourceConversations: [conversationId]`.
  return {
    ...recapBody,
    conversationId,
    memoryNodeIds,
    workItems,
  };
}
