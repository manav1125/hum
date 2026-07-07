/**
 * Cue HQ — Slack → instance dispatch (WS4).
 *
 * The bridge from a Slack event to the customer's daemon and back:
 *   team_id → slack_installs → customer (flag-gated) → live instance URL
 *   → mint a daemon-compatible actor token (secrets.ts mintActorToken —
 *     the same minting the magic-link flow uses, short TTL)
 *   → POST {instance}/v1/assistants/self/messages with the message text,
 *     sourceChannel: "slack" (an existing first-class daemon ChannelId —
 *     zero daemon changes needed)
 *   → poll GET messages?conversationKey=… for the assistant reply
 *   → chat.postMessage back into the Slack thread.
 *
 * All Slack state lives HQ-side; the daemon just sees a normal actor-token
 * message on the existing route.
 */

import type { HqDb, Instance, SlackInstall } from "../../db.js";
import { parseInstanceSecrets } from "../../provisioning.js";
import {
  ACTOR_TOKEN_TTL_SECONDS,
  guardianInit,
  mintActorToken,
} from "../../secrets.js";
import { slackDefaultBotToken } from "./config.js";

export interface SlackDispatchDeps {
  db: HqDb;
  fetchImpl?: typeof fetch;
  /** Reply-poll bounds (tests use tiny values). */
  replyTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Slack tokens should be short-lived — one turn, not the 30-day default. */
const SLACK_ACTOR_TOKEN_TTL_SECONDS = Math.min(
  60 * 60,
  ACTOR_TOKEN_TTL_SECONDS,
);
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const SLACK_API_BASE = "https://slack.com/api";

// ── Slack Web API ─────────────────────────────────────────────────────────

export async function slackApi(
  method: string,
  botToken: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  try {
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export async function postSlackMessage(
  params: {
    botToken: string;
    channel: string;
    text: string;
    threadTs?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  return slackApi(
    "chat.postMessage",
    params.botToken,
    {
      channel: params.channel,
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    },
    fetchImpl,
  );
}

// ── customer/instance resolution ─────────────────────────────────────────

export type SlackContext =
  | {
      ok: true;
      install: SlackInstall;
      customerId: string;
      instance: Instance;
      botToken: string;
    }
  | { ok: false; reason: string };

/**
 * Resolve a Slack team to a dispatchable customer instance. Every gate that
 * fails is a quiet skip (the event is still acked 200 to Slack):
 * unknown team, flag OFF (default), no live instance, no bot token.
 */
export function resolveSlackContext(db: HqDb, teamId: string): SlackContext {
  const install = db.getSlackInstall(teamId);
  if (!install) return { ok: false, reason: "team_not_installed" };
  const customer = db.getCustomer(install.customerId);
  if (!customer) return { ok: false, reason: "customer_missing" };
  if (!customer.slackEnabled) return { ok: false, reason: "flag_disabled" };
  const instance = db
    .listInstancesByCustomer(customer.id)
    .find((i) => i.state === "live");
  if (!instance) return { ok: false, reason: "no_live_instance" };
  const botToken = install.botToken || slackDefaultBotToken();
  if (!botToken) return { ok: false, reason: "no_bot_token" };
  return { ok: true, install, customerId: customer.id, instance, botToken };
}

// ── actor-token minting (reuses secrets.ts, magic-link style) ────────────

/**
 * Mint a short-lived actor token for the instance, learning the guardian
 * principal via guardian/init when provisioning didn't (same fallback the
 * magic-link path uses in provisioning.ts).
 */
export async function mintInstanceActorToken(
  deps: SlackDispatchDeps,
  instance: Instance,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secrets = parseInstanceSecrets(instance);
  if (!secrets?.actorTokenSigningKey) {
    return { ok: false, reason: "instance_missing_signing_key" };
  }
  if (!secrets.guardianPrincipalId) {
    try {
      const init = await guardianInit(
        instance.url,
        secrets.guardianBootstrapSecret,
        fetchImpl,
      );
      secrets.guardianPrincipalId = init.guardianPrincipalId;
      deps.db.updateInstanceSecrets(instance.id, JSON.stringify(secrets));
    } catch (err) {
      return {
        ok: false,
        reason: `guardian_init_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: true,
    token: mintActorToken({
      signingKeyHex: secrets.actorTokenSigningKey,
      guardianPrincipalId: secrets.guardianPrincipalId,
      ttlSeconds: SLACK_ACTOR_TOKEN_TTL_SECONDS,
    }),
  };
}

// ── message dispatch + reply polling ─────────────────────────────────────

interface InstanceMessage {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: string;
}

/**
 * Send one message into the instance and wait for the assistant's reply.
 * The conversationKey pins the Slack thread ↔ daemon conversation mapping
 * (the daemon's conversation_keys table materializes it on first use).
 */
export async function sendToInstanceAndAwaitReply(
  deps: SlackDispatchDeps,
  params: {
    instance: Instance;
    actorToken: string;
    conversationKey: string;
    text: string;
  },
): Promise<{ ok: true; reply: string } | { ok: false; reason: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = `${params.instance.url.replace(/\/$/, "")}/v1/assistants/self`;
  const headers = {
    Authorization: `Bearer ${params.actorToken}`,
    "Content-Type": "application/json",
  };

  const sentAtMs = Date.now();
  let send: Response;
  try {
    send = await fetchImpl(`${base}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        conversationKey: params.conversationKey,
        content: params.text,
        // Both are existing daemon enums (assistant/src/channels/types.ts):
        // "slack" is a first-class ChannelId AND InterfaceId — no daemon change.
        sourceChannel: "slack",
        interface: "slack",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Network-level failure (instance unreachable) takes the same graceful
    // path as an HTTP error — callers post the in-thread apology.
    return {
      ok: false,
      reason: `send_unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (send.status >= 300) {
    return { ok: false, reason: `send_failed_${send.status}` };
  }

  const timeoutMs = deps.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  // Allow small clock skew between HQ and the instance when comparing
  // message timestamps against our send time.
  const freshAfterMs = sentAtMs - 15_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let res: Response;
    try {
      res = await fetchImpl(
        `${base}/messages?conversationKey=${encodeURIComponent(params.conversationKey)}&limit=10`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    let body: { messages?: InstanceMessage[] };
    try {
      body = (await res.json()) as { messages?: InstanceMessage[] };
    } catch {
      continue;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // Newest fresh assistant message wins (list is chronological).
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
      if (Number.isFinite(ts) && ts < freshAfterMs) continue;
      const text = (m.content ?? "").trim();
      if (text) return { ok: true, reply: text };
    }
  }
  return { ok: false, reason: "reply_timeout" };
}

// ── top-level event dispatch ─────────────────────────────────────────────

export interface SlackInboundMessage {
  teamId: string;
  channel: string;
  /** Slack ts of the triggering message (thread anchor for the reply). */
  ts: string;
  /** Existing thread root when the mention happened inside a thread. */
  threadTs?: string;
  text: string;
  /** True for message.im events (DMs reply un-threaded, one thread per DM). */
  isDm: boolean;
}

/** Deterministic daemon conversation key for a Slack thread/DM. */
export function slackConversationKey(msg: SlackInboundMessage): string {
  if (msg.isDm) return `slack:${msg.teamId}:${msg.channel}`;
  return `slack:${msg.teamId}:${msg.channel}:${msg.threadTs ?? msg.ts}`;
}

/** Strip the bot @-mention (and any leading whitespace) from mention text. */
export function stripBotMention(text: string, botUserId: string): string {
  const cleaned = botUserId
    ? text.replaceAll(`<@${botUserId}>`, " ")
    : text.replace(/<@[A-Z0-9]+>/g, " ");
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Full pipeline for one inbound mention/DM. Called async AFTER the webhook
 * already acked 200 (Slack's 3s window). Failures are recorded as events
 * and answered in-thread with a friendly note when a bot token is at hand.
 */
export async function dispatchSlackMessage(
  deps: SlackDispatchDeps,
  msg: SlackInboundMessage,
): Promise<{ dispatched: boolean; reason?: string }> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ctx = resolveSlackContext(db, msg.teamId);
  if (!ctx.ok) {
    db.recordEvent("slack_dispatch_skipped", null, {
      teamId: msg.teamId,
      reason: ctx.reason,
    });
    return { dispatched: false, reason: ctx.reason };
  }

  const threadTs = msg.isDm ? undefined : (msg.threadTs ?? msg.ts);
  const fail = async (reason: string): Promise<{ dispatched: false; reason: string }> => {
    db.recordEvent("slack_dispatch_failed", ctx.customerId, {
      teamId: msg.teamId,
      channel: msg.channel,
      reason,
    });
    await postSlackMessage(
      {
        botToken: ctx.botToken,
        channel: msg.channel,
        threadTs,
        text: "Sorry — I couldn't reach your Cue right now. Please try again in a moment.",
      },
      fetchImpl,
    ).catch(() => {});
    return { dispatched: false, reason };
  };

  const text = stripBotMention(msg.text, ctx.install.botUserId);
  if (!text) return fail("empty_message");

  const minted = await mintInstanceActorToken(deps, ctx.instance);
  if (!minted.ok) return fail(minted.reason);

  const result = await sendToInstanceAndAwaitReply(deps, {
    instance: ctx.instance,
    actorToken: minted.token,
    conversationKey: slackConversationKey(msg),
    text,
  });
  if (!result.ok) return fail(result.reason);

  const posted = await postSlackMessage(
    {
      botToken: ctx.botToken,
      channel: msg.channel,
      threadTs,
      text: result.reply,
    },
    fetchImpl,
  );
  if (!posted.ok) {
    db.recordEvent("slack_dispatch_failed", ctx.customerId, {
      teamId: msg.teamId,
      channel: msg.channel,
      reason: `post_failed_${posted.error ?? "unknown"}`,
    });
    return { dispatched: false, reason: `post_failed_${posted.error ?? "unknown"}` };
  }
  db.recordEvent("slack_dispatch_completed", ctx.customerId, {
    teamId: msg.teamId,
    channel: msg.channel,
    conversationKey: slackConversationKey(msg),
  });
  return { dispatched: true };
}
