import type { GatewayInboundEvent } from "../types.js";

/**
 * Shape of a normalized inbound email event as sent by the Vellum
 * platform (or any upstream caller).
 *
 * The platform is responsible for provider-specific parsing (e.g.
 * Mailgun multipart → JSON). By the time the payload reaches the
 * gateway it should already be in this canonical shape.
 */
export interface VellumEmailPayload {
  /** Sender email address (e.g. "user@vellum.me"). */
  from: string;
  /** Sender display name (e.g. "Alice Smith"). Optional. */
  fromName?: string;
  /** Recipient email address (the assistant's address). */
  to: string;
  /** Email subject line. */
  subject?: string;
  /** Plain-text body content (latest reply only, quoted text stripped). */
  strippedText?: string;
  /** Full plain-text body (fallback when strippedText is unavailable). */
  bodyText?: string;
  /** RFC 5322 Message-ID header value. */
  messageId: string;
  /** Message-ID of the parent message (In-Reply-To header). */
  inReplyTo?: string;
  /** Space-separated chain of ancestor Message-IDs (References header). */
  references?: string;
  /** Stable conversation/thread identifier derived by the platform. */
  conversationId: string;
  /** ISO 8601 timestamp of the original email. */
  timestamp?: string;
  /**
   * Provider SPF/DKIM/DMARC verdict for the visible `From:` address, as
   * evaluated from the receiving MTA's `Authentication-Results` header by
   * {@link evaluateSenderAuthentication}. `true` = authenticated, `false` =
   * present but spoofable, omitted = unevaluable (no signal — behavior
   * unchanged downstream).
   */
  senderAuthenticated?: boolean;
}

export interface NormalizedEmailEvent {
  event: GatewayInboundEvent;
  /** Unique event/message ID for dedup. */
  eventId: string;
  /** Original recipient address for routing. */
  recipientAddress: string;
}

/** Lowercased domain of an email address (the text after the last `@`). */
function domainOfEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) {
    return "";
  }
  return email
    .slice(at + 1)
    .trim()
    .replace(/^[<>]+|[<>]+$/g, "")
    .toLowerCase();
}

/**
 * Relaxed DMARC-style alignment between the visible `From:` domain and an
 * authenticated domain: exact match or an organizational-domain (subdomain)
 * relationship in either direction.
 */
function domainsAligned(fromDomain: string, authDomain: string): boolean {
  if (!fromDomain || !authDomain) {
    return false;
  }
  return (
    fromDomain === authDomain ||
    fromDomain.endsWith("." + authDomain) ||
    authDomain.endsWith("." + fromDomain)
  );
}

/**
 * Decide whether an inbound message's `From:` address is authentic from the
 * `Authentication-Results` header the receiving provider (Mailgun/Resend)
 * stamps after running SPF/DKIM/DMARC. Trust classification keys on the `From:`
 * address, which is trivially spoofable on its own; this binds that address to
 * real authentication so a forged sender cannot inherit guardian/trusted-contact
 * trust.
 *
 * Returns:
 *  - `true`  — DMARC passed, or (when the receiver reported no DMARC
 *              determination — `dmarc=none` or no `dmarc=` verdict at all) DKIM
 *              passed for a domain aligned with the `From:` domain.
 *  - `false` — authentication results were present but did not authenticate the
 *              `From:` address (spoofable sender). A present non-pass DMARC
 *              verdict (`fail`/`temperror`/`permerror`) is authoritative and is
 *              NOT overridden by an aligned DKIM pass — the receiver, which read
 *              the domain's own policy, declined to affirm the visible `From:`.
 *  - `undefined` — no `Authentication-Results` header, so authentication could
 *              not be evaluated (e.g. the receiving-API fetch failed). Callers
 *              omit the signal so downstream trust classification preserves
 *              existing behavior rather than downgrading every sender on missing
 *              data.
 *
 * SPF alone is intentionally NOT sufficient: it validates the envelope
 * `MAIL FROM`, not the visible `From:` header a spoofer controls.
 */
export function evaluateSenderAuthentication(args: {
  authResults: string | null | undefined;
  fromEmail: string;
}): boolean | undefined {
  const raw = args.authResults;
  if (!raw) {
    return undefined;
  }
  const results = raw.toLowerCase();

  // The receiver's DMARC verdict is authoritative for the visible RFC5322.From
  // domain: it applied that domain's own published policy (including its
  // alignment mode), which the relaxed DKIM-alignment heuristic below cannot
  // see. So honor a present verdict before falling back:
  //  - `pass` → the From: is authenticated.
  //  - `none` → the domain publishes no DMARC policy, i.e. no determination
  //    exists (materially the same as an absent header); fall through to the
  //    aligned-DKIM check, which is exactly the signal the fallback exists for.
  //  - anything else (`fail`, `temperror`, `permerror`, …) → the receiver did
  //    not affirm the From:, so we must NOT substitute our own alignment
  //    heuristic and re-authenticate a sender it declined. Fail closed.
  const dmarc = results.match(/\bdmarc=(\w+)/);
  if (dmarc) {
    const verdict = dmarc[1];
    if (verdict === "pass") {
      return true;
    }
    if (verdict !== "none") {
      return false;
    }
  }

  // Fallback: a DKIM pass whose signing domain aligns with the From: domain.
  // Reached only when the receiver made no DMARC determination (no `dmarc=`
  // token, or `dmarc=none`). Methods in Authentication-Results are
  // `;`-separated (RFC 8601), so scope each DKIM verdict to the domain in its
  // own method chunk.
  const fromDomain = domainOfEmail(args.fromEmail);
  for (const chunk of results.split(";")) {
    const dkim = chunk.match(/\bdkim=(\w+)/);
    if (!dkim || dkim[1] !== "pass") {
      continue;
    }
    for (const m of chunk.matchAll(/header\.(?:d|i)=@?([^\s;]+)/g)) {
      const authDomain = m[1].trim().replace(/>+$/, "");
      if (domainsAligned(fromDomain, authDomain)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Normalize a Vellum email webhook payload into a GatewayInboundEvent.
 *
 * Returns null if required fields are missing.
 */
export function normalizeEmailWebhook(
  payload: Record<string, unknown>,
): NormalizedEmailEvent | null {
  const from = payload.from as string | undefined;
  const to = payload.to as string | undefined;
  const messageId = payload.messageId as string | undefined;
  const conversationId = payload.conversationId as string | undefined;

  if (!from || !to || !messageId || !conversationId) {
    return null;
  }

  // Prefer strippedText (latest reply only) over full body
  const content =
    (payload.strippedText as string | undefined) ??
    (payload.bodyText as string | undefined) ??
    "";

  const fromName = payload.fromName as string | undefined;
  const senderAuthenticated =
    typeof payload.senderAuthenticated === "boolean"
      ? (payload.senderAuthenticated as boolean)
      : undefined;

  const event: GatewayInboundEvent = {
    version: "v1",
    sourceChannel: "email",
    receivedAt: new Date().toISOString(),
    message: {
      content,
      conversationExternalId: conversationId,
      externalMessageId: messageId,
    },
    actor: {
      actorExternalId: from,
      displayName: fromName || from,
      username: from,
      // Omit the key entirely when unevaluable so downstream trust logic
      // treats it as "no signal" rather than an explicit false.
      ...(senderAuthenticated !== undefined ? { senderAuthenticated } : {}),
    },
    source: {
      updateId: messageId,
    },
    raw: payload,
  };

  return {
    event,
    eventId: messageId,
    recipientAddress: to,
  };
}
