/**
 * The normalised facts the relevance gate reasons over.
 *
 * Providers speak different dialects (a Gmail payload is not a Slack payload),
 * so the gate never reads a raw provider payload. Each provider stamps the
 * fields it can honestly fill and this module flattens them into one shape.
 * A field that a provider cannot determine stays `null`/`undefined` — which
 * matters, because "unknown" and "false" pull in opposite directions: an
 * unknown thread-participation is not evidence that the owner is absent from
 * the thread, and must never be read as one.
 */

/** The shape a watcher event's `payloadJson` may carry for the gate. */
export interface ArrivalPayload {
  from?: string;
  subject?: string;
  snippet?: string;
  to?: string;
  cc?: string;
  listUnsubscribe?: string;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  inReplyTo?: string;
  references?: string;
  /** The owner is on the To: line (not merely Cc, not merely on a list). */
  toMe?: boolean;
  /** The owner is on the Cc: line only. */
  ccMe?: boolean;
  /**
   * The thread contains a message the OWNER sent. `undefined` = the provider
   * could not determine it (an API failure, or the lookup was skipped) — a
   * genuinely different state from `false`.
   */
  userParticipatedInThread?: boolean;
  [key: string]: unknown;
}

export interface ArrivalSignals {
  /** 'watcher:gmail' etc. */
  channel: string;
  /** The provider's own id for the item. */
  externalId: string;
  title: string;
  snippet: string;
  /** Lowercased sender address; null when the provider gave no address. */
  senderAddress: string | null;
  /** The sender's display name, or null. */
  senderName: string | null;
  /** True when the item carries any bulk-mail header. */
  hasListHeaders: boolean;
  /** Lowercased `Precedence:` value, when present. */
  precedence: string | null;
  /** Lowercased `Auto-Submitted:` value, when present and not 'no'. */
  autoSubmitted: string | null;
  /** The owner is a direct To: recipient. */
  directToUser: boolean;
  /** The owner is on Cc: only. */
  ccToUser: boolean;
  /** The item is a reply (it carries In-Reply-To or References). */
  isReply: boolean;
  /** See {@link ArrivalPayload.userParticipatedInThread}. */
  userParticipatedInThread: boolean | undefined;
  /**
   * True when the payload carried enough email-shaped fields to reason about
   * at all. A watcher whose events are not messages (a calendar poller, a
   * price checker) produces `false`, and the gate surfaces those untouched —
   * this filter is about mail, and guessing at other shapes is how a filter
   * starts eating things it was never asked to judge.
   */
  isMessageShaped: boolean;
}

/**
 * Pull the address out of an RFC-5322 `From:`-style value.
 * `"Jane Doe" <jane@example.com>` → `jane@example.com`.
 * Returns null when nothing address-shaped is present.
 */
export function parseAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = raw.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().replace(/^mailto:/i, "");
  // Deliberately loose: this is used for contact lookup and display, not for
  // validation. Anything with an @ and no whitespace is good enough.
  if (!/^[^\s@]+@[^\s@]+$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

/** Pull the display name out of a `From:` value, when it has one. */
export function parseDisplayName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const angled = raw.match(/^\s*(.*?)\s*<[^>]+>\s*$/);
  if (!angled) return null;
  const name = angled[1].replace(/^["']|["']$/g, "").trim();
  return name || null;
}

/** Split an address-list header (`To:`, `Cc:`) into lowercased addresses. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => parseAddress(part))
    .filter((a): a is string => a != null);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Flatten a watcher event's payload into the gate's input shape.
 *
 * `title` and `snippet` come from the event itself (every provider has them);
 * everything else is best-effort off the payload.
 */
export function buildArrivalSignals(args: {
  channel: string;
  externalId: string;
  title: string;
  summary: string;
  payloadJson: string;
}): ArrivalSignals {
  let payload: ArrivalPayload = {};
  try {
    const parsed: unknown = JSON.parse(args.payloadJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as ArrivalPayload;
    }
  } catch {
    // A payload we cannot read gives us no signals; the gate then has no
    // grounds to file, which is the correct direction to fail in.
  }

  const from = str(payload.from);
  const listUnsubscribe = str(payload.listUnsubscribe);
  const listId = str(payload.listId);
  const precedenceRaw = str(payload.precedence)?.toLowerCase() ?? null;
  const autoSubmittedRaw = str(payload.autoSubmitted)?.toLowerCase() ?? null;

  return {
    channel: args.channel,
    externalId: args.externalId,
    title: args.title,
    snippet: str(payload.snippet) ?? args.summary,
    senderAddress: parseAddress(from),
    senderName: parseDisplayName(from),
    hasListHeaders: Boolean(listUnsubscribe || listId),
    precedence: precedenceRaw,
    // `Auto-Submitted: no` is the RFC-3834 way of saying "a human sent this",
    // so it must not be read as a machine-mail marker.
    autoSubmitted:
      autoSubmittedRaw && autoSubmittedRaw !== "no" ? autoSubmittedRaw : null,
    directToUser: payload.toMe === true,
    ccToUser: payload.ccMe === true,
    isReply: Boolean(str(payload.inReplyTo) || str(payload.references)),
    userParticipatedInThread:
      typeof payload.userParticipatedInThread === "boolean"
        ? payload.userParticipatedInThread
        : undefined,
    isMessageShaped: from != null,
  };
}
