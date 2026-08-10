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

import {
  type EventSummary,
  fetchTodaysEvents,
} from "../calendar/todays-events.js";
import type { MessagingProvider } from "../messaging/provider.js";
import { getConnectedProviders } from "../messaging/registry.js";
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
import type {
  FeedAction,
  FeedItem,
  FeedItemCategory,
  FeedItemUrgency,
} from "./feed-types.js";
import { appendFeedItem, readHomeFeed } from "./feed-writer.js";
import { recordImpact, TIME_SAVED_MINUTES } from "./impact-store.js";

const log = getLogger("action-board");

const GMAIL_BASE = "https://gmail.googleapis.com";

/** How many unread emails / events to feed the synthesis model. */
const MAX_EMAILS = 15;
/** Hard cap on cards written, regardless of what the model returns. */
const MAX_ITEMS = 8;

/**
 * Per-channel bounded-fetch caps for messaging triage. We deliberately do NOT
 * pull full history — for each connected channel we list the most recently
 * active conversations and pull a small recent window of messages from each,
 * keeping total volume sane for the synth step.
 */
const MAX_CHANNEL_CONVERSATIONS = 15;
const MAX_MESSAGES_PER_CONVERSATION = 8;
/** Only consider messages newer than this window (48h). */
const CHANNEL_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Messaging providers handled by the dedicated email path (Gmail/Calendar via
 * the Google OAuth connection above). They are skipped by the generic
 * messaging-channel triage so email isn't double-fetched.
 */
const EMAIL_PROVIDER_IDS = new Set(["gmail", "outlook"]);

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

/** A bounded slice of one messaging conversation, tagged with its channel. */
export interface ChannelConversationSummary {
  /** Provider id, e.g. "slack", "telegram-bot", "whatsapp". */
  channel: string;
  /** Human-readable provider name, e.g. "Slack". */
  channelName: string;
  /** Stable conversation/source id (channel id, chat id, etc.). */
  conversationId: string;
  /** Conversation display name (channel name, DM peer, group title). */
  conversationName: string;
  unreadCount: number;
  /** Recent message lines (sender: text), oldest→newest, already truncated. */
  messages: Array<{ sender: string; text: string }>;
}

/**
 * The category to tag a synthesized triage item with, derived from the source
 * channel. Email/scheduling come from the synth's own classification; for
 * messaging channels we map the provider id to the matching FeedItemCategory.
 */
export function channelToCategory(channel: string): FeedItemCategory {
  switch (channel) {
    case "slack":
      return "slack";
    case "telegram-bot":
    case "telegram":
      return "telegram";
    case "whatsapp":
      return "whatsapp";
    default:
      return "chat";
  }
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
  /** Source messaging channel id (e.g. "slack") when this item came from a
   *  connected chat channel rather than email/calendar. */
  channel?: string;
  /** Source conversation id within that channel (channel id, chat id, …) so
   *  the one-click action can open the exact thread. */
  sourceConversationId?: string;
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

// ---------------------------------------------------------------------------
// Data gathering: connected messaging channels (Slack / Telegram / WhatsApp)
// ---------------------------------------------------------------------------

/**
 * Resolve the OAuthConnection a messaging provider needs for read calls.
 * Mirrors the messaging skill's `getProviderConnection`: providers that
 * manage their own credentials (Telegram bot tokens, Slack Socket Mode)
 * return `undefined`, which `listConversations`/`getHistory` accept.
 */
async function resolveChannelConnection(
  provider: MessagingProvider,
): Promise<OAuthConnection | undefined> {
  if (provider.resolveConnection) return provider.resolveConnection();
  if (await provider.isConnected?.()) return undefined;
  return resolveOAuthConnection(provider.credentialService);
}

/**
 * Bounded fetch for a single connected channel: list the most recently active
 * conversations (capped) and pull a small recent window of messages from each.
 * Prefers unread conversations where the provider exposes unread counts. Never
 * pulls full history. Returns a flat list of per-conversation summaries.
 *
 * Failure-isolated: any provider/network error yields an empty list (logged),
 * so one bad channel can't break the others or the email path.
 */
export async function fetchChannelConversations(
  provider: MessagingProvider,
  now: Date,
): Promise<ChannelConversationSummary[]> {
  let conn: OAuthConnection | undefined;
  try {
    conn = await resolveChannelConnection(provider);
  } catch (err) {
    log.warn(
      { err: String(err), channel: provider.id },
      "Action board: channel connection resolve failed",
    );
    return [];
  }

  let conversations;
  try {
    conversations = await provider.listConversations(conn, {
      excludeArchived: true,
      limit: MAX_CHANNEL_CONVERSATIONS,
    });
  } catch (err) {
    log.warn(
      { err: String(err), channel: provider.id },
      "Action board: listConversations failed",
    );
    return [];
  }

  // Prefer unread / most-recently-active conversations; cap the count.
  const ranked = [...conversations]
    .sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      return b.lastActivityAt - a.lastActivityAt;
    })
    .slice(0, MAX_CHANNEL_CONVERSATIONS);

  const cutoffMs = now.getTime() - CHANNEL_LOOKBACK_MS;
  const out: ChannelConversationSummary[] = [];
  for (const convo of ranked) {
    // Skip stale conversations with nothing unread — keeps volume sane.
    if (convo.unreadCount === 0 && convo.lastActivityAt < cutoffMs) continue;

    let messages;
    try {
      messages = await provider.getHistory(conn, convo.id, {
        limit: MAX_MESSAGES_PER_CONVERSATION,
      });
    } catch (err) {
      log.warn(
        { err: String(err), channel: provider.id, conversationId: convo.id },
        "Action board: getHistory failed for conversation",
      );
      continue;
    }

    const recent = messages
      .filter((m) => m.timestamp >= cutoffMs)
      .slice(-MAX_MESSAGES_PER_CONVERSATION)
      .map((m) => ({
        sender: m.sender.name || m.sender.id,
        text: (m.text ?? "").slice(0, 280),
      }))
      .filter((m) => m.text.length > 0);

    if (recent.length === 0) continue;

    out.push({
      channel: provider.id,
      channelName: provider.displayName,
      conversationId: convo.id,
      conversationName: convo.name,
      unreadCount: convo.unreadCount,
      messages: recent,
    });
  }
  return out;
}

/**
 * Gather triage material from every CONNECTED messaging channel (Slack,
 * Telegram, WhatsApp, …), excluding the email providers already handled by
 * the dedicated Gmail path. Only providers the user has actually
 * connected/configured are touched — `getConnectedProviders()` checks each
 * provider's availability. Per-channel failures degrade gracefully.
 */
async function gatherChannelMaterial(
  now: Date,
): Promise<ChannelConversationSummary[]> {
  let connected: MessagingProvider[];
  try {
    connected = await getConnectedProviders();
  } catch (err) {
    log.warn(
      { err: String(err) },
      "Action board: getConnectedProviders failed; skipping channel triage",
    );
    return [];
  }

  const channels = connected.filter((p) => !EMAIL_PROVIDER_IDS.has(p.id));
  if (channels.length === 0) return [];

  const results = await Promise.all(
    channels.map((p) => fetchChannelConversations(p, now)),
  );
  return results.flat();
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
            channel: {
              type: "string",
              description:
                "For messaging items only: copy the exact [channel: …] value (e.g. 'slack', 'telegram-bot', 'whatsapp') of the chat this item is about. Omit for email/calendar items.",
            },
            sourceConversationId: {
              type: "string",
              description:
                "For messaging items only: copy the exact [conversation: …] value of the chat this item is about, so the card can open the thread. Omit for email/calendar items.",
            },
          },
          required: ["title", "summary", "urgency", "category"],
        },
      },
    },
    required: ["headline", "items"],
  },
};

const SYNTH_SYSTEM = `You are Cue's cross-stream action-board synthesizer. You receive the user's unread emails, today's calendar events, AND recent messages from their connected chat channels (Slack, Telegram, WhatsApp, …), and produce a single short, prioritized, cross-stream list of action items for their home dashboard.

Rules:
- Be ruthless about signal. Skip newsletters, marketing, automated notifications, bot chatter, and anything that doesn't need the user. An empty list is correct when nothing needs attention.
- At most ${MAX_ITEMS} items total across ALL streams. Order by genuine importance regardless of which stream an item came from.
- For emails that warrant a reply, set category "email", actionLabel "Draft reply", and a self-contained actionPrompt naming the sender and subject. Copy the email's [id: …] into sourceMessageId.
- For chat messages that need a reply or action, set category to the matching channel (the [channel: …] value), actionLabel "Reply" (or a fitting verb), and a self-contained actionPrompt naming the channel, the conversation, and what to say/do. Copy the [channel: …] value into channel and the [conversation: …] value into sourceConversationId.
- For meetings that need prep, set category "scheduling", actionLabel "Prep", with an actionPrompt describing what to prepare.
- Use urgency honestly: most things are low/medium. Reserve high/critical for deadlines, time-sensitive replies, or conflicts.
- If a "Scheduling conflicts detected" section is present, you MUST surface each conflict as a high-urgency scheduling item so the user can resolve the overlap.`;

/** Render connected-channel messages as a context section for the synth. */
function channelSection(channels: ChannelConversationSummary[]): string[] {
  if (channels.length === 0) return [];
  const lines: string[] = [
    "",
    `## Connected channels (${channels.length} conversations)`,
  ];
  for (const c of channels) {
    lines.push(
      `- [channel: ${c.channel}] [conversation: ${c.conversationId}] ${c.channelName} · ${c.conversationName}${c.unreadCount > 0 ? ` (${c.unreadCount} unread)` : ""}`,
    );
    for (const m of c.messages) {
      lines.push(`    ${m.sender}: ${m.text}`);
    }
  }
  return lines;
}

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
  channels: ChannelConversationSummary[],
  now: Date,
  signal?: AbortSignal,
): Promise<{ headline: string; items: SynthItem[] } | null> {
  if (emails.length === 0 && events.length === 0 && channels.length === 0) {
    return {
      headline: "Your inbox, calendar, and channels are clear.",
      items: [],
    };
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
    ...channelSection(channels),
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

  // Gather triage material from every CONNECTED messaging channel first. This
  // is independent of the Google connection below — a channel failure here
  // can't break the email/calendar path (and vice-versa), since
  // gatherChannelMaterial isolates per-channel failures internally.
  let channels: ChannelConversationSummary[] = [];
  try {
    channels = await gatherChannelMaterial(now);
  } catch (err) {
    log.warn({ err: String(err) }, "Action board: channel gather failed");
  }

  // Google (Gmail + Calendar) is now optional: when it isn't connected we
  // still triage whatever messaging channels ARE connected. Only bail
  // entirely when neither Google nor any channel is available.
  let conn: OAuthConnection | null = null;
  try {
    conn = await resolveOAuthConnection("google");
  } catch (err) {
    if (channels.length === 0) {
      log.info(
        { err: String(err) },
        "Action board skipped: no connected streams (Google + channels both unavailable)",
      );
      return {
        written: 0,
        skipped: "no-connected-streams",
        emailsScanned: 0,
        eventsScanned: 0,
      };
    }
    log.info(
      { err: String(err) },
      "Action board: Google not connected; triaging channels only",
    );
  }

  let emails: EmailSummary[] = [];
  let events: EventSummary[] = [];
  if (conn) {
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
  }

  if (opts?.recordTriageImpact && emails.length > 0) {
    recordImpact({
      type: "emails_triaged",
      category: "email",
      minutesSaved: emails.length * TIME_SAVED_MINUTES.emailTriaged,
      detail: `Triaged ${emails.length} unread email${emails.length === 1 ? "" : "s"}`,
    });
  }

  const synth = await synthesize(emails, events, channels, now, signal);
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

  // Dedup: collect the (channel, conversation) sources already present on
  // live feed items NOT written by today's build, so we don't re-surface the
  // same chat thread on every rebuild. Today's own positional cards
  // (`action-board:<dateKey>:*`) replace in place via the writer's same-id
  // merge, so they're excluded from this set.
  const existingSources = new Set<string>();
  for (const existing of readHomeFeed().items) {
    if (existing.id.startsWith(`action-board:${dateKey}:`)) continue;
    const md = existing.metadata as
      | { channel?: unknown; sourceConversationId?: unknown }
      | undefined;
    if (
      typeof md?.channel === "string" &&
      typeof md?.sourceConversationId === "string"
    ) {
      existingSources.add(`${md.channel}:${md.sourceConversationId}`);
    }
  }

  let written = 1;
  for (let i = 0; i < synth.items.length; i++) {
    const it = synth.items[i];

    // Skip a channel item whose exact source thread is already live on the
    // feed from an earlier build (cross-build dedup).
    if (
      it.channel &&
      it.sourceConversationId &&
      existingSources.has(`${it.channel}:${it.sourceConversationId}`)
    ) {
      continue;
    }

    const actions: FeedAction[] = [];
    if (it.actionLabel && it.actionPrompt) {
      actions.push({
        id: "primary",
        label: it.actionLabel,
        prompt: it.actionPrompt,
      });
    }

    // Channel items get a per-channel category (slack/telegram/whatsapp/chat);
    // email/calendar items keep the synth's own classification.
    const category: FeedItemCategory = it.channel
      ? channelToCategory(it.channel)
      : it.category;

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
      category,
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
        ...(it.channel
          ? {
              channel: it.channel,
              sourceType: it.channel,
              ...(it.sourceConversationId
                ? {
                    sourceConversationId: it.sourceConversationId,
                    sourceId: it.sourceConversationId,
                  }
                : {}),
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
