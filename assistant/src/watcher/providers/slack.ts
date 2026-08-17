/**
 * Slack watcher provider — polls channel history for new messages.
 *
 * Scope is deliberately narrow: it watches ONLY the channels named in the
 * watcher's config (`config.channels`, Slack channel IDs), and within those,
 * only channels the bot is actually a member of. There is no firehose mode —
 * a watcher with no channel list watches nothing, and `describeScope` says so
 * rather than letting the owner wait on a hit that cannot come.
 *
 * Polling mirrors the gateway's catch-up primitives
 * (`gateway/src/slack/slack-web.ts` — `conversations.history` with `oldest` +
 * `inclusive=false`, bounded `limit`, no pagination). The gateway package is
 * not importable from the daemon, so the same calls are made through the
 * daemon's own OAuth connection layer instead of a raw fetch: the Composio
 * request proxy when the Slack toolkit is connected there, or the
 * `slack_channel` manual bot token (the gateway's own credential) otherwise.
 *
 * Everything a poll returns is third-party-authored. The provider declares
 * `untrustedContentSource: "slack"`, so the engine fences every payload in an
 * `<external_content source="slack">` envelope before any model reads it, and
 * bounds it via `capPayloadForStorage` before any row is written.
 */

import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import { WATCHER_PAYLOAD_TEXT_MAX_CHARS } from "../constants.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
  WatcherScope,
} from "../provider-types.js";

const log = getLogger("watcher:slack");

/**
 * Explicit API host on every request. The Composio proxy path has no fallback
 * base URL for the Slack toolkit (`TOOLKIT_BASE_URLS` in
 * `oauth/composio-oauth.ts` covers only Google), so a bare relative path would
 * resolve against nothing; the `slack_channel` BYO path would work without it
 * but honors the override identically.
 */
const SLACK_API_BASE = "https://slack.com/api";

/** Messages fetched per channel per poll — same bound the gateway uses. */
const HISTORY_LIMIT_PER_CHANNEL = 50;

/**
 * Ceiling on channels polled per tick. Each channel costs one API call per
 * poll; a config listing hundreds of channels should degrade into "the first
 * N, loudly" rather than a rate-limit spiral.
 */
const MAX_CHANNELS_PER_POLL = 20;

// ── API types ──────────────────────────────────────────────────────────────

/** Subset of the `conversations.history` message payload the watcher reads. */
interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
}

interface SlackApiEnvelope {
  ok?: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
  channels?: Array<{ id?: string }>;
  response_metadata?: { next_cursor?: string };
}

// ── Watermark ──────────────────────────────────────────────────────────────

/**
 * The watermark is a JSON object rather than a single cursor because each
 * channel advances independently: `floor` is the "start from now" position a
 * channel uses on its first poll (so provisioning never replays history), and
 * `channels` maps channel ID → the newest Slack `ts` already seen there.
 */
interface SlackWatermark {
  floor: string;
  channels: Record<string, string>;
}

/** Current time as a Slack `ts` ("<epoch-seconds>.<suffix>"). */
function nowTs(): string {
  return `${Math.floor(Date.now() / 1000)}.000000`;
}

function parseWatermark(watermark: string | null): SlackWatermark {
  if (watermark) {
    try {
      const parsed = JSON.parse(watermark) as Partial<SlackWatermark>;
      if (parsed && typeof parsed === "object") {
        return {
          floor: typeof parsed.floor === "string" ? parsed.floor : nowTs(),
          channels:
            parsed.channels && typeof parsed.channels === "object"
              ? Object.fromEntries(
                  Object.entries(parsed.channels).filter(
                    ([, v]) => typeof v === "string",
                  ),
                )
              : {},
        };
      }
    } catch {
      // Unreadable watermark — fall through to "start from now". Replaying
      // history into the Came-in lane is the failure to avoid; a gap is not.
    }
  }
  return { floor: nowTs(), channels: {} };
}

// ── Config ─────────────────────────────────────────────────────────────────

/** The channel IDs this watcher is pointed at, in config order, deduped. */
function configuredChannels(config: Record<string, unknown>): string[] {
  const raw = config.channels;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = entry.trim().replace(/^#/, "");
    if (id) seen.add(id);
  }
  return Array.from(seen);
}

// ── Slack Web API via the daemon's connection layer ────────────────────────

/**
 * Resolve a connection that can call the Slack Web API.
 *
 * Layered on purpose: the watcher row's own credential service first (the
 * auto-provisioned rows say "slack", which resolveOAuthConnection satisfies
 * Composio-first), then the `slack_channel` manual bot token — the credential
 * the gateway's Socket Mode bot already runs on, so an install that talks to
 * Slack only through the gateway can still poll.
 */
async function resolveSlackConnection(
  credentialService: string,
): Promise<OAuthConnection> {
  try {
    return await resolveOAuthConnection(credentialService);
  } catch (err) {
    if (credentialService === "slack_channel") throw err;
    log.debug(
      { err: String(err), credentialService },
      "Slack: primary credential unavailable, trying slack_channel bot token",
    );
    return resolveOAuthConnection("slack_channel");
  }
}

async function slackGet(
  connection: OAuthConnection,
  method: string,
  query: Record<string, string>,
): Promise<SlackApiEnvelope> {
  const resp = await connection.request({
    method: "GET",
    path: `/${method}`,
    query,
    baseUrl: SLACK_API_BASE,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const body =
      typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
    throw new Error(
      `Slack ${method} HTTP ${resp.status}: ${truncate(body, 200)}`,
    );
  }
  const body =
    typeof resp.body === "string"
      ? (JSON.parse(resp.body) as SlackApiEnvelope)
      : (resp.body as SlackApiEnvelope);
  return body ?? {};
}

/**
 * Pages of `users.conversations` to walk. Slack caps a page at 200 (well
 * under 1000 in practice), so this reaches ~2000 memberships — enough for a
 * long-standing account in a busy workspace, and bounded so a paging bug on
 * either side cannot spin a poll forever.
 */
const MEMBERSHIP_MAX_PAGES = 10;

/**
 * The channels the bot is a member of, or null when Slack would not say.
 *
 * Null is "unknown", not "none": the caller falls back to attempting each
 * configured channel and treating `not_in_channel` as the membership answer,
 * so a transient failure here degrades gracefully instead of silencing the
 * watcher.
 *
 * The membership set must be COMPLETE or absent — a partial one is worse than
 * none, because the caller reads it as authoritative and skips every
 * configured channel it does not contain. A single unpaginated page silently
 * did that to any identity in more than 200 channels: the watcher reported
 * healthy, polled nothing, and logged no error, because "not in the first
 * page" is indistinguishable from "not a member". So follow the cursor, and
 * if the walk is cut short by the page ceiling, return null rather than a
 * truncated set the caller would trust.
 */
async function fetchMemberChannelIds(
  connection: OAuthConnection,
): Promise<Set<string> | null> {
  try {
    const ids = new Set<string>();
    let cursor = "";
    for (let page = 0; page < MEMBERSHIP_MAX_PAGES; page++) {
      const body = await slackGet(connection, "users.conversations", {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      if (body.ok !== true) {
        log.debug(
          { error: body.error, page },
          "Slack: users.conversations returned ok=false",
        );
        return null;
      }
      for (const channel of body.channels ?? []) {
        if (typeof channel?.id === "string" && channel.id) ids.add(channel.id);
      }
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) return ids;
    }
    log.warn(
      { pages: MEMBERSHIP_MAX_PAGES, seen: ids.size },
      "Slack: membership listing exceeded the page ceiling — treating membership " +
        "as unknown so configured channels are attempted rather than skipped",
    );
    return null;
  } catch (err) {
    log.debug({ err: String(err) }, "Slack: users.conversations failed");
    return null;
  }
}

/** Errors that mean "this channel is not pollable", not "the poll failed". */
const SKIPPABLE_CHANNEL_ERRORS = new Set([
  "not_in_channel",
  "channel_not_found",
  "is_archived",
]);

/**
 * A plain human channel message. Joins/leaves/topic changes carry a
 * `subtype`, and anything with a `bot_id` is app-authored — including this
 * bot's own posts, which would otherwise loop straight back into intake.
 */
function isWatchableMessage(msg: SlackHistoryMessage): boolean {
  if (!msg.ts) return false;
  if (msg.type !== undefined && msg.type !== "message") return false;
  if (msg.subtype) return false;
  if (msg.bot_id) return false;
  return Boolean(msg.user);
}

function messageToItem(
  channelId: string,
  msg: SlackHistoryMessage,
): WatcherItem {
  const ts = msg.ts ?? "";
  // Capped at the source as well as in the engine: Slack allows message
  // bodies up to 40k characters, far beyond any other field this provider
  // returns, so the ceiling is applied where the field is read.
  const text = truncate(msg.text ?? "", WATCHER_PAYLOAD_TEXT_MAX_CHARS);
  const seconds = Number.parseFloat(ts);

  return {
    externalId: `${channelId}:${ts}`,
    eventType: "new_message",
    summary: `Slack message in ${channelId} from ${msg.user ?? "unknown"}: ${truncate(text, 80)}`,
    payload: {
      channel: channelId,
      user: msg.user ?? "",
      text,
      ts,
      // The THREAD anchor, when the message opened or broadcast from one —
      // it is what a reply must quote as `thread_ts` to land in-thread
      // (see skills/slack/SKILL.md, Threading).
      threadTs: msg.thread_ts ?? "",
      team: msg.team ?? "",
    },
    timestamp: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
  };
}

// ── Provider ───────────────────────────────────────────────────────────────

export const slackProvider: WatcherProvider = {
  id: "slack",
  displayName: "Slack",
  requiredCredentialService: "slack",
  untrustedContentSource: "slack",

  /**
   * A Slack watcher with no channel list CANNOT produce — that is the
   * deliberate no-firehose stance, and this is where the owner learns it.
   */
  describeScope(config: Record<string, unknown>): WatcherScope {
    const channels = configuredChannels(config);
    if (channels.length === 0) {
      return {
        watching: false,
        summary:
          "Not watching any Slack channels — this watcher polls only channels named in its configuration.",
        fix: 'Add Slack channel IDs to the watcher\'s config, e.g. {"channels": ["C0123456789"]} (the bot must be a member of each).',
      };
    }
    const shown = channels.slice(0, 5).join(", ");
    const suffix = channels.length > 5 ? `, +${channels.length - 5} more` : "";
    return {
      watching: true,
      summary: `Watching ${channels.length} Slack channel${channels.length === 1 ? "" : "s"} for new messages (${shown}${suffix}), skipping channels the bot is not a member of.`,
    };
  },

  /**
   * Start from "now". No API call needed: the floor is a timestamp of our own
   * choosing, and per-channel cursors advance from it on the first real poll.
   */
  async getInitialWatermark(_credentialService: string): Promise<string> {
    const watermark: SlackWatermark = { floor: nowTs(), channels: {} };
    return JSON.stringify(watermark);
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const state = parseWatermark(watermark);
    const channels = configuredChannels(config);

    if (channels.length === 0) {
      // Nothing to poll — and no API call to spend finding that out.
      return { items: [], watermark: JSON.stringify(state) };
    }

    const polled = channels.slice(0, MAX_CHANNELS_PER_POLL);
    if (polled.length < channels.length) {
      log.warn(
        { configured: channels.length, polled: polled.length },
        "Slack: channel list exceeds the per-poll ceiling; extra channels ignored",
      );
    }

    const connection = await resolveSlackConnection(credentialService);

    // Membership gate: only channels the bot is in. When Slack cannot answer,
    // fall through to per-channel attempts — `not_in_channel` below is the
    // same gate enforced one call later.
    const memberIds = await fetchMemberChannelIds(connection);

    const items: WatcherItem[] = [];
    const nextChannels: Record<string, string> = {};

    for (const channelId of polled) {
      const oldest = state.channels[channelId] ?? state.floor;

      if (memberIds && !memberIds.has(channelId)) {
        log.debug({ channelId }, "Slack: bot is not a member; skipping");
        // Keep the cursor where it was: joining the channel later resumes
        // from the floor/last position instead of replaying from zero.
        nextChannels[channelId] = oldest;
        continue;
      }

      const body = await slackGet(connection, "conversations.history", {
        channel: channelId,
        oldest,
        limit: String(HISTORY_LIMIT_PER_CHANNEL),
        inclusive: "false",
      });

      if (body.ok !== true) {
        if (body.error && SKIPPABLE_CHANNEL_ERRORS.has(body.error)) {
          log.debug(
            { channelId, error: body.error },
            "Slack: channel not pollable; skipping",
          );
          nextChannels[channelId] = oldest;
          continue;
        }
        throw new Error(
          `Slack conversations.history failed for ${channelId}: ${body.error ?? "unknown error"}`,
        );
      }

      // Newest-first from Slack. The cursor advances to the newest ts seen —
      // including bot/subtype messages we do not surface, so a chatty app in
      // the channel cannot make the same window re-fetch forever.
      let newest = oldest;
      for (const msg of body.messages ?? []) {
        if (msg.ts && Number.parseFloat(msg.ts) > Number.parseFloat(newest)) {
          newest = msg.ts;
        }
        if (isWatchableMessage(msg)) {
          items.push(messageToItem(channelId, msg));
        }
      }
      nextChannels[channelId] = newest;
    }

    if (items.length > 0) {
      log.info({ count: items.length }, "Slack: fetched new messages");
    }

    // Cursors for channels no longer configured are dropped, so the watermark
    // cannot grow without bound as the owner rotates the channel list.
    const next: SlackWatermark = { floor: state.floor, channels: nextChannels };
    return { items, watermark: JSON.stringify(next) };
  },
};
