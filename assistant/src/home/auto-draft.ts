/**
 * Auto-draft replies.
 *
 * Composes a reply to an email in the user's voice and saves it to Gmail
 * Drafts (threaded, never sent) so the user only has to review and hit send.
 * This is the write-side companion to the daily action board: where the board
 * flags "this email needs a reply", this turns that into a ready-to-send
 * draft.
 *
 * Everything runs through the connector layer (Composio-backed): we GET the
 * message metadata, have the model compose a reply, build an RFC-822 message
 * with proper threading headers, and POST it to the Drafts collection. Nothing
 * is ever sent — drafts are inert until the user sends them — so this is safe
 * to run on the user's behalf.
 */

import type { OAuthConnection } from "../oauth/connection.js";
import { resolveOAuthConnection } from "../oauth/connection-resolver.js";
import {
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("auto-draft");

const GMAIL_BASE = "https://gmail.googleapis.com";

export interface DraftReplyResult {
  ok: boolean;
  draftId?: string;
  threadId?: string;
  to?: string;
  subject?: string;
  error?: string;
}

interface MessageHeaders {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  references: string;
}

const SYSTEM_PROMPT = `You draft email replies on behalf of the user. Write a complete, ready-to-send reply to the email below.

Rules:
- Match a professional but natural tone; concise and to the point.
- Address the sender's actual asks/questions directly.
- Do NOT invent facts, commitments, dates, numbers, or attachments you don't have. If something needs the user's input, leave a short bracketed placeholder like [confirm date].
- Output ONLY the reply body text — no subject line, no "Here's a draft", no quoting the original, no signature block unless a simple sign-off ("Best, …") fits naturally.`;

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  const found = headers?.find(
    (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

/** Extract a bare email address from a header like `Jane Doe <jane@x.com>`. */
function bareAddress(headerValueRaw: string): string {
  const match = headerValueRaw.match(/<([^>]+)>/);
  return (match ? match[1] : headerValueRaw).trim();
}

/** Base64url-encode a UTF-8 string (Gmail `raw` wants URL-safe base64). */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Encode a header value containing non-ASCII as RFC 2047, else pass through. */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

async function fetchMessage(
  conn: OAuthConnection,
  messageId: string,
): Promise<{
  headers: MessageHeaders;
  snippet: string;
  threadId: string;
} | null> {
  const res = await conn.request({
    method: "GET",
    baseUrl: GMAIL_BASE,
    path: `/gmail/v1/users/me/messages/${messageId}`,
    query: {
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Message-ID", "References"],
    },
  });
  if (res.status >= 400) {
    log.warn({ status: res.status, messageId }, "Gmail message fetch failed");
    return null;
  }
  const body = res.body as {
    threadId?: string;
    snippet?: string;
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  };
  const h = body.payload?.headers;
  return {
    threadId: body.threadId ?? "",
    snippet: body.snippet ?? "",
    headers: {
      from: headerValue(h, "From"),
      to: headerValue(h, "To"),
      subject: headerValue(h, "Subject"),
      messageId: headerValue(h, "Message-ID"),
      references: headerValue(h, "References"),
    },
  };
}

async function composeReply(
  headers: MessageHeaders,
  snippet: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const provider = await getConfiguredProvider("autoDraft");
  if (!provider) {
    log.warn("No provider configured for autoDraft");
    return null;
  }
  const context = [
    `From: ${headers.from}`,
    `Subject: ${headers.subject}`,
    "",
    `Email content:`,
    snippet,
  ].join("\n");

  const response = await provider.sendMessage([userMessage(context)], {
    systemPrompt: SYSTEM_PROMPT,
    signal,
    config: { callSite: "autoDraft" as const },
  });
  const text = extractText(response).trim();
  return text.length > 0 ? text : null;
}

/**
 * Build a draft reply to the given Gmail message and save it to Drafts.
 * Never sends. Returns the draft id on success.
 */
export async function draftReplyForMessage(
  messageId: string,
  opts?: { signal?: AbortSignal },
): Promise<DraftReplyResult> {
  let conn: OAuthConnection;
  try {
    conn = await resolveOAuthConnection("google");
  } catch (err) {
    return { ok: false, error: `Google not connected: ${String(err)}` };
  }

  const msg = await fetchMessage(conn, messageId);
  if (!msg) return { ok: false, error: "Could not load the message." };

  const replyBody = await composeReply(msg.headers, msg.snippet, opts?.signal);
  if (!replyBody) return { ok: false, error: "Could not compose a reply." };

  const to = bareAddress(msg.headers.from);
  const subject = msg.headers.subject.replace(/^\s*(re:\s*)+/i, "");
  const replySubject = `Re: ${subject}`;
  // Thread the reply: In-Reply-To the original, and append it to References.
  const references = [msg.headers.references, msg.headers.messageId]
    .filter(Boolean)
    .join(" ");

  const mime = [
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(replySubject)}`,
    ...(msg.headers.messageId ? [`In-Reply-To: ${msg.headers.messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
    "",
    replyBody,
  ].join("\r\n");

  const create = await conn.request({
    method: "POST",
    baseUrl: GMAIL_BASE,
    path: "/gmail/v1/users/me/drafts",
    headers: { "Content-Type": "application/json" },
    body: {
      message: {
        threadId: msg.threadId || undefined,
        raw: base64UrlEncode(mime),
      },
    },
    signal: opts?.signal,
  });

  if (create.status >= 400) {
    log.warn({ status: create.status, messageId }, "Draft create failed");
    return { ok: false, error: `Draft create failed (HTTP ${create.status}).` };
  }
  const draft = create.body as { id?: string; message?: { threadId?: string } };
  log.info(
    { draftId: draft.id, messageId, to },
    "Auto-draft reply created in Gmail Drafts",
  );
  return {
    ok: true,
    draftId: draft.id,
    threadId: draft.message?.threadId ?? msg.threadId,
    to,
    subject: replySubject,
  };
}
