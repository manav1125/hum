/**
 * Slack Web API feature surface for uploads and channel metadata.
 *
 * Calls the Slack Web API directly using bot_token from the secure store,
 * eliminating the gateway HTTP proxy hop. Transport (retries, envelope
 * checking, the unified `SlackApiError`) lives in `web-api-transport.ts`.
 */

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { conversationInfo } from "./client.js";
import type {
  SlackApiResponse,
  SlackConversationInfoResponse,
} from "./types.js";
import {
  rawSlackRequest,
  type SlackRequestOptions,
} from "./web-api-transport.js";

// Re-exported for callers that import the error surface alongside the
// feature functions (e.g. runtime/routes/slack-channel-routes.ts).
export { SlackApiError, type SlackErrorCategory } from "./web-api-transport.js";

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveBotToken(): Promise<string> {
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (!botToken) {
    throw new Error("Slack bot token not configured");
  }
  return botToken;
}

// ---------------------------------------------------------------------------
// Feature surface
// ---------------------------------------------------------------------------

/** Envelope fields the outbound surfaces read off successful responses. */
interface SlackOutboundApiResponse extends SlackApiResponse {
  ts?: string;
  upload_url?: string;
  file_id?: string;
}

export interface SlackConversationInfo {
  id: string;
  name?: string;
  nameNormalized?: string;
}

/**
 * Resolve the bot token and dispatch through the shared transport.
 */
async function slackApiRequest<T extends SlackApiResponse>(
  method: string,
  opts: SlackRequestOptions,
): Promise<T> {
  const botToken = await resolveBotToken();
  return rawSlackRequest<T>(botToken, method, opts);
}

/**
 * Call a Slack Web API write method as the bot, with rate-limit retries.
 *
 * Throws SlackApiError for non-retryable Slack-level errors and for
 * transport-level failures after exhausting retries.
 */
export async function callSlackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<SlackOutboundApiResponse> {
  return slackApiRequest<SlackOutboundApiResponse>(method, { body });
}

/**
 * Call a Slack Web API method as the bot with a form-urlencoded body.
 */
export async function callSlackApiForm(
  method: string,
  params: URLSearchParams,
): Promise<SlackOutboundApiResponse> {
  return slackApiRequest<SlackOutboundApiResponse>(method, { form: params });
}

function normalizeSlackString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseSlackConversationInfo(
  data: SlackConversationInfoResponse,
): SlackConversationInfo | null {
  const id = normalizeSlackString(data.channel?.id);
  if (!id) return null;

  const name = normalizeSlackString(data.channel?.name);
  const nameNormalized = normalizeSlackString(data.channel?.name_normalized);

  return {
    id,
    ...(name ? { name } : {}),
    ...(nameNormalized ? { nameNormalized } : {}),
  };
}

/**
 * Resolve a channel's identity and display names via `conversations.info`,
 * acting as the bot.
 */
export async function getSlackConversationInfo(
  channelId: string,
): Promise<SlackConversationInfo | null> {
  const botToken = await resolveBotToken();
  return parseSlackConversationInfo(
    await conversationInfo(botToken, channelId),
  );
}

/**
 * Upload raw bytes to a Slack-provided upload URL.
 */
export async function uploadToSlackUrl(
  uploadUrl: string,
  buffer: Buffer,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buffer),
  });
  if (!response.ok) {
    throw new Error(
      `File upload to Slack failed with status ${response.status}`,
    );
  }
}

/**
 * Complete a file upload and share it to a channel.
 */
export async function completeSlackUpload(
  fileId: string,
  filename: string,
  channelId: string,
  threadTs?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    files: [{ id: fileId, title: filename }],
    channel_id: channelId,
  };
  if (threadTs) {
    body.thread_ts = threadTs;
  }
  await callSlackApi("files.completeUploadExternal", body);
}
