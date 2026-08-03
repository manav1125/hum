/**
 * Gmail watcher provider — uses the History API for efficient change detection.
 *
 * On first poll, captures the current historyId as the watermark (start from "now").
 * Subsequent polls use history.list with historyTypes=messageAdded to detect new messages.
 * Falls back to listing recent unread messages if the historyId has expired (404).
 */

import { parseAddressList } from "../../arrivals/arrival-signals.js";
import {
  batchGetMessages,
  getProfile,
  getThread,
  listMessages,
} from "../../messaging/providers/gmail/client.js";
import type { GmailMessage } from "../../messaging/providers/gmail/types.js";
import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:gmail");

/**
 * The headers the relevance gate reads.
 *
 * `format=metadata` returns ONLY the headers named here — asking for
 * `["From", "Subject", "Date"]` and then reasoning about `List-Unsubscribe`
 * would be reasoning about a header Gmail never sent, and every message would
 * look like personal mail. The bulk-mail signals (`List-Unsubscribe`,
 * `List-Id`, `Precedence`) and the machine-mail signal (`Auto-Submitted`,
 * RFC 3834) are the cheap deterministic layer; `To`/`Cc` power the
 * direct-recipient safety floor; `In-Reply-To`/`References` mark a reply,
 * which is what makes the thread-participation lookup affordable.
 */
const GATE_HEADERS = [
  "From",
  "Subject",
  "Date",
  "To",
  "Cc",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "In-Reply-To",
  "References",
];

/**
 * Cap on thread lookups per poll. Thread participation is the strongest
 * safety-floor signal there is, but it costs one API call per thread, so it is
 * bounded — and running out of budget leaves the flag `undefined` ("unknown"),
 * never `false`. Unknown is not evidence of absence; it simply means the other
 * floor rules and the judge decide, and both bias toward surfacing.
 */
const MAX_THREAD_LOOKUPS_PER_POLL = 25;

/** Gmail History API response types */
interface HistoryMessage {
  id: string;
  threadId: string;
}

interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: HistoryMessage }>;
}

interface HistoryListResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

function extractHeader(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

/**
 * Facts about the mailbox owner that the per-message mapping needs. Resolved
 * once per poll rather than per message.
 */
interface MailboxContext {
  /** The owner's own lowercased address; null when the profile call failed. */
  selfAddress: string | null;
  /** threadId → "the owner sent something in this thread". */
  threadParticipation: Map<string, boolean>;
}

function messageToItem(msg: GmailMessage, ctx: MailboxContext): WatcherItem {
  const from = extractHeader(msg, "From");
  const subject = extractHeader(msg, "Subject");
  const date = extractHeader(msg, "Date");
  const to = extractHeader(msg, "To");
  const cc = extractHeader(msg, "Cc");
  const inReplyTo = extractHeader(msg, "In-Reply-To");
  const references = extractHeader(msg, "References");

  // `toMe`/`ccMe` are only meaningful if we know who "me" is. With no profile
  // they stay false, which removes the direct-recipient floor rule but leaves
  // every other protection standing — a missing signal must never become a
  // reason to file something.
  const toList = parseAddressList(to);
  const ccList = parseAddressList(cc);
  const self = ctx.selfAddress;

  return {
    externalId: msg.id,
    eventType: "new_email",
    summary: `Email from ${from}: ${subject}`,
    payload: {
      id: msg.id,
      // The CONVERSATION id, not the message id — and it is load-bearing, not
      // decoration. `externalId` above is per-message, so without this two
      // replies in one conversation become two unrelated work items and the
      // owner reads the same thread twice. Grouping keys off this
      // (`arrivals/arrival-grouping.ts`); an empty value means "no thread",
      // which simply makes the arrival ineligible for thread grouping.
      threadId: msg.threadId ?? "",
      from,
      subject,
      date,
      snippet: msg.snippet ?? "",
      labelIds: msg.labelIds ?? [],
      // --- Relevance-gate signals (318) ---
      to,
      cc,
      listUnsubscribe: extractHeader(msg, "List-Unsubscribe"),
      listId: extractHeader(msg, "List-Id"),
      precedence: extractHeader(msg, "Precedence"),
      autoSubmitted: extractHeader(msg, "Auto-Submitted"),
      inReplyTo,
      references,
      toMe: self != null && toList.includes(self),
      ccMe: self != null && !toList.includes(self) && ccList.includes(self),
      ...(ctx.threadParticipation.has(msg.threadId)
        ? {
            userParticipatedInThread: ctx.threadParticipation.get(msg.threadId),
          }
        : {}),
    },
    timestamp: msg.internalDate ? parseInt(msg.internalDate, 10) : null,
  };
}

/** A message that carries reply headers is worth a thread lookup. */
function isReply(msg: GmailMessage): boolean {
  return Boolean(
    extractHeader(msg, "In-Reply-To") || extractHeader(msg, "References"),
  );
}

/**
 * For each replied-to thread among these messages, determine whether the owner
 * ever sent into it (Gmail stamps their own messages with the SENT label).
 *
 * Bounded and best-effort: a thread we could not read is simply absent from
 * the map, which the gate reads as "unknown" rather than "no".
 */
async function resolveThreadParticipation(
  connection: OAuthConnection,
  messages: GmailMessage[],
): Promise<Map<string, boolean>> {
  const participation = new Map<string, boolean>();
  const threadIds: string[] = [];
  for (const msg of messages) {
    if (!isReply(msg)) continue;
    if (!msg.threadId || threadIds.includes(msg.threadId)) continue;
    threadIds.push(msg.threadId);
    if (threadIds.length >= MAX_THREAD_LOOKUPS_PER_POLL) break;
  }
  if (threadIds.length === 0) return participation;

  await Promise.all(
    threadIds.map(async (threadId) => {
      try {
        const thread = await getThread(connection, threadId, "metadata", [
          "From",
        ]);
        const participated = (thread.messages ?? []).some((m) =>
          m.labelIds?.includes("SENT"),
        );
        participation.set(threadId, participated);
      } catch (err) {
        // Leave the thread out of the map entirely: "unknown", not "no".
        log.debug(
          { err: String(err), threadId },
          "Gmail: thread participation lookup failed (treated as unknown)",
        );
      }
    }),
  );
  return participation;
}

/**
 * Build the per-poll mailbox context. A failed profile call degrades the
 * direct-recipient floor rule to off rather than failing the poll.
 */
async function buildMailboxContext(
  connection: OAuthConnection,
  messages: GmailMessage[],
): Promise<MailboxContext> {
  let selfAddress: string | null = null;
  try {
    const profile = await getProfile(connection);
    selfAddress = profile.emailAddress?.toLowerCase() ?? null;
  } catch (err) {
    log.debug(
      { err: String(err) },
      "Gmail: could not resolve the mailbox owner's own address",
    );
  }
  const threadParticipation = await resolveThreadParticipation(
    connection,
    messages,
  );
  return { selfAddress, threadParticipation };
}

async function fetchHistory(
  connection: OAuthConnection,
  startHistoryId: string,
): Promise<HistoryListResponse> {
  const query: Record<string, string> = {
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "100",
  };

  const resp = await connection.request({
    method: "GET",
    path: "/history",
    query,
  });

  if (resp.status === 404) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new HistoryExpiredError(body);
  }

  if (resp.status < 200 || resp.status >= 300) {
    const body =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new Error(`Gmail History API ${resp.status}: ${body}`);
  }

  return resp.body as HistoryListResponse;
}

class HistoryExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryExpiredError";
  }
}

export const gmailProvider: WatcherProvider = {
  id: "gmail",
  displayName: "Gmail",
  requiredCredentialService: "google",

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService);
    const profile = await getProfile(connection);
    if (!profile.historyId) {
      throw new Error("Gmail profile did not return a historyId");
    }
    return profile.historyId;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark — get initial position, return no items
      const profile = await getProfile(connection);
      return { items: [], watermark: profile.historyId ?? "0" };
    }

    try {
      const historyResp = await fetchHistory(connection, watermark);
      const newWatermark = historyResp.historyId ?? watermark;

      if (!historyResp.history || historyResp.history.length === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Collect unique new message IDs
      const messageIds = new Set<string>();
      for (const record of historyResp.history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            messageIds.add(added.message.id);
          }
        }
      }

      if (messageIds.size === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Fetch metadata for new messages
      const messages = await batchGetMessages(
        connection,
        Array.from(messageIds),
        "metadata",
        GATE_HEADERS,
      );

      // Only include INBOX messages (skip sent, drafts, etc.)
      const inboxMessages = messages.filter((m) =>
        m.labelIds?.includes("INBOX"),
      );

      const ctx = await buildMailboxContext(connection, inboxMessages);
      const items = inboxMessages.map((m) => messageToItem(m, ctx));
      log.info(
        { count: items.length, watermark: newWatermark },
        "Gmail: fetched new messages",
      );

      return { items, watermark: newWatermark };
    } catch (err) {
      if (err instanceof HistoryExpiredError) {
        log.warn(
          "Gmail historyId expired, falling back to recent unread messages",
        );
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when historyId expires: list recent unread inbox messages.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const listResp = await listMessages(
    connection,
    "is:unread newer_than:1d",
    20,
    undefined,
    ["INBOX"],
  );

  if (!listResp.messages || listResp.messages.length === 0) {
    const profile = await getProfile(connection);
    return { items: [], watermark: profile.historyId ?? "0" };
  }

  const messages = await batchGetMessages(
    connection,
    listResp.messages.map((m) => m.id),
    "metadata",
    GATE_HEADERS,
  );

  const ctx = await buildMailboxContext(connection, messages);
  const items = messages.map((m) => messageToItem(m, ctx));

  // Get fresh historyId for the new watermark
  const profile = await getProfile(connection);
  return { items, watermark: profile.historyId ?? "0" };
}
