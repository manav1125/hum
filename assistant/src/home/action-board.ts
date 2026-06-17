/**
 * Daily Action Board.
 *
 * The proactive layer of Cue: gathers the user's connected data (Gmail unread
 * + today's Calendar) through the connector OAuth layer (Composio-backed in
 * this fork), asks the model to synthesize a small, prioritized set of action
 * items, and writes them to the Home feed as actionable cards.
 *
 * Each card carries a pre-seeded `action` prompt (e.g. "Draft a reply to …"),
 * so a single click hands the work to the agent — the "one-click routine"
 * surface. The data fetch and feed write are deterministic code paths; the
 * model is used only for triage/synthesis, so a model hiccup degrades to
 * "fewer/no items" rather than corrupting the feed.
 *
 * Idempotent per day: feed item ids are derived from the local date, so a
 * re-run (manual trigger + the scheduled run, or two scheduled runs) replaces
 * the day's cards in place instead of duplicating them.
 */

import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { OAuthConnection } from "../oauth/connection.js";
import { resolveOAuthConnection } from "../oauth/connection-resolver.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import type { ToolDefinition } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import type { FeedAction, FeedItem, FeedItemUrgency } from "./feed-types.js";
import { appendFeedItem, readHomeFeed } from "./feed-writer.js";
import { recordImpact, TIME_SAVED_MINUTES } from "./impact-store.js";

const log = getLogger("action-board");

const GMAIL_BASE = "https://gmail.googleapis.com";
const CALENDAR_BASE = "https://www.googleapis.com";

/** How many unread emails / events to feed the synthesis model. */
const MAX_EMAILS = 15;
const MAX_EVENTS = 12;
/** Hard cap on cards written, regardless of what the model returns. */
const MAX_ITEMS = 8;

export interface ActionBoardResult {
  written: number;
  skipped?: string;
  emailsScanned: number;
  eventsScanned: number;
}

interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

interface EventSummary {
  summary: string;
  start: string;
  end: string;
  attendees: number;
  location: string;
}

interface SynthItem {
  title: string;
  summary: string;
  urgency: FeedItemUrgency;
  category: "email" | "scheduling" | "background" | "system";
  actionLabel?: string;
  actionPrompt?: string;
  /** Gmail message id this item is about, when it's an email — lets the card
   *  deep-link to the thread and drives auto-draft for that exact message. */
  sourceMessageId?: string;
}

// ---------------------------------------------------------------------------
// Data gathering (via the connector OAuth layer)
// ---------------------------------------------------------------------------

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  const found = headers?.find(
    (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

async function fetchUnreadEmails(
  conn: OAuthConnection,
  signal?: AbortSignal,
): Promise<EmailSummary[]> {
  const list = await conn.request({
    method: "GET",
    baseUrl: GMAIL_BASE,
    path: "/gmail/v1/users/me/messages",
    query: {
      q: "is:unread in:inbox",
      maxResults: String(MAX_EMAILS),
    },
    signal,
  });
  if (list.status >= 400) {
    log.warn({ status: list.status }, "Gmail list failed");
    return [];
  }
  const ids = (
    (list.body as { messages?: Array<{ id: string }> }).messages ?? []
  ).map((m) => m.id);

  const out: EmailSummary[] = [];
  for (const id of ids) {
    const msg = await conn.request({
      method: "GET",
      baseUrl: GMAIL_BASE,
      path: `/gmail/v1/users/me/messages/${id}`,
      query: {
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      },
      signal,
    });
    if (msg.status >= 400) continue;
    const body = msg.body as {
      snippet?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    };
    const headers = body.payload?.headers;
    out.push({
      id,
      from: headerValue(headers, "From"),
      subject: headerValue(headers, "Subject"),
      snippet: (body.snippet ?? "").slice(0, 280),
      date: headerValue(headers, "Date"),
    });
  }
  return out;
}

async function fetchTodaysEvents(
  conn: OAuthConnection,
  now: Date,
  signal?: AbortSignal,
): Promise<EventSummary[]> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const res = await conn.request({
    method: "GET",
    baseUrl: CALENDAR_BASE,
    path: "/calendar/v3/calendars/primary/events",
    query: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
    },
    signal,
  });
  if (res.status >= 400) {
    log.warn({ status: res.status }, "Calendar list failed");
    return [];
  }
  const items =
    (
      res.body as {
        items?: Array<{
          summary?: string;
          location?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          attendees?: unknown[];
        }>;
      }
    ).items ?? [];
  return items.map((e) => ({
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
    location: e.location ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Deterministic enrichment: calendar conflict detection
// ---------------------------------------------------------------------------

/**
 * Find pairs of timed events whose intervals overlap. All-day events (which
 * carry a `date` but no `dateTime`, so their `start`/`end` don't parse as a
 * timestamp) are ignored — they routinely "overlap" timed meetings without
 * being conflicts. Pure and exported for unit testing.
 */
export function detectConflicts(
  events: EventSummary[],
): Array<[EventSummary, EventSummary]> {
  const timed = events
    // Only events with a full RFC-3339 timestamp (has a "T"). All-day events
    // carry a date-only string like "2026-06-17", which Date.parse() happily
    // turns into midnight UTC — so they'd false-positive against timed
    // meetings if we didn't exclude them by shape first.
    .filter((e) => e.start.includes("T") && e.end.includes("T"))
    .map((e) => ({ e, start: Date.parse(e.start), end: Date.parse(e.end) }))
    .filter((x) => !Number.isNaN(x.start) && !Number.isNaN(x.end));
  const pairs: Array<[EventSummary, EventSummary]> = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      // Half-open overlap: back-to-back (a.end === b.start) is NOT a conflict.
      if (a.start < b.end && b.start < a.end) {
        pairs.push([a.e, b.e]);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Synthesis (model triages raw data into action items)
// ---------------------------------------------------------------------------

const SYNTH_TOOL: ToolDefinition = {
  name: "emit_action_board",
  description:
    "Emit the prioritized list of action items for the user's daily board.",
  input_schema: {
    type: "object" as const,
    properties: {
      headline: {
        type: "string",
        description:
          "One short sentence summarizing the day (e.g. '3 emails need a reply, 2 meetings today').",
      },
      items: {
        type: "array",
        description:
          "Action items, most important first. Only include things that genuinely need the user's attention or action — skip noise, newsletters, and automated notifications.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title." },
            summary: {
              type: "string",
              description: "1-2 sentences of context and why it matters.",
            },
            urgency: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
            },
            category: {
              type: "string",
              enum: ["email", "scheduling", "background", "system"],
            },
            actionLabel: {
              type: "string",
              description:
                "Label for a one-click action button, e.g. 'Draft reply', 'Prep for meeting'. Omit if no useful one-click action.",
            },
            actionPrompt: {
              type: "string",
              description:
                "The exact instruction to hand the agent when the button is clicked, e.g. 'Draft a reply to the email from Jane about the Q3 budget'. Must be self-contained — name the person and subject. Omit if no useful action.",
            },
            sourceMessageId: {
              type: "string",
              description:
                "For email items only: copy the exact [id: …] value of the email this item is about, so the card can link to it. Omit for non-email items.",
            },
          },
          required: ["title", "summary", "urgency", "category"],
        },
      },
    },
    required: ["headline", "items"],
  },
};

const SYNTH_SYSTEM = `You are Cue's daily action-board synthesizer. You receive the user's unread emails and today's calendar events and produce a short, prioritized list of action items for their home dashboard.

Rules:
- Be ruthless about signal. Skip newsletters, marketing, automated notifications, and anything that doesn't need the user. An empty list is correct when nothing needs attention.
- At most ${MAX_ITEMS} items. Order by genuine importance.
- For emails that warrant a reply, set actionLabel "Draft reply" and a self-contained actionPrompt naming the sender and subject so the agent can act with no extra context.
- For meetings that need prep, set actionLabel "Prep" with an actionPrompt describing what to prepare.
- Use urgency honestly: most things are low/medium. Reserve high/critical for deadlines, time-sensitive replies, or conflicts.
- If a "Scheduling conflicts detected" section is present, you MUST surface each conflict as a high-urgency scheduling item so the user can resolve the overlap.`;

/** Render detected conflicts as a context section the model must surface. */
function conflictsSection(events: EventSummary[]): string[] {
  const conflicts = detectConflicts(events);
  if (conflicts.length === 0) return [];
  return [
    "",
    `## ⚠️ Scheduling conflicts detected (${conflicts.length})`,
    ...conflicts.map(([a, b]) => `- "${a.summary}" overlaps "${b.summary}"`),
  ];
}

async function synthesize(
  emails: EmailSummary[],
  events: EventSummary[],
  now: Date,
  signal?: AbortSignal,
): Promise<{ headline: string; items: SynthItem[] } | null> {
  if (emails.length === 0 && events.length === 0) {
    return { headline: "Your inbox and calendar are clear.", items: [] };
  }
  const provider = await getConfiguredProvider("actionBoard");
  if (!provider) {
    log.warn("No provider configured for actionBoard");
    return null;
  }

  const dataBlock = [
    `Current time: ${now.toString()}`,
    "",
    `## Unread emails (${emails.length})`,
    ...emails.map(
      (e, i) =>
        `${i + 1}. [id: ${e.id}] From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}\n   Preview: ${e.snippet}`,
    ),
    "",
    `## Today's calendar (${events.length})`,
    ...events.map(
      (e, i) =>
        `${i + 1}. ${e.summary} — ${e.start} to ${e.end}${e.location ? ` @ ${e.location}` : ""} (${e.attendees} attendees)`,
    ),
    ...conflictsSection(events),
  ].join("\n");

  const response = await provider.sendMessage([userMessage(dataBlock)], {
    tools: [SYNTH_TOOL],
    systemPrompt: SYNTH_SYSTEM,
    signal,
    config: {
      callSite: "actionBoard" as const,
      tool_choice: { type: "tool" as const, name: "emit_action_board" },
    },
  });

  const block = extractToolUse(response);
  if (!block) {
    log.warn("No tool_use block in action-board synthesis");
    return null;
  }
  const input = block.input as {
    headline?: string;
    items?: SynthItem[];
  };
  return {
    headline: input.headline ?? "Here's your day.",
    items: (input.items ?? []).slice(0, MAX_ITEMS),
  };
}

// ---------------------------------------------------------------------------
// Feed write
// ---------------------------------------------------------------------------

/** Stable yyyy-mm-dd in local time, for deterministic per-day ids. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const URGENCY_PRIORITY: Record<FeedItemUrgency, number> = {
  critical: 95,
  high: 85,
  medium: 70,
  low: 55,
};

/**
 * Build the daily action board: gather connected data, synthesize, and write
 * cards to the Home feed. Safe to call on a schedule or on demand.
 */
export async function buildDailyActionBoard(opts?: {
  now?: Date;
  signal?: AbortSignal;
  /** When true, emit a notification (morning push) if the board has urgent
   *  items. Used by the morning tick; left off for lazy/manual builds so we
   *  don't ping the user every time they open Home. */
  notify?: boolean;
  /** When true, record a once-daily email-triage impact event. Set only by the
   *  once-per-day guarded path so manual rebuilds don't inflate hours-saved. */
  recordTriageImpact?: boolean;
}): Promise<ActionBoardResult> {
  const now = opts?.now ?? new Date();
  const signal = opts?.signal;

  let conn: OAuthConnection;
  try {
    conn = await resolveOAuthConnection("google");
  } catch (err) {
    log.info(
      { err: String(err) },
      "Action board skipped: Google not connected",
    );
    return {
      written: 0,
      skipped: "google-not-connected",
      emailsScanned: 0,
      eventsScanned: 0,
    };
  }

  let emails: EmailSummary[] = [];
  let events: EventSummary[] = [];
  try {
    emails = await fetchUnreadEmails(conn, signal);
  } catch (err) {
    log.warn({ err: String(err) }, "Action board: email fetch failed");
  }
  try {
    events = await fetchTodaysEvents(conn, now, signal);
  } catch (err) {
    log.warn({ err: String(err) }, "Action board: calendar fetch failed");
  }

  if (opts?.recordTriageImpact && emails.length > 0) {
    recordImpact({
      type: "emails_triaged",
      category: "email",
      minutesSaved: emails.length * TIME_SAVED_MINUTES.emailTriaged,
      detail: `Triaged ${emails.length} unread email${emails.length === 1 ? "" : "s"}`,
    });
  }

  const synth = await synthesize(emails, events, now, signal);
  if (!synth) {
    return {
      written: 0,
      skipped: "synthesis-failed",
      emailsScanned: emails.length,
      eventsScanned: events.length,
    };
  }

  const dateKey = localDateKey(now);
  const nowIso = now.toISOString();
  // Cards expire at end of the following day so a missed glance still shows.
  const expiresAt = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  // Header card summarizing the day — positive "caught up" framing when the
  // synthesizer found nothing that needs the user.
  const caughtUp = synth.items.length === 0;
  const headerItem: FeedItem = {
    id: `action-board:${dateKey}:summary`,
    type: "notification",
    priority: 100,
    title: caughtUp ? "You're all caught up" : "Your daily action board",
    summary: caughtUp
      ? synth.headline || "Nothing needs your attention right now."
      : synth.headline,
    timestamp: nowIso,
    createdAt: nowIso,
    status: "new",
    category: "system",
    urgency: "low",
    fromAssistant: true,
    expiresAt,
    metadata: {
      kind: "action-board-summary",
      emailsScanned: emails.length,
      eventsScanned: events.length,
      itemCount: synth.items.length,
    },
  };
  await appendFeedItem(headerItem);

  let written = 1;
  for (let i = 0; i < synth.items.length; i++) {
    const it = synth.items[i];
    const actions: FeedAction[] = [];
    if (it.actionLabel && it.actionPrompt) {
      actions.push({
        id: "primary",
        label: it.actionLabel,
        prompt: it.actionPrompt,
      });
    }
    const item: FeedItem = {
      id: `action-board:${dateKey}:${i}`,
      type: "notification",
      // Keep header on top; rank items by urgency below it.
      priority: Math.min(99, URGENCY_PRIORITY[it.urgency] - i),
      title: it.title,
      summary: it.summary,
      timestamp: nowIso,
      createdAt: nowIso,
      status: "new",
      category: it.category,
      urgency: it.urgency,
      fromAssistant: true,
      expiresAt,
      ...(actions.length ? { actions } : {}),
      metadata: {
        kind: "action-board-item",
        ...(it.sourceMessageId
          ? {
              sourceMessageId: it.sourceMessageId,
              gmailMessageId: it.sourceMessageId,
            }
          : {}),
      },
    };
    await appendFeedItem(item);
    written++;
  }

  // Morning push: ping connected channels (macOS notification / Telegram /
  // Slack via the notification decision engine) when the board surfaces
  // something genuinely urgent. Passive + sentinel sourceContextId keep the
  // home-feed side-effect from writing a duplicate card — the action cards
  // above are the surface; this is just the nudge to come look.
  if (opts?.notify) {
    const urgent = synth.items.filter(
      (it) => it.urgency === "high" || it.urgency === "critical",
    );
    if (urgent.length > 0) {
      const top = urgent[0];
      const more = urgent.length - 1;
      await emitNotificationSignal({
        sourceEventName: "schedule.notify",
        sourceChannel: "scheduler",
        sourceContextId: `action-board:${dateKey}`,
        attentionHints: {
          requiresAction: true,
          urgency: urgent.some((it) => it.urgency === "critical")
            ? "critical"
            : "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        contextPayload: {
          title: "Your morning brief",
          body:
            `${top.title}` +
            (more > 0
              ? ` (and ${more} more item${more === 1 ? "" : "s"} need attention)`
              : ""),
        },
        dedupeKey: `action-board:morning:${dateKey}`,
        throwOnError: false,
      });
    }
  }

  log.info(
    { written, emails: emails.length, events: events.length, dateKey },
    "Daily action board built",
  );
  return {
    written,
    emailsScanned: emails.length,
    eventsScanned: events.length,
  };
}

// ---------------------------------------------------------------------------
// Once-per-day, on-demand trigger
// ---------------------------------------------------------------------------

/**
 * In-memory guard: the date key we last attempted a build for in this daemon
 * run. Prevents repeated attempts (including no-op attempts when Google isn't
 * connected) from hammering the connector layer on every home-page open. The
 * persistent guard (today's summary card already on disk) covers restarts.
 */
let lastSuccessDateKey: string | null = null;
let attemptInFlight = false;

/**
 * Build today's action board unless it has already been built today. Idempotent
 * and fire-and-forget safe (never throws). This is the "stale-while-revalidate"
 * trigger wired into the home-feed background refresh and the morning tick, so
 * the board is fresh whenever the user opens Home (or by morning), at most once
 * per day, with no startup cost.
 *
 * The guard is **success-based**: it suppresses repeats only after a build has
 * actually written cards (tracked in-memory for the run, and persistently via
 * the summary card on disk so it survives restarts). A skip or transient
 * failure — e.g. the connector layer not being ready at daemon startup — does
 * NOT poison the guard, so a later trigger will retry. `attemptInFlight`
 * prevents two builds racing.
 */
export async function maybeBuildActionBoardForToday(opts?: {
  now?: Date;
  /** Forwarded to the build: emit a morning push if urgent. Only the morning
   *  tick sets this; the lazy home-open path leaves it off. */
  notify?: boolean;
}): Promise<void> {
  const now = opts?.now ?? new Date();
  const dateKey = localDateKey(now);

  if (attemptInFlight) return;
  if (lastSuccessDateKey === dateKey) return;

  // Persistent success guard: today's board is already on disk (survives
  // restart). Record it in memory and skip.
  const summaryId = `action-board:${dateKey}:summary`;
  if (readHomeFeed().items.some((i) => i.id === summaryId)) {
    lastSuccessDateKey = dateKey;
    return;
  }

  attemptInFlight = true;
  try {
    const result = await buildDailyActionBoard({
      now,
      notify: opts?.notify,
      recordTriageImpact: true,
    });
    // Only latch the guard on a real build. Skips (not connected, synthesis
    // failed) leave it unset so a later trigger retries.
    if (result.written > 0 && !result.skipped) {
      lastSuccessDateKey = dateKey;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Action board daily build failed");
  } finally {
    attemptInFlight = false;
  }
}
