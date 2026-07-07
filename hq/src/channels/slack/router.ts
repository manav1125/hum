/**
 * Cue HQ — Slack HTTP routes (WS4).
 *
 * Public routes (registered by server.ts, live only when SLACK_* env set):
 *   GET  /slack/install         ?state= (HMAC-signed, admin-minted) →
 *                               302 to Slack's OAuth authorize URL
 *   GET  /slack/oauth/callback  ?code=&state= → exchange code, store the
 *                               team → customer binding, 302 to /account
 *   POST /slack/events          Events API (app_mention, message.im).
 *                               Signature-verified, event_id-deduped,
 *                               acked immediately (3s window) — the actual
 *                               dispatch runs async (dispatch.ts).
 *   POST /slack/commands        /cue status | new | help
 *
 * Security invariants:
 *   - EVERY events/commands request is signature-verified (v0 scheme,
 *     timestamp tolerance, timing-safe compare) before any parsing.
 *   - event_id dedupe: Slack redelivers on slow acks; each event id
 *     dispatches at most once (slack_event_dedupe table).
 *   - Per-customer flag (customers.slackEnabled, default OFF) gates all
 *     routing — an installed-but-disabled workspace gets acks, never
 *     dispatches.
 */

import type { HqDb } from "../../db.js";
import { publicSiteBase } from "../../provisioning.js";
import {
  SLACK_OAUTH_SCOPES,
  isSlackConfigured,
  isSlackOAuthConfigured,
  slackClientId,
  slackClientSecret,
  slackSigningSecret,
} from "./config.js";
import {
  dispatchSlackMessage,
  mintInstanceActorToken,
  resolveSlackContext,
  sendToInstanceAndAwaitReply,
  type SlackDispatchDeps,
  type SlackInboundMessage,
} from "./dispatch.js";
import { verifyInstallState, verifySlackSignature } from "./verify.js";

export interface SlackRouterDeps extends SlackDispatchDeps {
  db: HqDb;
  /**
   * Async-work scheduler: the events/commands routes ack within Slack's 3s
   * window and hand the real work here. Defaults to fire-and-forget with
   * error events recorded; tests inject a capture to await completion
   * (mirrors server.ts scheduleAutoProvision).
   */
  schedule?: (work: Promise<unknown>) => void;
  nowMs?: () => number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function schedule(deps: SlackRouterDeps, work: Promise<unknown>): void {
  const run = work.catch((err) => {
    deps.db.recordEvent("slack_dispatch_failed", null, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (deps.schedule) deps.schedule(run);
}

/**
 * Route entry point. Returns null for paths this module doesn't own so
 * server.ts can keep falling through.
 */
export async function handleSlackRequest(
  deps: SlackRouterDeps,
  req: Request,
  url: URL,
  path: string,
  method: string,
): Promise<Response | null> {
  if (!path.startsWith("/slack/")) return null;

  if (method === "GET" && path === "/slack/install") {
    return handleInstall(deps, url);
  }
  if (method === "GET" && path === "/slack/oauth/callback") {
    return handleOAuthCallback(deps, url);
  }
  if (method === "POST" && path === "/slack/events") {
    return handleEvents(deps, req);
  }
  if (method === "POST" && path === "/slack/commands") {
    return handleCommands(deps, req);
  }
  return null;
}

// ── install / OAuth ───────────────────────────────────────────────────────

function handleInstall(deps: SlackRouterDeps, url: URL): Response {
  if (!isSlackOAuthConfigured()) {
    return json({ error: "slack not configured" }, 503);
  }
  const state = url.searchParams.get("state") ?? "";
  const verified = verifyInstallState(
    state,
    slackSigningSecret(),
    deps.nowMs?.(),
  );
  if (!verified.ok) return json({ error: "invalid or expired state" }, 400);

  const redirectUri = `${publicSiteBase()}/slack/oauth/callback`;
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", slackClientId());
  authorize.searchParams.set("scope", SLACK_OAUTH_SCOPES);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("redirect_uri", redirectUri);
  return new Response(null, {
    status: 302,
    headers: { Location: authorize.toString() },
  });
}

async function handleOAuthCallback(
  deps: SlackRouterDeps,
  url: URL,
): Promise<Response> {
  if (!isSlackOAuthConfigured()) {
    return json({ error: "slack not configured" }, 503);
  }
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const state = url.searchParams.get("state") ?? "";
  const verified = verifyInstallState(
    state,
    slackSigningSecret(),
    deps.nowMs?.(),
  );
  if (!verified.ok) return json({ error: "invalid or expired state" }, 400);
  const customer = db.getCustomer(verified.customerId);
  if (!customer) return json({ error: "unknown customer" }, 404);

  const code = url.searchParams.get("code") ?? "";
  if (!code) {
    // User hit "Cancel" on Slack's consent screen (?error=access_denied).
    return new Response(null, {
      status: 302,
      headers: { Location: `${publicSiteBase()}/account?slack=cancelled` },
    });
  }

  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: slackClientId(),
      client_secret: slackClientSecret(),
      code,
      redirect_uri: `${publicSiteBase()}/slack/oauth/callback`,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let body: {
    ok?: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = { ok: false, error: "invalid_json" };
  }
  if (!res.ok || !body.ok || !body.access_token || !body.team?.id) {
    db.recordEvent("slack_install_failed", customer.id, {
      error: body.error ?? `http_${res.status}`,
    });
    return json({ error: body.error ?? "oauth_exchange_failed" }, 502);
  }

  db.upsertSlackInstall({
    teamId: body.team.id,
    customerId: customer.id,
    botToken: body.access_token,
    botUserId: body.bot_user_id ?? "",
    teamName: body.team.name ?? "",
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `${publicSiteBase()}/account?slack=connected` },
  });
}

// ── Events API ────────────────────────────────────────────────────────────

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
}

async function handleEvents(
  deps: SlackRouterDeps,
  req: Request,
): Promise<Response> {
  if (!isSlackConfigured()) {
    return json({ error: "slack not configured" }, 503);
  }
  const { db } = deps;
  const rawBody = await req.text();
  if (
    !verifySlackSignature({
      rawBody,
      timestampHeader: req.headers.get("x-slack-request-timestamp"),
      signatureHeader: req.headers.get("x-slack-signature"),
      secret: slackSigningSecret(),
      nowMs: deps.nowMs?.(),
    })
  ) {
    return json({ error: "invalid signature" }, 401);
  }

  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  // App-config handshake.
  if (envelope.type === "url_verification") {
    return json({ challenge: envelope.challenge ?? "" });
  }
  if (envelope.type !== "event_callback" || !envelope.event) {
    return json({ ok: true, ignored: true });
  }

  // Dedupe BEFORE any work — Slack redelivers whole envelopes on slow acks.
  const eventId = envelope.event_id ?? "";
  if (!eventId || !db.recordSlackEventId(eventId, deps.nowMs?.())) {
    return json({ ok: true, duplicate: true });
  }

  const event = envelope.event;
  const teamId = envelope.team_id ?? "";
  const isMention = event.type === "app_mention";
  const isDm =
    event.type === "message" &&
    event.channel_type === "im" &&
    !event.subtype &&
    !event.bot_id;
  if ((!isMention && !isDm) || !teamId || !event.channel || !event.ts) {
    return json({ ok: true, ignored: true });
  }
  // Never respond to our own (or any bot's) messages — loop guard.
  if (event.bot_id) return json({ ok: true, ignored: true });
  const install = db.getSlackInstall(teamId);
  if (install?.botUserId && event.user === install.botUserId) {
    return json({ ok: true, ignored: true });
  }

  const msg: SlackInboundMessage = {
    teamId,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    text: event.text ?? "",
    isDm,
  };
  // Ack now (3s window); the real work continues async.
  schedule(deps, dispatchSlackMessage(deps, msg));
  return json({ ok: true });
}

// ── /cue slash command ────────────────────────────────────────────────────

const CUE_HELP_TEXT = [
  "*Cue* — your assistant, in Slack.",
  "• `@Cue <message>` in a channel (or DM the bot) to talk to your Cue.",
  "• `/cue status` — check the connection to your Cue instance.",
  "• `/cue new <message>` — start a brand-new conversation.",
  "• `/cue help` — this message.",
].join("\n");

async function handleCommands(
  deps: SlackRouterDeps,
  req: Request,
): Promise<Response> {
  if (!isSlackConfigured()) {
    return json({ error: "slack not configured" }, 503);
  }
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rawBody = await req.text();
  if (
    !verifySlackSignature({
      rawBody,
      timestampHeader: req.headers.get("x-slack-request-timestamp"),
      signatureHeader: req.headers.get("x-slack-signature"),
      secret: slackSigningSecret(),
      nowMs: deps.nowMs?.(),
    })
  ) {
    return json({ error: "invalid signature" }, 401);
  }

  const form = new URLSearchParams(rawBody);
  const teamId = form.get("team_id") ?? "";
  const channel = form.get("channel_id") ?? "";
  const text = (form.get("text") ?? "").trim();
  const responseUrl = form.get("response_url") ?? "";
  const [subcommand, ...restWords] = text.split(/\s+/).filter(Boolean);
  const rest = restWords.join(" ");

  const ephemeral = (t: string) =>
    json({ response_type: "ephemeral", text: t });

  switch ((subcommand ?? "help").toLowerCase()) {
    case "status": {
      const ctx = resolveSlackContext(db, teamId);
      if (ctx.ok) {
        return ephemeral(
          "✅ Connected — your Cue instance is live and Slack routing is enabled.",
        );
      }
      const reasons: Record<string, string> = {
        team_not_installed:
          "This workspace isn't linked to a Cue account yet. Ask your admin for an install link.",
        customer_missing:
          "This workspace's Cue account no longer exists. Contact support.",
        flag_disabled:
          "Slack routing is switched off for your Cue account. Ask support to enable it.",
        no_live_instance:
          "Your Cue instance isn't running right now. Check your account at " +
          `${publicSiteBase()}/account`,
        no_bot_token:
          "The Slack connection needs to be re-installed. Ask your admin for a fresh install link.",
      };
      return ephemeral(`⚠️ ${reasons[ctx.reason] ?? "Not connected."}`);
    }

    case "new": {
      if (!rest) {
        return ephemeral(
          "Usage: `/cue new <message>` — starts a fresh conversation with that message.",
        );
      }
      const msg: SlackInboundMessage = {
        teamId,
        channel,
        ts: String(deps.nowMs?.() ?? Date.now()),
        text: rest,
        isDm: true, // reply un-threaded in the channel the command ran in
      };
      // Unique key per /cue new — a genuinely fresh daemon conversation.
      const freshKey = `slack:${teamId}:${channel}:new-${deps.nowMs?.() ?? Date.now()}`;
      schedule(
        deps,
        runNewCommand(deps, msg, freshKey, responseUrl, fetchImpl),
      );
      return ephemeral("🆕 Starting a fresh conversation — one moment…");
    }

    case "help":
    default:
      return ephemeral(CUE_HELP_TEXT);
  }
}

/**
 * /cue new pipeline: dispatch with a one-off conversation key and deliver
 * the reply through the command's response_url (works even where the bot
 * isn't a channel member).
 */
async function runNewCommand(
  deps: SlackRouterDeps,
  msg: SlackInboundMessage,
  conversationKey: string,
  responseUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const { db } = deps;
  const ctx = resolveSlackContext(db, msg.teamId);
  const respond = async (text: string, inChannel: boolean) => {
    if (!responseUrl) return;
    await fetchImpl(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: inChannel ? "in_channel" : "ephemeral",
        text,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  };
  if (!ctx.ok) {
    db.recordEvent("slack_dispatch_skipped", null, {
      teamId: msg.teamId,
      reason: ctx.reason,
      command: "new",
    });
    await respond(
      "⚠️ Couldn't reach your Cue — run `/cue status` for details.",
      false,
    );
    return;
  }
  const minted = await mintInstanceActorToken(deps, ctx.instance);
  if (!minted.ok) {
    db.recordEvent("slack_dispatch_failed", ctx.customerId, {
      teamId: msg.teamId,
      reason: minted.reason,
      command: "new",
    });
    await respond("⚠️ Couldn't reach your Cue right now — try again shortly.", false);
    return;
  }
  const result = await sendToInstanceAndAwaitReply(deps, {
    instance: ctx.instance,
    actorToken: minted.token,
    conversationKey,
    text: msg.text,
  });
  if (!result.ok) {
    db.recordEvent("slack_dispatch_failed", ctx.customerId, {
      teamId: msg.teamId,
      reason: result.reason,
      command: "new",
    });
    await respond("⚠️ Your Cue didn't answer in time — try again shortly.", false);
    return;
  }
  db.recordEvent("slack_dispatch_completed", ctx.customerId, {
    teamId: msg.teamId,
    channel: msg.channel,
    conversationKey,
    command: "new",
  });
  await respond(result.reply, true);
}
