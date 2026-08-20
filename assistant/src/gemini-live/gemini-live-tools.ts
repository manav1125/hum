/**
 * Function-calling bridge: the curated set of Cue actions exposed to the Gemini
 * Live model, and the executor that runs them against Cue's real stores and
 * tool execution layer when the model calls one. This is what makes "Tier 1"
 * voice able to actually DO things (not just chat) — and `run_deep_task` is the
 * escalation hatch to the full agent loop for anything substantive.
 *
 * Two execution paths, both real:
 *
 * - `add_task` / `run_deep_task` / `get_open_tasks` call the tested work-item
 *   functions directly (the fast path — the shared task executors block on
 *   triage, which stalls a realtime turn; see {@link createWorkItemFast}).
 * - Everything else dispatches by REGISTERED NAME through the shared
 *   {@link ToolExecutor}, so every call runs the same pre-execution gates and
 *   permission checks (`ToolApprovalHandler` + `PermissionChecker`) the
 *   cascade's tools run. The voice context is non-interactive guardian: a
 *   prompt-gated tool auto-approves only within the user's background
 *   threshold and otherwise resolves as a clean denial the model can speak —
 *   never a silent bypass, never a hung prompt.
 *
 * `ui_show` is the exception by design: it is a pure display instruction, so
 * the bridge validates a first-class subset (list / card / table — the voice
 * cards Slice 1 surface) and emits the same `card` frame the cascade emits;
 * the client renders it through the same store.
 *
 * New declarations must map to real executors the same way — never a stub that
 * reports false success (the cardinal voice sin). The whole declarations array
 * must stay under {@link GEMINI_LIVE_TOOL_SCHEMA_BUDGET_BYTES}: the realtime
 * session config cannot carry the full registry, which is exactly why this
 * surface is curated.
 */

import { randomUUID } from "node:crypto";

import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { ensureLiveVoiceThread } from "../live-voice/live-voice-thread.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { createTask } from "../tasks/task-store.js";
import { ToolExecutor } from "../tools/executor.js";
import { getTool } from "../tools/registry.js";
import type {
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEventHandler,
} from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import {
  createWorkItemWithPermissions,
  listWorkItems,
} from "../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../work-items/work-item-triage.js";
import type {
  GeminiFunctionDeclaration,
  GeminiLiveToolCall,
} from "./gemini-live-client.js";

const log = getLogger("gemini-live-tools");

/**
 * Skills whose bundled tools back the registry-dispatched declarations below.
 * The session registers them at start (same projection machinery the cascade's
 * preactivation uses) so `schedule_list`, `contact_search`, `followup_list`,
 * `messaging_list_conversations`, `messaging_read`, `schedule_create` resolve
 * in the tool registry for the session's lifetime.
 */
export const GEMINI_LIVE_VOICE_SKILLS: readonly string[] = [
  "schedule",
  "contacts",
  "messaging",
  "followups",
];

/**
 * Hard budget for the serialized declarations array. The Live session setup
 * message carries these on every connect; a bloated schema costs latency and
 * context on every single turn. Enforced by test.
 */
export const GEMINI_LIVE_TOOL_SCHEMA_BUDGET_BYTES = 6144;

/** Serialized size of the declarations actually shipped to the Live session. */
export function geminiLiveDeclarationsJsonBytes(): number {
  return Buffer.byteLength(
    JSON.stringify(GEMINI_LIVE_FUNCTION_DECLARATIONS),
    "utf8",
  );
}

/**
 * Surface types the voice bridge renders as tiles. A deliberate subset of the
 * full `ui_show` catalog: display-only shapes with no action buttons and no
 * approval semantics. Anything richer belongs to the cascade (H-4).
 */
const VOICE_SURFACE_TYPES = new Set(["list", "card", "table"]);

export const GEMINI_LIVE_FUNCTION_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "add_task",
    description:
      "Save a quick to-do or reminder to the user's task list. For simple things they ask you to note down.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short task title, e.g. 'Call the dentist'.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "run_deep_task",
    description:
      "Hand substantive work (research, drafting, multi-step tasks) to Cue's full assistant to do in the background. The result lands in the user's Review lane.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "Clear, self-contained description of what to do.",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "get_open_tasks",
    description:
      "List the user's open work items (queued, running, or awaiting review) — what's on their plate.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "web_search",
    description:
      "Search the live web: current facts, news, weather, prices, anything you don't know.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_memory",
    description:
      "Search the user's own memory, past conversations, and files — things they've told you or done before. Use before saying you don't know something about them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for: topic, person, project, decision.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Save a lasting fact, preference, or commitment the user just told you to long-term memory.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact, written naturally.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "get_schedule",
    description:
      "List the reminders and scheduled automations Cue set for the user, or details of one by id. NOT their Google Calendar — that is get_calendar.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Optional: show details for one schedule.",
        },
      },
    },
  },
  {
    name: "get_calendar",
    description:
      "List events on the user's real Google Calendar (meetings, appointments) in a time range. Use for any what's-on-my-calendar question; distinct from get_schedule (Cue reminders you set).",
    parameters: {
      type: "object",
      properties: {
        time_min: {
          type: "string",
          description:
            "Range start, ISO 8601 with offset, e.g. 2026-08-10T00:00:00+08:00. Default: now.",
        },
        time_max: {
          type: "string",
          description: "Range end, ISO 8601 with offset. Default: 7 days on.",
        },
      },
    },
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder — one-time (when) or recurring (repeat). The user gets notified at that time.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "What to remind them of.",
        },
        when: {
          type: "string",
          description:
            "One-time: ISO 8601 local timestamp, e.g. 2026-08-11T17:00:00.",
        },
        repeat: {
          type: "string",
          description: "Recurring: cron expression, e.g. '0 9 * * 1'.",
        },
        timezone: {
          type: "string",
          description: "IANA timezone, e.g. Asia/Makassar.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "find_contact",
    description:
      "Look up a person in the user's contacts by name, or by email/phone/handle.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name (partial ok)." },
        address: {
          type: "string",
          description: "Email, phone, or handle (partial ok).",
        },
      },
    },
  },
  {
    name: "get_followups",
    description:
      "List messages the user is waiting on replies to (their follow-ups).",
    parameters: {
      type: "object",
      properties: {
        overdue_only: {
          type: "boolean",
          description: "Only follow-ups past their expected reply time.",
        },
      },
    },
  },
  {
    name: "check_inbox",
    description:
      "List the user's message inboxes and conversations with unread counts (e.g. email).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max conversations (default 10).",
        },
      },
    },
  },
  {
    name: "read_messages",
    description:
      "Read recent messages in one conversation, by conversation_id from check_inbox.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "Conversation id to read.",
        },
        limit: { type: "number", description: "Max messages (default 10)." },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "ui_show",
    description:
      "Put a visual card on the user's screen. Announce it aloud in one short sentence first, then call this; summarize aloud — never read items one by one. Shapes: list {items:[{title,subtitle?}]}, card {title,body}, table {columns:[{id,label}],rows:[{cells:{<colId>:text}}]}.",
    parameters: {
      type: "object",
      properties: {
        surface_type: {
          type: "string",
          enum: ["list", "card", "table"],
          description: "What kind of card.",
        },
        title: { type: "string", description: "Card title." },
        data: {
          type: "object",
          description: "Card data; shape depends on surface_type.",
        },
      },
      required: ["surface_type", "data"],
    },
  },
];

/**
 * The Composio-registered MCP tool `get_calendar` dispatches to. Present only
 * on an instance with a live Composio Google Calendar connection (prod); on a
 * local instance the name is absent from the registry and `get_calendar`
 * degrades to the honest not-connected answer.
 *
 * READ-ONLY by design: the write siblings (GOOGLECALENDAR_CREATE_EVENT,
 * GOOGLECALENDAR_QUICK_ADD, update/delete) are deliberately NOT bridged —
 * calendar writes can invite guests (outward-facing sends) and wait for the
 * approval-frames workstream (H-4 / V-3). GOOGLECALENDAR_FIND_EVENT also
 * exists on prod but the ranged EVENTS_LIST covers the voice use case.
 */
export const GEMINI_LIVE_CALENDAR_EVENTS_TOOL =
  "mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST";

/**
 * Registry tool names the voice declarations dispatch to. Doubles as the
 * execution-layer allowlist on the {@link ToolContext}, so even a mapping bug
 * here could not reach a tool outside the curated surface. Exported so tests
 * can assert the surface stays curated.
 */
export const GEMINI_LIVE_REGISTRY_TOOL_ALLOWLIST = new Set([
  "web_search",
  "recall",
  "remember",
  "schedule_list",
  "schedule_create",
  "contact_search",
  "followup_list",
  "messaging_list_conversations",
  "messaging_read",
  GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
]);

/**
 * A visual card the bridge asks the session to show. The session wraps it in
 * the wire `card` frame (adding the turn id), identical to the frames the
 * cascade forwards from `ui_surface_show` — the client renders both through
 * the same store.
 */
export interface GeminiLiveCard {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
}

export interface GeminiLiveToolExecutionContext {
  conversationId: string;
  /** Aborted when the voice session closes; forwarded to registry tools. */
  signal?: AbortSignal;
  /** Show a visual card (the session emits the `card` frame). */
  showCard?: (card: GeminiLiveCard) => void;
  /**
   * Called when `run_deep_task` hands work to the background agent loop, with
   * the created work item's id + spoken title. The session uses it to register
   * interest in that item's completion so a still-open call can announce the
   * result (the escalation's return path — without it the task finishes into
   * Review while the user sits in a silent call). Optional: when absent the
   * escalation stays fire-and-forget exactly as before.
   */
  onDeepTaskStarted?: (workItem: { id: string; title: string }) => void;
  /**
   * Test seam: overrides the shared registry-executor path. Production leaves
   * this unset and every registry-backed call runs through the real
   * {@link ToolExecutor} (permission checks included).
   */
  runRegistryTool?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
  /**
   * Test seam: registry-presence probe for MCP-backed declarations
   * (`get_calendar`). Production leaves this unset and the REAL registry is
   * consulted — which is exactly how a locally-unconnected instance degrades
   * to the honest not-connected answer instead of a confabulated calendar.
   */
  isToolRegistered?: (name: string) => boolean;
}

// ── Registry dispatch ────────────────────────────────────────────────

/**
 * One executor for all gemini-live sessions. Its prompter's sender is a no-op
 * because the voice context is non-interactive (`isInteractive: false`): the
 * permission checker resolves prompt decisions itself (guardian auto-approve
 * within the background threshold, clean deny above it) and never reaches the
 * prompter.
 */
let sharedExecutor: ToolExecutor | null = null;

function getSharedExecutor(): ToolExecutor {
  if (!sharedExecutor) {
    sharedExecutor = new ToolExecutor(new PermissionPrompter(() => {}));
  }
  return sharedExecutor;
}

/**
 * Audit observation for this engine's tool calls, so a realtime-voice call
 * leaves the same `tool_invocations` trail a chat turn does.
 *
 * Until this was wired, the voice executor ran with NO lifecycle handler and
 * every call it made — executed, errored, denied — was invisible. On
 * 2026-08-17 that made an empty `tool_invocations` read as "voice called zero
 * tools" when voice had in fact called the calendar tool and been denied. An
 * empty table was consistent with both stories, which is worse than no table.
 *
 * AUDIT ONLY, deliberately: the listener is constructed with
 * `includeTelemetryColumns: false`, so voice rows carry NULL payload-size and
 * inference-attribution columns and stay out of the off-device
 * `tool_executed` projection. There is no truthful attribution to report here
 * — the driver is the Gemini Live realtime model, which the `llm.callSites`
 * attribution system does not describe — and expanding the reported telemetry
 * population is a separate, deliberate decision from making the local audit
 * log honest. Nothing about permissions or risk classification changes; this
 * handler only observes.
 */
let auditToolLifecycleEvent: ToolLifecycleEventHandler | null = null;

function getAuditListener(): ToolLifecycleEventHandler {
  if (!auditToolLifecycleEvent) {
    auditToolLifecycleEvent = createToolAuditListener(undefined, {
      includeTelemetryColumns: false,
    });
  }
  return auditToolLifecycleEvent;
}

/**
 * Run a registered tool through the real execution layer: alias resolution,
 * pre-execution gates, Zod input parsing, and the same permission checking
 * (`checker.check` / approval policy) every cascade tool call passes. The
 * guardian owns this session (the live-voice socket authenticates as the
 * instance owner — same trust the cascade grants its voice turns).
 */
async function runRegistryToolDefault(
  name: string,
  input: Record<string, unknown>,
  ctx: GeminiLiveToolExecutionContext,
): Promise<ToolExecutionResult> {
  // `tool_invocations` has an enforced FK to `conversations`, so a tool call
  // made before the thread row exists (the model acting on its opening turn,
  // before the first transcript) would have its audit row silently rejected —
  // the exact invisibility this wiring exists to end. The session creates the
  // same row on first speech; doing it here makes "a voice tool call is always
  // recordable" true by construction. Best-effort by contract (it swallows its
  // own errors) and never gates the call.
  ensureLiveVoiceThread(ctx.conversationId);

  const context: ToolContext = {
    conversationId: ctx.conversationId,
    workingDir: getSandboxWorkingDir(),
    trustClass: "guardian",
    // No approval UI on this slice: prompt-gated calls resolve non-interactively
    // (auto-approve within the user's background threshold, deny above it)
    // instead of hanging on a prompt no surface can answer. H-4 carries the
    // V-3 approval frames into this engine.
    isInteractive: false,
    executionChannel: "live-voice",
    callSessionId: ctx.conversationId,
    signal: ctx.signal,
    allowedToolNames: GEMINI_LIVE_REGISTRY_TOOL_ALLOWLIST,
    // Every gate outcome — executed, errored, and (the one that was invisible)
    // permission-denied — lands as a `tool_invocations` row. See
    // {@link getAuditListener}.
    onToolLifecycleEvent: getAuditListener(),
  };
  return getSharedExecutor().execute(name, input, context);
}

/**
 * Cap what a tool result feeds back into the realtime session. Registry tools
 * can return pages of text (search results, inbox listings); the voice model
 * only needs enough to speak a summary, and an unbounded response bloats the
 * session context on every remaining turn.
 */
const RESULT_CLIP_CHARS = 3500;

function clip(text: string): string {
  if (text.length <= RESULT_CLIP_CHARS) return text;
  return `${text.slice(0, RESULT_CLIP_CHARS)}… (truncated)`;
}

/**
 * The permission checker's non-interactive denial, verbatim enough to
 * recognise: a live-voice session declares `isInteractive: false`, so any tool
 * whose risk sits above the user's background auto-approve threshold is denied
 * outright rather than prompting a surface that cannot answer.
 *
 * This is not a hypothetical. On 2026-08-17 the model asked for the user's
 * calendar, the checker denied
 * `mcp__composio_googlecalendar__GOOGLECALENDAR_EVENTS_LIST` for exactly this
 * reason, and the raw denial went to the model as free text — which it read
 * out as "I can't reach your Google Calendar, you can fix that in Settings
 * under Connectors". The calendar was connected and working; the sentence sent
 * the user to fix something that was not broken.
 */
const PERMISSION_DENIED_PATTERN =
  /Permission denied: tool .* requires user approval|no interactive client is connected/i;

/**
 * What the model should say instead. Phrased as an instruction because that is
 * how this bridge talks to the model everywhere else, and because the failure
 * mode being closed is the model INVENTING a cause for an error it does not
 * understand.
 */
const NEEDS_APPROVAL_ERROR =
  "This action needs the user's approval, and an approval prompt cannot be shown during a voice call, " +
  "so it did NOT run and you have no result. Tell them briefly that this one needs their okay in the app. " +
  "Do NOT say anything is disconnected, unavailable or empty — you do not know that — and do not guess the answer.";

/** Map a ToolExecutionResult onto the `{ ok, … }` shape the model reads. */
function fromToolResult(result: ToolExecutionResult): Record<string, unknown> {
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  if (result.isError) {
    if (PERMISSION_DENIED_PATTERN.test(content)) {
      return { ok: false, error: NEEDS_APPROVAL_ERROR };
    }
    return { ok: false, error: clip(content) };
  }
  return { ok: true, result: clip(content) };
}

async function dispatchRegistryTool(
  name: string,
  input: Record<string, unknown>,
  ctx: GeminiLiveToolExecutionContext,
  /**
   * Heading for the card this result may become. Passing one does NOT force a
   * card: the result's own shape decides (see {@link withResultCard}), so a
   * tool that answers in prose — `web_search` returns formatted text — shows
   * nothing and reads exactly as it did before.
   */
  cardTitle?: string,
): Promise<Record<string, unknown>> {
  const run = ctx.runRegistryTool ?? runRegistryToolDefault;
  const result = await run(name, input, ctx);
  const response = fromToolResult(result);
  if (cardTitle === undefined) return response;
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  return withResultCard(response, parseJsonPayload(content), cardTitle, ctx);
}

// ── get_calendar (Google Calendar via Composio MCP) ──────────────────

const MAX_CALENDAR_EVENTS = 15;

/**
 * Spoken-safe degradation the model reads when the Composio calendar tool is
 * absent (local instance, no connection) or the connection is dead. The
 * reported failure mode this guards: the model improvising a calendar answer
 * "from my comms"/the briefing when it had no calendar at all.
 */
const CALENDAR_NOT_CONNECTED_ERROR =
  "Google Calendar isn't connected, so you cannot see the user's calendar right now. " +
  "Tell them plainly that their calendar isn't linked yet and that they can connect " +
  "Google Calendar in Settings → Connectors. Do not guess or invent events from anything else.";

/**
 * Error shapes that mean "the calendar connection is absent or dead" rather
 * than a transient tool failure. Includes the executor's unknown-tool text
 * (the MCP server can drop mid-call, after the registry probe) and the MCP
 * client's own not-connected errors. Deliberately does NOT match permission
 * denials — those must surface as "needs your okay", not "not connected".
 */
const CALENDAR_CONNECTION_ERROR_PATTERN =
  /not connected|no connected account|connected account (was )?not found|connection (is )?(expired|inactive|not found|disabled)|re-?authenticat|re-?connect|unauthori[sz]ed|invalid[_ ]grant|authentication|\b401\b|\b403\b|MCP server .{0,80} not found|Unknown tool/i;

function defaultIsToolRegistered(name: string): boolean {
  return getTool(name) !== undefined;
}

/** The compact per-event shape a voice model can narrate and `ui_show` can tile. */
interface ShapedCalendarEvent {
  title: string;
  start?: string;
  end?: string;
  location?: string;
  /** Attendee COUNT — never the raw attendee objects (emails stay off-wire). */
  attendees?: number;
}

/** Google/Composio event times come as `{dateTime}|{date}` or plain strings. */
function eventTime(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.dateTime === "string") return record.dateTime;
    if (typeof record.date === "string") return record.date;
  }
  return undefined;
}

function shapeCalendarEvent(raw: unknown): ShapedCalendarEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "cancelled") return null;
  const title =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary
      : typeof record.title === "string" && record.title.trim()
        ? record.title
        : "(no title)";
  const start = eventTime(record.start) ?? eventTime(record.start_time);
  const end = eventTime(record.end) ?? eventTime(record.end_time);
  const location =
    typeof record.location === "string" && record.location.trim()
      ? record.location.slice(0, 120)
      : undefined;
  const attendees = Array.isArray(record.attendees)
    ? record.attendees.length
    : undefined;
  return {
    title: title.slice(0, 160),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(attendees !== undefined && attendees > 0 ? { attendees } : {}),
  };
}

/**
 * Find the events array inside Composio's verbose envelope without pinning its
 * exact nesting: Google's events.list puts events under `items`, and Composio
 * wraps the whole response under `data` (shallow search covers both plus one
 * level of drift).
 */
function findEventArray(node: unknown, depth = 0): unknown[] | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  if (depth > 3) return null;
  const record = node as Record<string, unknown>;
  for (const key of ["items", "events"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  for (const value of Object.values(record)) {
    const found = findEventArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Parse a successful (per MCP `isError`) calendar result. Composio can still
 * report failure INSIDE the envelope (`successful: false` / `error`), so that
 * is surfaced as an error rather than "no events". `null` → unrecognized shape
 * (the caller falls back to the generic clipped result — never hide real data
 * behind a shape mismatch).
 */
function parseCalendarContent(
  content: string,
):
  | { kind: "events"; events: ShapedCalendarEvent[] }
  | { kind: "error"; message: string }
  | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const envelopeError =
      typeof record.error === "string" && record.error.trim()
        ? record.error
        : null;
    if (record.successful === false || envelopeError) {
      return {
        kind: "error",
        message: envelopeError ?? "calendar request failed",
      };
    }
  }
  const raw = Array.isArray(parsed) ? parsed : findEventArray(parsed);
  if (!raw) return null;
  return {
    kind: "events",
    events: raw
      .map(shapeCalendarEvent)
      .filter((event): event is ShapedCalendarEvent => event !== null),
  };
}

/**
 * "What's on my calendar?" against the user's REAL Google Calendar, through
 * the same executor path (gates + permission checks) as every other bridged
 * tool. Results are reduced to {@link ShapedCalendarEvent} BEFORE the generic
 * clip so the model narrates clean fields and `ui_show` can tile them, instead
 * of chewing through Composio's verbose envelope.
 */
async function executeGetCalendar(
  args: Record<string, unknown>,
  ctx: GeminiLiveToolExecutionContext,
): Promise<Record<string, unknown>> {
  const isRegistered = ctx.isToolRegistered ?? defaultIsToolRegistered;
  if (!isRegistered(GEMINI_LIVE_CALENDAR_EVENTS_TOOL)) {
    return { ok: false, error: CALENDAR_NOT_CONNECTED_ERROR };
  }

  const timeMinArg = String(args.time_min ?? "").trim();
  const timeMaxArg = String(args.time_max ?? "").trim();
  if (timeMinArg && Number.isNaN(Date.parse(timeMinArg))) {
    return { ok: false, error: "time_min must be an ISO 8601 timestamp" };
  }
  if (timeMaxArg && Number.isNaN(Date.parse(timeMaxArg))) {
    return { ok: false, error: "time_max must be an ISO 8601 timestamp" };
  }
  // Defaults: now → +7 days. Valid caller values pass through verbatim so a
  // client-local offset (e.g. +08:00) reaches Google unchanged.
  const timeMin = timeMinArg || new Date().toISOString();
  const timeMax =
    timeMaxArg ||
    new Date(Date.parse(timeMin) + 7 * 24 * 60 * 60 * 1000).toISOString();

  const run = ctx.runRegistryTool ?? runRegistryToolDefault;
  const result = await run(
    GEMINI_LIVE_CALENDAR_EVENTS_TOOL,
    {
      // ASSUMED arg names: the Google-standard events.list params. Composio's
      // live schema exists only in a connected instance's registry, so the
      // exact names could not be confirmed from code — verify on prod before
      // the voice-engine default flip (extra/unrecognized params are the
      // failure mode to watch for).
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: MAX_CALENDAR_EVENTS,
    },
    ctx,
  );

  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  if (result.isError) {
    // Approval is checked FIRST because the denial text talks about a
    // connection too ("no interactive client is connected"): today it slips
    // past the not-connected pattern by one word, and one loosened alternative
    // there would silently turn every denial into "your calendar is broken".
    if (PERMISSION_DENIED_PATTERN.test(content)) {
      return { ok: false, error: NEEDS_APPROVAL_ERROR };
    }
    if (CALENDAR_CONNECTION_ERROR_PATTERN.test(content)) {
      return { ok: false, error: CALENDAR_NOT_CONNECTED_ERROR };
    }
    return { ok: false, error: clip(content) };
  }

  const parsed = parseCalendarContent(content);
  if (parsed === null) {
    // Unrecognized (but successful) shape: fall back to the generic clipped
    // result rather than hiding real data behind our shaping.
    return fromToolResult(result);
  }
  if (parsed.kind === "error") {
    if (CALENDAR_CONNECTION_ERROR_PATTERN.test(parsed.message)) {
      return { ok: false, error: CALENDAR_NOT_CONNECTED_ERROR };
    }
    return { ok: false, error: clip(parsed.message) };
  }
  const events = parsed.events.slice(0, MAX_CALENDAR_EVENTS);
  if (events.length === 0) {
    return {
      ok: true,
      count: 0,
      events: [],
      message: "No calendar events in that range.",
    };
  }
  return withResultCard(
    { ok: true, count: events.length, events },
    events,
    "Calendar",
    ctx,
  );
}

/**
 * The presentation plumbing the client's list renderer requires (a stable id
 * per item) applied to whatever the caller supplied. Shared by `ui_show` and
 * the derived result cards so both engines' cards are the same object.
 */
function normalizeListItems(
  items: readonly unknown[],
): Record<string, unknown>[] {
  return items.map((item, i) => {
    const record: Record<string, unknown> =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { title: String(item) };
    if (typeof record.id !== "string" || record.id.length === 0) {
      record.id = `item-${i + 1}`;
    }
    return record;
  });
}

// ── Result cards (shape-driven, not tool-driven) ─────────────────────

/**
 * A card is a property of the RESULT, not of which tool produced it.
 *
 * Before this, a card only appeared if the model made a SECOND call
 * (`ui_show`) after the data one. On the realtime model that second call is
 * the step that gets skipped: the owner's report was "I did have to prompt it
 * to show cards when I was asking for info" — the calendar came back, the
 * events were spoken, and nothing went on screen. A mandatory prompt rule
 * naming `ui_show` was already there and did not hold, because a prompt rule
 * is the same kind of thing that was already being dropped.
 *
 * So a list of named records — calendar events, inbox conversations, messages,
 * contacts, tasks, follow-ups — goes on screen because of its SHAPE, whatever
 * produced it. Nothing here is keyed to a tool name, so a result that arrives
 * from a different tool later (a raw connector, a new declaration) is carded on
 * exactly the same terms with no new wiring.
 *
 * Deliberately conservative in both directions:
 *
 * - It needs a real collection. A single object (a saved reminder, a "noted"
 *   confirmation) and prose (`web_search` returns formatted text) derive
 *   nothing, so an acknowledgement never becomes a card.
 * - It only reads fields a human would read. A record with no human-legible
 *   title is dropped, which is also why a calendar event's `attendees` — bare
 *   email addresses — cannot become a card: no title key, no item.
 * - It never blocks or fails a tool call. No derivation simply means no card,
 *   and the model can still call `ui_show` itself (the prompt keeps that path
 *   open for exactly this case).
 *
 * `ui_show` is untouched and still the way the model shows something it
 * COMPOSED rather than fetched.
 */

/** Items on one auto-derived card. Enough to scan; a call is not a mailbox. */
const RESULT_CARD_MAX_ITEMS = 12;

/** Per-field clip. Card lines are glanced at, not read. */
const RESULT_CARD_TEXT_CHARS = 140;

/** Fields a human-legible heading can come from, best first. */
const RESULT_CARD_TITLE_KEYS = [
  "title",
  "name",
  "summary",
  "subject",
  "label",
  "headline",
] as const;

/** Fields the supporting line can come from, best first. */
const RESULT_CARD_DETAIL_KEYS = [
  "subtitle",
  "snippet",
  "preview",
  "description",
  "topic",
  "text",
  "body",
  "location",
  "status",
] as const;

function cardText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > RESULT_CARD_TEXT_CHARS
    ? `${trimmed.slice(0, RESULT_CARD_TEXT_CHARS - 1)}…`
    : trimmed;
}

function firstCardText(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const text = cardText(record[key]);
    if (text) return text;
  }
  return undefined;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Render an event time from the LITERAL fields of its ISO string — never via
 * Date, which would re-express the user's 9am meeting in the daemon's timezone
 * (the daemon runs in a datacenter; the user does not). A calendar time already
 * carries the offset it should be read in, so the digits are taken as written.
 */
function cardTimeLabel(start: unknown, end: unknown): string | undefined {
  const from = eventTime(start);
  if (!from) return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  const day = date
    ? `${Number(date[3])} ${MONTHS[Number(date[2]) - 1] ?? ""}`.trim()
    : undefined;
  const clock = /T(\d{2}:\d{2})/.exec(from);
  if (!clock) return day ? `${day}, all day` : undefined;
  const to = eventTime(end);
  const endLabel =
    typeof to === "string" && to.slice(0, 10) === from.slice(0, 10)
      ? /T(\d{2}:\d{2})/.exec(to)?.[1]
      : undefined;
  const time = endLabel ? `${clock[1]}–${endLabel}` : clock[1];
  return day ? `${day}, ${time}` : time;
}

interface ResultCardItem {
  title: string;
  subtitle?: string;
}

/**
 * One record → one card line, or `null` when there is no human-legible heading
 * in it (an id-and-email blob, a settings object, a number).
 */
function shapeResultCardItem(raw: unknown): ResultCardItem | null {
  const plain = cardText(raw);
  if (plain) return { title: plain };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;

  let title = firstCardText(record, RESULT_CARD_TITLE_KEYS);
  if (!title) {
    // Message-shaped: the person is the heading and the message is the line.
    const sender = record.sender;
    if (
      sender !== null &&
      typeof sender === "object" &&
      !Array.isArray(sender)
    ) {
      title = cardText((sender as Record<string, unknown>).name);
    }
  }
  if (!title) return null;

  const parts: string[] = [];
  const when =
    cardTimeLabel(record.start, record.end) ??
    cardTimeLabel(record.start_time, record.end_time) ??
    cardTimeLabel(record.when, undefined) ??
    cardTimeLabel(record.fire_at, undefined);
  if (when) parts.push(when);
  const unread = record.unreadCount;
  if (typeof unread === "number" && unread > 0) {
    parts.push(`${unread} unread`);
  }
  const detail = firstCardText(record, RESULT_CARD_DETAIL_KEYS);
  if (detail && detail !== title) parts.push(detail);

  const subtitle = cardText(parts.join(" · "));
  return { title, ...(subtitle ? { subtitle } : {}) };
}

/**
 * Find the collection worth showing inside an arbitrary result envelope
 * (Composio wraps under `data`, Google under `items`, a skill tool may return
 * the array bare). A candidate only counts when at least one of its entries
 * shapes into a card line, which is what keeps `defaultReminders`, `attendees`
 * and other machinery arrays from winning. Ties go to the longest.
 */
function findResultCardArray(node: unknown, depth = 0): unknown[] | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  if (depth > 3) return null;
  let best: unknown[] | null = null;
  for (const value of Object.values(node as Record<string, unknown>)) {
    const candidate =
      Array.isArray(value) &&
      value.some((entry) => shapeResultCardItem(entry) !== null)
        ? value
        : findResultCardArray(value, depth + 1);
    if (candidate && (best === null || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
}

/** The card lines a result yields, or `null` when it is not something to look at. */
export function deriveResultCardItems(
  payload: unknown,
): ResultCardItem[] | null {
  const array = Array.isArray(payload) ? payload : findResultCardArray(payload);
  if (!array) return null;
  const items = array
    .map(shapeResultCardItem)
    .filter((item): item is ResultCardItem => item !== null)
    .slice(0, RESULT_CARD_MAX_ITEMS);
  return items.length > 0 ? items : null;
}

/** Parse a tool's raw content, or `undefined` when it is not JSON (prose). */
function parseJsonPayload(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * What the model is told when the bridge has already put the result on screen.
 * Phrased as an instruction because that is how this bridge talks to the model
 * everywhere else, and because the two failures to prevent are it reading the
 * card aloud item by item and it showing a second, duplicate one.
 */
const RESULT_CARD_NOTE =
  "Already on the user's screen as a card. Summarize aloud in a sentence or two; do not read the items out, and do not call ui_show for this result.";

/**
 * Show a successful result if its shape is worth looking at, and tell the model
 * it is up. A no-op for an error, for a call with no screen attached, and for a
 * result that derives nothing — in all three the response is returned verbatim.
 */
function withResultCard(
  response: Record<string, unknown>,
  payload: unknown,
  title: string,
  ctx: GeminiLiveToolExecutionContext,
): Record<string, unknown> {
  if (response.ok !== true || !ctx.showCard) return response;
  const items = deriveResultCardItems(payload);
  if (!items) return response;
  ctx.showCard({
    surfaceId: randomUUID(),
    surfaceType: "list",
    title,
    data: { items: normalizeListItems(items), selectionMode: "none" },
  });
  return { ...response, on_screen: RESULT_CARD_NOTE };
}

// ── ui_show (voice tile subset) ──────────────────────────────────────

/**
 * Validate + normalize the voice `ui_show` subset and hand the card to the
 * session. Display-only by construction: no actions, no approval semantics —
 * so it does not route through the executor (there is nothing to permission:
 * the "execution" IS the frame the session was already trusted to send).
 */
function executeUiShow(
  args: Record<string, unknown>,
  ctx: GeminiLiveToolExecutionContext,
): Record<string, unknown> {
  const surfaceType = String(args.surface_type ?? "");
  if (!VOICE_SURFACE_TYPES.has(surfaceType)) {
    return {
      ok: false,
      error: `unsupported surface_type — use one of: ${[...VOICE_SURFACE_TYPES].join(", ")}`,
    };
  }
  const rawData = args.data;
  if (
    rawData === null ||
    typeof rawData !== "object" ||
    Array.isArray(rawData)
  ) {
    return { ok: false, error: "data must be an object" };
  }
  const data = { ...(rawData as Record<string, unknown>) };

  if (surfaceType === "list") {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { ok: false, error: "list data needs a non-empty items array" };
    }
    // The voice model reliably produces titles but not ids or selection
    // modes; default the presentation plumbing so the client's list renderer
    // (which requires both) accepts the card.
    data.items = normalizeListItems(data.items);
    if (typeof data.selectionMode !== "string") {
      data.selectionMode = "none";
    }
  } else if (surfaceType === "table") {
    if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      return { ok: false, error: "table data needs columns and rows arrays" };
    }
    data.rows = data.rows.map((row, i) => {
      const record: Record<string, unknown> =
        row !== null && typeof row === "object" && !Array.isArray(row)
          ? { ...(row as Record<string, unknown>) }
          : { cells: {} };
      if (typeof record.id !== "string" || record.id.length === 0) {
        record.id = `row-${i + 1}`;
      }
      return record;
    });
  } else if (Object.keys(data).length === 0) {
    return { ok: false, error: "card data is empty" };
  }

  if (!ctx.showCard) {
    return { ok: false, error: "no screen is attached to this call" };
  }

  const card: GeminiLiveCard = {
    surfaceId: randomUUID(),
    surfaceType,
    ...(typeof args.title === "string" && args.title.trim().length > 0
      ? { title: args.title }
      : {}),
    data,
  };
  ctx.showCard(card);
  return {
    ok: true,
    message:
      "Shown on screen. Give a one or two sentence spoken summary; do not read the items.",
  };
}

// ── Work-item fast path (add_task / run_deep_task / get_open_tasks) ──

const OPEN_STATUSES = new Set(["queued", "running", "awaiting_review"]);

/**
 * Create a work item and return IMMEDIATELY, running triage + any auto-run in
 * the background. The shared `executeTaskListAdd` path blocks up to 12s waiting
 * for the triage/auto-run decision — fine for typed chat, but in a live voice
 * turn that stall makes the model go silent and the realtime session time the
 * turn out ("add a task stopped working"). Voice tool calls must be instant.
 */
function createWorkItemFast(opts: {
  title: string;
  executionPrompt?: string;
  conversationId: string;
  /**
   * When true, triage may auto-run the item in the background (for `run_deep_task`
   * — real work whose result lands in Review). When false (a plain `add_task`
   * to-do like "go to the gym"), the item just sits in the queue as a reminder;
   * auto-running a to-do produces nonsense output and hides it in Review.
   */
  autoRun: boolean;
}): string {
  const template = opts.executionPrompt ?? opts.title;
  const task = createTask({
    title: opts.title,
    template,
    createdFromConversationId: opts.conversationId,
  });
  const workItem = createWorkItemWithPermissions({
    taskId: task.id,
    title: opts.title,
    priorityTier: 1,
    // The voice thread that asked for this. The run gets its OWN conversation,
    // so without this link the thread would have no idea what it spawned — the
    // failure that had the thread agent re-doing finished research inline.
    originConversationId: opts.conversationId,
    // A plain to-do is a reminder the user parked, not ready work — mark it
    // so no later auto-run pass (queue drainer, re-triage) can start it.
    ...(opts.autoRun ? {} : { autoRunEligibility: "parked" as const }),
  });
  if (opts.autoRun) {
    // Fire-and-forget: triage + policy-gated auto-run in the background.
    void triageAndMaybeAutoRunWorkItem(workItem.id, {
      callerSetPriority: false,
    }).catch((err) =>
      log.warn({ err, id: workItem.id }, "background triage failed"),
    );
  }
  return workItem.id;
}

// ── Dispatch ─────────────────────────────────────────────────────────

/**
 * Execute a function the Gemini Live model called. Returns the plain object that
 * goes back as the `functionResponse`. Never throws — a failure is reported to
 * the model as `{ ok: false, error }` so it can tell the user honestly.
 */
export async function executeGeminiLiveFunctionCall(
  call: GeminiLiveToolCall,
  ctx: GeminiLiveToolExecutionContext,
): Promise<{ id?: string; name: string; response: unknown }> {
  const wrap = (response: unknown) => ({
    id: call.id,
    name: call.name,
    response,
  });

  try {
    switch (call.name) {
      case "add_task": {
        const title = String(call.args.title ?? "").trim();
        if (!title) return wrap({ ok: false, error: "empty title" });
        const id = createWorkItemFast({
          title,
          conversationId: ctx.conversationId,
          autoRun: false,
        });
        log.info({ title, id }, "gemini-live add_task");
        return wrap({
          ok: true,
          message: `Added "${title}" to your task list.`,
        });
      }

      case "run_deep_task": {
        const request = String(call.args.request ?? "").trim();
        if (!request) return wrap({ ok: false, error: "empty request" });
        const title =
          request.length > 80 ? `${request.slice(0, 77)}…` : request;
        const id = createWorkItemFast({
          title,
          executionPrompt: request,
          conversationId: ctx.conversationId,
          autoRun: true,
        });
        // Let the session watch for this item's completion while the call is
        // still open (the announce-back half of the escalation).
        ctx.onDeepTaskStarted?.({ id, title });
        log.info({ id }, "gemini-live run_deep_task");
        return wrap({
          ok: true,
          message:
            "Started working on that in the background; it'll be in the Review lane.",
        });
      }

      case "get_open_tasks": {
        const open = listWorkItems()
          .filter((w) => OPEN_STATUSES.has(w.status))
          .slice(0, 10)
          .map((w) => ({ title: w.title, status: w.status }));
        return wrap(
          withResultCard(
            { ok: true, count: open.length, tasks: open },
            open,
            "Your tasks",
            ctx,
          ),
        );
      }

      case "web_search": {
        const query = String(call.args.query ?? "").trim();
        if (!query) return wrap({ ok: false, error: "empty query" });
        return wrap(
          await dispatchRegistryTool(
            "web_search",
            { query, count: 5 },
            ctx,
            "Search results",
          ),
        );
      }

      case "recall_memory": {
        const query = String(call.args.query ?? "").trim();
        if (!query) return wrap({ ok: false, error: "empty query" });
        // Fast depth: a live turn wants the quick lookup, not a research pass.
        return wrap(
          await dispatchRegistryTool("recall", { query, depth: "fast" }, ctx),
        );
      }

      case "remember": {
        const content = String(call.args.content ?? "").trim();
        if (!content) return wrap({ ok: false, error: "empty content" });
        return wrap(await dispatchRegistryTool("remember", { content }, ctx));
      }

      case "get_schedule": {
        const jobId = String(call.args.job_id ?? "").trim();
        return wrap(
          await dispatchRegistryTool(
            "schedule_list",
            jobId ? { job_id: jobId } : {},
            ctx,
            "Reminders",
          ),
        );
      }

      case "get_calendar":
        return wrap(await executeGetCalendar(call.args, ctx));

      case "set_reminder": {
        const message = String(call.args.message ?? "").trim();
        if (!message) return wrap({ ok: false, error: "empty message" });
        const when = String(call.args.when ?? "").trim();
        const repeat = String(call.args.repeat ?? "").trim();
        if (!when && !repeat) {
          return wrap({
            ok: false,
            error: "need a time: pass `when` (one-time) or `repeat` (cron)",
          });
        }
        const timezone = String(call.args.timezone ?? "").trim();
        const name = message.length > 60 ? `${message.slice(0, 57)}…` : message;
        return wrap(
          await dispatchRegistryTool(
            "schedule_create",
            {
              name,
              description: `Reminder set by voice: ${message}`,
              message,
              // Reminders notify; voice never creates autonomous-execution or
              // script schedules (those stay chat-side where they can be
              // reviewed).
              mode: "notify",
              ...(when ? { fire_at: when } : { expression: repeat }),
              ...(timezone ? { timezone } : {}),
            },
            ctx,
          ),
        );
      }

      case "find_contact": {
        const name = String(call.args.name ?? "").trim();
        const address = String(call.args.address ?? "").trim();
        if (!name && !address) {
          return wrap({ ok: false, error: "pass a name or an address" });
        }
        return wrap(
          await dispatchRegistryTool(
            "contact_search",
            {
              ...(name ? { query: name } : {}),
              ...(address ? { channel_address: address } : {}),
              limit: 5,
            },
            ctx,
            "Contacts",
          ),
        );
      }

      case "get_followups": {
        const overdueOnly = call.args.overdue_only === true;
        return wrap(
          await dispatchRegistryTool(
            "followup_list",
            overdueOnly ? { overdue_only: true } : {},
            ctx,
            "Waiting on replies",
          ),
        );
      }

      case "check_inbox": {
        const limit =
          typeof call.args.limit === "number" &&
          Number.isFinite(call.args.limit)
            ? Math.min(25, Math.max(1, Math.round(call.args.limit)))
            : 10;
        return wrap(
          await dispatchRegistryTool(
            "messaging_list_conversations",
            { limit },
            ctx,
            "Inbox",
          ),
        );
      }

      case "read_messages": {
        const conversationId = String(call.args.conversation_id ?? "").trim();
        if (!conversationId) {
          return wrap({ ok: false, error: "conversation_id is required" });
        }
        const limit =
          typeof call.args.limit === "number" &&
          Number.isFinite(call.args.limit)
            ? Math.min(50, Math.max(1, Math.round(call.args.limit)))
            : 10;
        return wrap(
          await dispatchRegistryTool(
            "messaging_read",
            { conversation_id: conversationId, limit },
            ctx,
            "Messages",
          ),
        );
      }

      case "ui_show":
        return wrap(executeUiShow(call.args, ctx));

      default:
        // Spoken-safe: the model reads this and should tell the user plainly.
        return wrap({
          ok: false,
          error: `that capability isn't available in this call (unknown function ${call.name})`,
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, name: call.name }, "gemini-live function call failed");
    return wrap({ ok: false, error: message });
  }
}
