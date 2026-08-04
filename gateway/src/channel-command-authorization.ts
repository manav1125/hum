/**
 * Fail-closed authorization for gateway-terminal channel commands.
 *
 * Commands that the gateway handles without forwarding to the runtime
 * (`/new` conversation resets, Slack thread mute/detach) bypass the
 * assistant-side ingress ACL, so they need their own admission check.
 * This module decides allow/deny from the same contact-channel store the
 * assistant's `enforceIngressAcl` reads (the assistant DB, reached via the
 * IPC SQL proxy).
 *
 * Decision table:
 * - active contact channel (including the guardian's binding) → ALLOW
 * - no contact-channel row for the actor                       → DENY
 * - status blocked / revoked / pending / unverified / other    → DENY
 * - missing/empty actor id                                     → DENY
 * - lookup error, timeout, or unreachable store                → DENY
 *
 * Denials are intentionally silent on the channel: callers must not send a
 * rejection reply (a reply would be a membership oracle). Every denial is
 * logged at info with structured fields instead.
 */

import type { Logger } from "pino";

import { assistantDbQuery } from "./db/assistant-db-proxy.js";
import { canonicalizeInboundIdentity } from "./verification/identity.js";

/** Hard ceiling on the contact lookup — a slow store must deny, not allow. */
const LOOKUP_TIMEOUT_MS = 5000;

const LOOKUP_TIMED_OUT = Symbol("channel-command-lookup-timed-out");

export interface ChannelCommandDecision {
  allowed: boolean;
  reason: string;
}

interface ActorChannelRow {
  status: string;
  role: string | null;
}

async function withLookupTimeout<T>(
  promise: Promise<T>,
): Promise<T | typeof LOOKUP_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (result === LOOKUP_TIMED_OUT) {
      // The lookup lost the race — swallow its eventual rejection so it
      // cannot surface as an unhandled rejection later.
      promise.catch(() => {});
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Find the actor's contact-channel row for a channel. Mirrors the row
 * selection used by `upsertContactChannel` (address-match preferred, then
 * best status) so the gate decides on the same row the seeding path treats
 * as canonical for this identity.
 */
async function lookupActorChannel(
  sourceChannel: string,
  actorExternalId: string,
): Promise<ActorChannelRow | null> {
  const canonicalUserId =
    canonicalizeInboundIdentity(sourceChannel, actorExternalId) ??
    actorExternalId.trim();
  const address =
    sourceChannel === "slack" ? canonicalUserId : canonicalUserId.toLowerCase();

  const rows = await assistantDbQuery<ActorChannelRow>(
    `SELECT cc.status AS status, c.role AS role
     FROM contact_channels cc
     JOIN contacts c ON c.id = cc.contact_id
     WHERE cc.type = ? AND (cc.address = ? OR cc.external_user_id = ?)
     ORDER BY
       CASE WHEN cc.address = ? THEN 0 ELSE 1 END,
       CASE cc.status
         WHEN 'active' THEN 0
         WHEN 'unverified' THEN 1
         ELSE 2
       END,
       cc.updated_at DESC
     LIMIT 1`,
    [sourceChannel, address, canonicalUserId, address],
  );
  return rows[0] ?? null;
}

/**
 * Decide whether an actor may run a gateway-terminal channel command.
 *
 * Fail closed: only a positively identified active contact (which includes
 * the guardian's own active channel binding) is allowed. Any failure to
 * reach a decision — missing actor, unknown actor, non-active status,
 * lookup error, or timeout — denies.
 *
 * Callers must keep denials silent on the channel; this function logs the
 * denial with structured fields.
 */
export async function authorizeChannelCommand(params: {
  sourceChannel: string;
  actorExternalId: string;
  command: string;
  logger: Logger;
}): Promise<ChannelCommandDecision> {
  const { sourceChannel, actorExternalId, command, logger } = params;

  const deny = (
    reason: string,
    extra?: Record<string, unknown>,
  ): ChannelCommandDecision => {
    logger.info(
      {
        sourceChannel,
        actorExternalId,
        command,
        decision: "deny",
        reason,
        ...extra,
      },
      "Channel command denied",
    );
    return { allowed: false, reason };
  };

  if (!actorExternalId || actorExternalId.trim().length === 0) {
    return deny("missing_actor");
  }

  let row: ActorChannelRow | null | typeof LOOKUP_TIMED_OUT;
  try {
    row = await withLookupTimeout(
      lookupActorChannel(sourceChannel, actorExternalId),
    );
  } catch (err) {
    return deny("lookup_failed", { err });
  }

  if (row === LOOKUP_TIMED_OUT) return deny("lookup_timeout");
  if (row === null) return deny("unknown_actor");
  if (row.status !== "active") return deny(`status_${row.status}`);

  return {
    allowed: true,
    reason: row.role === "guardian" ? "guardian" : "active_contact",
  };
}
