/**
 * Morning Brief — the data source for the mobile Morning Brief surface
 * (mobile-v3 frame 5): the 7:30 notification deep-links into a three-beat
 * story the client renders from this single endpoint.
 *
 *   1. `overnight` — work items COMPLETED since the window start: state
 *      "review" (◱ awaiting your review) vs "done" (✓ finished quietly),
 *      with project + agent attribution. Plus, when an inbox-management run
 *      recorded a summary inside the window, one `kind: "inbox_cleanup"` row
 *      carrying its archived/drafted/kept-important counts.
 *   2. `ask` — the single highest-priority item that needs the user: a
 *      pending approval first (it blocks work), else the top awaiting-review
 *      item. Null when nothing needs them ("calm day ahead").
 *   3. `day` — today's calendar events (when Google Calendar is reachable)
 *      merged with due-today work items, time-ordered.
 *
 * This is a re-slice of existing data, not new collection: it reads the same
 * stores the next-move / work-items / home-feed routes read
 * (`listWorkItems`, `listWorkItemEvents`, `getByKind` pending interactions,
 * `getProject`, `getAgentByAssignee`) and reuses the action board's
 * `fetchTodaysEvents` + `resolveOAuthConnection` for calendar data.
 *
 * "Since when": v1 uses a sliding lookback window (default 24h, override via
 * `?sinceHours=`). There is no durable last-seen store to anchor "the user's
 * last active period" (the request log is pino-only), so the window is the
 * honest v1 approximation — the 7:30 notification cadence makes 24h line up
 * with "since yesterday morning" in practice.
 */

import { z } from "zod";

import {
  type EventSummary,
  fetchTodaysEvents,
} from "../../calendar/todays-events.js";
import { readLatestInboxRunSummary } from "../../home/inbox-run-summary.js";
import { buildNotesBeat, type NotesBeat } from "../../notes/note-ritual.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import { getAgentByAssignee } from "../../work-items/agent-store.js";
import { getProject } from "../../work-items/project-store.js";
import { listWorkItemEvents } from "../../work-items/work-item-events.js";
import {
  listWorkItems,
  type WorkItem,
} from "../../work-items/work-item-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getByKind } from "../pending-interactions.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("morning-brief");

// ---------------------------------------------------------------------------
// Wire contract (consumed by the mobile client — keep in lockstep)
// ---------------------------------------------------------------------------

/** ◱ awaiting the user's review vs ✓ finished quietly. */
export type OvernightState = "review" | "done";

/** Counts from the latest inbox-management run (kind "inbox_cleanup" rows). */
export interface InboxCleanupCounts {
  archived: number;
  drafted: number;
  keptImportant: number;
}

export interface OvernightItem {
  id: string;
  title: string;
  /** Parent project title, when the item belongs to one. */
  project?: string;
  /** Named agent attribution (registry name, falling back to the raw assignee). */
  agent?: string;
  state: OvernightState;
  kind: "work_item" | "inbox_cleanup";
  /** Present only on kind "inbox_cleanup" rows. */
  counts?: InboxCleanupCounts;
  /** ISO time the item reached its current terminal/review status. */
  completedAt: string;
}

export interface BriefAskAction {
  id: string;
  label: string;
  kind: "approve" | "decline" | "open_thread";
  endpoint: string;
  method: string;
}

export interface BriefAsk {
  id: string;
  kind: "approval" | "review";
  title: string;
  project?: string;
  agent?: string;
  actions: BriefAskAction[];
  conversationId?: string;
}

export interface DayEntry {
  /** ISO start time (calendar) or due time (work item). Absent for all-day events. */
  time?: string;
  title: string;
  kind: "event" | "work_item";
}

export interface MorningBrief {
  generatedAt: string;
  /** ISO start of the lookback window `overnight` covers. */
  since: string;
  overnight: OvernightItem[];
  ask: BriefAsk | null;
  day: DayEntry[];
  /** False when no calendar connection was reachable — `day` is then work items only. */
  calendarAvailable: boolean;
  /**
   * What Cue found in the owner's notes that they have not looked at yet, or
   * `null` when there is nothing waiting.
   *
   * This beat is the fix for the flaw acceptance introduces: requiring the
   * owner to accept every extraction means unreviewed ones pile up, and
   * "Waiting on you · 3" only helps someone who goes to Notes. The brief is a
   * surface that comes to *them*, which is what makes the acceptance rule
   * workable instead of a way for findings to rot quietly.
   *
   * `null` rather than a zero-state: a section that says "0 things from your
   * notes" every morning teaches people to skip it.
   */
  notes: NotesBeat | null;
}

// ---------------------------------------------------------------------------
// Beat 1 — overnight wins
// ---------------------------------------------------------------------------

const OVERNIGHT_STATUSES = new Set(["done", "awaiting_review"]);
const MAX_OVERNIGHT_ITEMS = 12;
/** Titles shorter than this (trimmed) carry no story — skip them. */
const MIN_TITLE_CHARS = 4;

/** Normalized title key for duplicate collapsing ("Call the dentist" twice). */
function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True for titles too degenerate to narrate ("Run it", "ok", empty). The
 * brief is a story surface — a row whose title says nothing erodes trust in
 * everything around it.
 */
function isDegenerateTitle(title: string): boolean {
  return title.trim().length < MIN_TITLE_CHARS;
}

/** Resolve the display attribution for a work-item assignee. */
function agentLabel(assignee: string | null): string | undefined {
  const name = assignee?.trim();
  if (!name || name.toLowerCase() === "you") return undefined;
  try {
    const agent = getAgentByAssignee(name);
    if (agent) return agent.name;
  } catch (err) {
    log.warn({ err: String(err) }, "morning-brief: agent lookup failed");
  }
  // The implicit house agent "cue" is deliberately not a registry row.
  return name.toLowerCase() === "cue" ? undefined : name;
}

function projectLabel(projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  try {
    return getProject(projectId)?.title;
  } catch {
    return undefined;
  }
}

/**
 * Epoch ms the item reached its CURRENT status, from the audit trail (the
 * most recent event whose `toStatus` matches). Falls back to `updatedAt`
 * when the trail is missing — event writes are best-effort by design.
 */
function statusReachedAtMs(item: WorkItem): number {
  try {
    const events = listWorkItemEvents(item.id);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].toStatus === item.status) return events[i].at;
    }
  } catch (err) {
    log.warn(
      { err: String(err), workItemId: item.id },
      "morning-brief: event lookup failed",
    );
  }
  return item.updatedAt;
}

export function gatherOvernight(sinceMs: number): OvernightItem[] {
  let items: WorkItem[] = [];
  try {
    items = listWorkItems();
  } catch (err) {
    log.warn({ err: String(err) }, "morning-brief: work-item read failed");
    return [];
  }

  const out: Array<OvernightItem & { atMs: number }> = [];
  const seenTitles = new Set<string>();
  for (const item of items) {
    if (!OVERNIGHT_STATUSES.has(item.status)) continue;
    // Cheap pre-filter: updatedAt is bumped on every status change, so an
    // item whose last update predates the window can't have completed in it.
    if (item.updatedAt < sinceMs) continue;
    // Content trust (UAT 2026-07-21): degenerate titles read as garbage in
    // the narration; duplicate captures ("Call the dentist" twice) read as a
    // glitch. Skip the former, collapse the latter by normalized title.
    // (listWorkItems returns unique rows, so id-dedupe is implicit; the
    // title-dedupe below covers double-captured items.)
    if (isDegenerateTitle(item.title)) continue;
    const key = titleKey(item.title);
    if (seenTitles.has(key)) continue;
    const atMs = statusReachedAtMs(item);
    if (atMs < sinceMs) continue;
    seenTitles.add(key);

    out.push({
      id: item.id,
      title: item.title,
      ...(projectLabel(item.projectId)
        ? { project: projectLabel(item.projectId) }
        : {}),
      ...(agentLabel(item.assignee)
        ? { agent: agentLabel(item.assignee) }
        : {}),
      state: item.status === "awaiting_review" ? "review" : "done",
      kind: "work_item",
      completedAt: new Date(atMs).toISOString(),
      atMs,
    });
  }

  // The latest inbox-management run inside the window is an overnight win
  // too — one typed row carrying its counts (store reads never throw).
  const inboxRun = readLatestInboxRunSummary(sinceMs);
  if (inboxRun) {
    const atMs = Date.parse(inboxRun.ranAt);
    out.push({
      id: `inbox-run-${inboxRun.ranAt}`,
      title:
        `Inbox cleanup — ${inboxRun.archived} archived, ` +
        `${inboxRun.drafted} drafted, ${inboxRun.keptImportant} kept as important`,
      state: "done",
      kind: "inbox_cleanup",
      counts: {
        archived: inboxRun.archived,
        drafted: inboxRun.drafted,
        keptImportant: inboxRun.keptImportant,
      },
      completedAt: new Date(atMs).toISOString(),
      atMs,
    });
  }

  // Review items first (they lead the story), then most recent first.
  out.sort(
    (a, b) =>
      (a.state === "review" ? 0 : 1) - (b.state === "review" ? 0 : 1) ||
      b.atMs - a.atMs,
  );
  return out
    .slice(0, MAX_OVERNIGHT_ITEMS)
    .map(({ atMs: _atMs, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Beat 2 — the one ask
// ---------------------------------------------------------------------------

interface PendingInteractionRow {
  requestId: string;
  conversationId: string;
  confirmationDetails?: { toolName?: string };
}

/**
 * The single highest-priority item needing the user. Mirrors the next-move
 * tiering (approval < awaiting_review): a pending approval blocks running
 * work, so it always wins; otherwise the top awaiting-review item in the
 * store's ranked order (overdue first, then priority tier).
 */
export function pickAsk(): BriefAsk | null {
  for (const kind of ["confirmation", "acp_confirmation"] as const) {
    let rows: PendingInteractionRow[] = [];
    try {
      rows = getByKind(kind) as unknown as PendingInteractionRow[];
    } catch (err) {
      log.warn(
        { err: String(err), kind },
        "morning-brief: pending-interaction read failed",
      );
      continue;
    }
    const row = rows[0];
    if (!row) continue;
    const tool = row.confirmationDetails?.toolName;
    return {
      id: row.requestId,
      kind: "approval",
      title: tool ? `Approve: ${tool}` : "Approval requested",
      actions: [
        {
          id: "approve",
          label: "Approve",
          kind: "approve",
          endpoint: "/v1/confirm",
          method: "POST",
        },
        {
          id: "decline",
          label: "Decline",
          kind: "decline",
          endpoint: "/v1/confirm",
          method: "POST",
        },
      ],
      conversationId: row.conversationId,
    };
  }

  let reviews: WorkItem[] = [];
  try {
    // listWorkItems already ranks overdue-first, then priority tier.
    reviews = listWorkItems({ status: "awaiting_review" });
  } catch (err) {
    log.warn({ err: String(err) }, "morning-brief: review read failed");
    return null;
  }
  // Prefer the top-ranked review with a narratable title — a degenerate
  // headline ("Run it") erodes the whole brief. Fall back to the raw top so
  // a real ask is never hidden outright.
  const top = reviews.find((r) => !isDegenerateTitle(r.title)) ?? reviews[0];
  if (!top) return null;
  return {
    id: top.id,
    kind: "review",
    title: top.title,
    ...(projectLabel(top.projectId)
      ? { project: projectLabel(top.projectId) }
      : {}),
    ...(agentLabel(top.assignee) ? { agent: agentLabel(top.assignee) } : {}),
    actions: [
      {
        id: "open_review",
        label: "Review",
        kind: "open_thread",
        endpoint: `/v1/work-items/${top.id}/output`,
        method: "GET",
      },
    ],
    ...(top.lastRunConversationId
      ? { conversationId: top.lastRunConversationId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Beat 3 — your day
// ---------------------------------------------------------------------------

const CALENDAR_TIMEOUT_MS = 3_500;
/**
 * How long the request path is willing to wait on the live Google Calendar
 * call. The calendar round-trip measured ~1.3 s in prod, which made
 * `/brief/morning` the slowest read in the app — the brief must render on
 * app open, so past this budget the response falls back to the last-known
 * events (or `calendarAvailable: false`) while the live fetch keeps running
 * in the background to refresh the cache for the next request.
 */
const CALENDAR_BUDGET_MS = 400;
/** Last-known events are served for at most this long. */
const CALENDAR_CACHE_TTL_MS = 15 * 60_000;
const MAX_DAY_ENTRIES = 12;
const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_review"]);

let calendarCache: { events: EventSummary[]; fetchedAt: number } | null = null;

/** @internal Test-only reset of the calendar last-known cache. */
export function resetCalendarCacheForTests(): void {
  calendarCache = null;
}

/**
 * The live calendar fetch (connection resolution + events), bounded by the
 * hard abort timeout. Refreshes the last-known cache on success. Null when
 * no calendar is reachable.
 */
async function fetchCalendarEventsLive(
  now: Date,
): Promise<EventSummary[] | null> {
  try {
    const conn = await resolveOAuthConnection("google");
    const events = await fetchTodaysEvents(
      conn,
      now,
      AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    );
    if (events) {
      calendarCache = { events, fetchedAt: Date.now() };
    }
    return events;
  } catch (err) {
    log.info(
      { err: String(err) },
      "morning-brief: calendar unavailable; day is work items only",
    );
    return null;
  }
}

/**
 * Today's calendar events with a tight request-path budget. Null (vs empty)
 * when no calendar answer is available in time, so the response can say so
 * honestly (`calendarAvailable: false`). When the live call overruns the
 * budget it continues in the background and lands in `calendarCache`, so
 * the next brief request gets fresh-enough events instantly.
 */
async function gatherCalendarEvents(now: Date): Promise<EventSummary[] | null> {
  const live = fetchCalendarEventsLive(now);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"budget">((resolve) => {
    budgetTimer = setTimeout(() => resolve("budget"), CALENDAR_BUDGET_MS);
  });

  const result = await Promise.race([live, budget]);
  clearTimeout(budgetTimer);
  if (result !== "budget") return result;

  // Over budget: `live` keeps running (it never rejects) and refreshes the
  // cache when it settles. Serve last-known events when fresh enough.
  const cached = calendarCache;
  if (cached && Date.now() - cached.fetchedAt <= CALENDAR_CACHE_TTL_MS) {
    log.info("morning-brief: calendar over budget; serving last-known events");
    return cached.events;
  }
  log.info("morning-brief: calendar over budget; day is work items only");
  return null;
}

/** Due-today work items, in the daemon's local timezone (v1 caveat). */
export function gatherDueToday(now: Date): DayEntry[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  let items: WorkItem[] = [];
  try {
    items = listWorkItems();
  } catch (err) {
    log.warn({ err: String(err) }, "morning-brief: due-today read failed");
    return [];
  }
  return items
    .filter(
      (i) =>
        ACTIVE_STATUSES.has(i.status) &&
        i.dueAt != null &&
        i.dueAt >= start.getTime() &&
        i.dueAt <= end.getTime(),
    )
    .map((i) => ({
      time: new Date(i.dueAt as number).toISOString(),
      title: i.title,
      kind: "work_item" as const,
    }));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const DEFAULT_SINCE_HOURS = 24;
const MAX_SINCE_HOURS = 72;

export function parseSinceHours(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SINCE_HOURS;
  return Math.min(parsed, MAX_SINCE_HOURS);
}

export async function buildMorningBrief(opts?: {
  now?: Date;
  sinceHours?: number;
}): Promise<MorningBrief> {
  const now = opts?.now ?? new Date();
  const sinceMs =
    now.getTime() - (opts?.sinceHours ?? DEFAULT_SINCE_HOURS) * 60 * 60 * 1000;

  // Kick the calendar fetch first so the (synchronous) store reads below
  // overlap with its network time instead of queueing behind it.
  const eventsPromise = gatherCalendarEvents(now);
  const ask = pickAsk();
  // Status reconciliation (UAT 2026-07-21): the one ask IS the next move —
  // narrating the same item under "while you slept" too tells the user it's
  // both finished and pending. The ask wins; the overnight list drops it.
  const overnight = gatherOvernight(sinceMs).filter(
    (item) => !(ask?.kind === "review" && item.id === ask.id),
  );
  const dueToday = gatherDueToday(now);
  const events = await eventsPromise;

  const day: DayEntry[] = [
    ...(events ?? []).map((e) => ({
      ...(e.start ? { time: e.start } : {}),
      title: e.summary,
      kind: "event" as const,
    })),
    ...dueToday,
  ]
    // Timed entries in chronological order; untimed (all-day) entries first.
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))
    // Duplicate captures (same title at the same slot) collapse to one row.
    .filter(
      ((seen) => (d: DayEntry) => {
        const key = `${titleKey(d.title)}|${d.time ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })(new Set<string>()),
    )
    .slice(0, MAX_DAY_ENTRIES);

  return {
    generatedAt: now.toISOString(),
    since: new Date(sinceMs).toISOString(),
    overnight,
    ask,
    day,
    calendarAvailable: events != null,
    // Reads only. Everything it surfaces is still a proposal — the brief
    // hands the owner a reason to look, never a decision already taken.
    notes: buildNotesBeat(now.getTime()),
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const overnightItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string().optional(),
  agent: z.string().optional(),
  state: z.enum(["review", "done"]),
  kind: z.enum(["work_item", "inbox_cleanup"]),
  counts: z
    .object({
      archived: z.number(),
      drafted: z.number(),
      keptImportant: z.number(),
    })
    .optional(),
  completedAt: z.string(),
});

const askActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["approve", "decline", "open_thread"]),
  endpoint: z.string(),
  method: z.string(),
});

const askSchema = z.object({
  id: z.string(),
  kind: z.enum(["approval", "review"]),
  title: z.string(),
  project: z.string().optional(),
  agent: z.string().optional(),
  actions: z.array(askActionSchema),
  conversationId: z.string().optional(),
});

const dayEntrySchema = z.object({
  time: z.string().optional(),
  title: z.string(),
  kind: z.enum(["event", "work_item"]),
});

const notesBeatSchema = z.object({
  noteCount: z.number().int(),
  found: z.number().int(),
  dueSoon: z
    .number()
    .int()
    .describe(
      "How many are due within a day. The reason to look now rather than eventually — lead the sentence with it, never with the tally.",
    ),
  sentence: z
    .string()
    .describe("Already written in the owner's terms. Render it as-is."),
  items: z.array(z.record(z.string(), z.unknown())),
});

const morningBriefResponseSchema = z.object({
  generatedAt: z.string(),
  since: z.string(),
  overnight: z.array(overnightItemSchema),
  ask: askSchema.nullable(),
  day: z.array(dayEntrySchema),
  calendarAvailable: z.boolean(),
  notes: notesBeatSchema
    .nullable()
    .describe(
      "What Cue found in your notes that you haven't looked at, or null when nothing is waiting. This is what makes 'nothing files without you' workable: the brief comes to you, so unreviewed proposals cannot rot unseen in a surface you have to remember to visit.",
    ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getMorningBrief",
    endpoint: "brief/morning",
    method: "GET",
    // Mirror `get_next_move` / `listWorkItems`: read scope, actor principals.
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the three-beat morning brief",
    description:
      "The Morning Brief surface's single data source: work items completed " +
      "since the lookback window (overnight wins, review vs done), the one " +
      "highest-priority item needing the user (pending approval or top " +
      "awaiting-review item), and today's schedule (calendar events when " +
      "reachable, merged with due-today work items). Read-only re-slice of " +
      "the work-item / approval / calendar stores.",
    tags: ["activity"],
    queryParams: [
      {
        name: "sinceHours",
        type: "number",
        required: false,
        description:
          "Lookback window for the overnight beat, in hours (default 24, max 72).",
      },
    ],
    responseBody: morningBriefResponseSchema,
    handler: ({ queryParams }) =>
      buildMorningBrief({
        sinceHours: parseSinceHours(queryParams?.sinceHours),
      }),
  },
];
