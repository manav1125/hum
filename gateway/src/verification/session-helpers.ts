/**
 * Verification session helpers for gateway-owned verification.
 *
 * Session lookup, consumption, and status checks — all via raw SQL
 * through the assistant DB IPC proxy. Dual-writes to gateway DB on
 * session consumption.
 */

import { eq } from "drizzle-orm";

import { assistantDbQuery, assistantDbRun } from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import { channelVerificationSessions as gwSessions } from "../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("verification-sessions");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationSession {
  id: string;
  challengeHash: string;
  expiresAt: number;
  status: string;
  verificationPurpose: string;
  expectedExternalUserId: string | null;
  expectedChatId: string | null;
  expectedPhoneE164: string | null;
  identityBindingStatus: string | null;
  codeDigits: number | null;
  maxAttempts: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = `
  id, challenge_hash AS challengeHash, expires_at AS expiresAt,
  status, verification_purpose AS verificationPurpose,
  expected_external_user_id AS expectedExternalUserId,
  expected_chat_id AS expectedChatId,
  expected_phone_e164 AS expectedPhoneE164,
  identity_binding_status AS identityBindingStatus,
  code_digits AS codeDigits, max_attempts AS maxAttempts
`;

/**
 * All session statuses that represent an interceptable verification session.
 *
 * Includes 'awaiting_response' — outbound text verification sessions are
 * created with this status (see assistant createOutboundSession).
 */
const INTERCEPTABLE_STATUSES = `('pending', 'pending_bootstrap', 'awaiting_response')`;

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Check whether there is any pending/active verification session for this
 * channel. Used as a fast guard before attempting code parsing + validation.
 */
export async function hasPendingOrActiveSession(
  channel: string,
): Promise<boolean> {
  const now = Date.now();
  const rows = await assistantDbQuery<{ id: string }>(
    `SELECT id FROM channel_verification_sessions
     WHERE channel = ?
       AND status IN ${INTERCEPTABLE_STATUSES}
       AND expires_at > ?
     LIMIT 1`,
    [channel, now],
  );
  return rows.length > 0;
}

/**
 * Find a session matching a specific challenge hash.
 */
export async function findSessionByHash(
  channel: string,
  challengeHash: string,
): Promise<VerificationSession | null> {
  const now = Date.now();
  const rows = await assistantDbQuery<VerificationSession>(
    `SELECT ${SESSION_COLUMNS}
     FROM channel_verification_sessions
     WHERE channel = ?
       AND challenge_hash = ?
       AND status IN ${INTERCEPTABLE_STATUSES}
       AND expires_at > ?
     LIMIT 1`,
    [channel, challengeHash, now],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Session consumption (dual-write)
// ---------------------------------------------------------------------------

/**
 * Mark a verification session as consumed. Dual-writes to both assistant
 * and gateway DBs.
 *
 * The UPDATE includes a status predicate so only the first concurrent
 * consumer wins — subsequent attempts see zero changes and return false,
 * preserving one-time-code semantics under race conditions.
 */
export async function consumeSession(
  sessionId: string,
  actorExternalUserId: string,
  actorChatId: string,
): Promise<boolean> {
  const now = Date.now();

  // Assistant DB (source of truth) — status guard ensures atomicity
  const result = await assistantDbRun(
    `UPDATE channel_verification_sessions
     SET status = 'consumed',
         consumed_by_external_user_id = ?,
         consumed_by_chat_id = ?,
         updated_at = ?
     WHERE id = ?
       AND status IN ${INTERCEPTABLE_STATUSES}`,
    [actorExternalUserId, actorChatId, now, sessionId],
  );

  if (result.changes === 0) {
    log.warn(
      { sessionId },
      "Session consume returned 0 changes — already consumed or status changed",
    );
    return false;
  }

  // Gateway DB dual-write
  try {
    const gwDb = getGatewayDb();
    gwDb
      .update(gwSessions)
      .set({
        status: "consumed",
        consumedByExternalUserId: actorExternalUserId,
        consumedByChatId: actorChatId,
        updatedAt: now,
      })
      .where(eq(gwSessions.id, sessionId))
      .run();
  } catch (gwErr) {
    log.warn(
      { err: gwErr, sessionId },
      "Gateway DB session consume dual-write failed (best-effort)",
    );
  }

  return true;
}

/**
 * Retire a session whose code was disclosed in a multi-party room.
 *
 * Refusing to redeem in the room is not enough on its own. The code has
 * already been shown to everyone present, so leaving it live means any
 * observer can carry it to a DM and redeem it there — which, for a guardian
 * session, hands them the guardian binding. Refusing without burning is
 * strictly worse than useless: it denies the legitimate owner while leaving
 * the credential valid and now public.
 *
 * Terminates as `expired` rather than `consumed`: nobody was bound, and the
 * consumed_by_* columns exist to record who redeemed. The legitimate owner
 * requests a fresh code, which is the correct cost.
 */
export async function retireSessionDisclosedInRoom(
  sessionId: string,
): Promise<void> {
  const now = Date.now();
  try {
    await assistantDbRun(
      `UPDATE channel_verification_sessions
       SET status = 'expired', updated_at = ?
       WHERE id = ?
         AND status IN ${INTERCEPTABLE_STATUSES}`,
      [now, sessionId],
    );
  } catch (err) {
    // Loud: a code disclosed in a room that we then failed to burn is the
    // exact state this exists to prevent.
    log.error(
      { err, sessionId },
      "Failed to retire a verification session disclosed in a group room; the code may still be redeemable",
    );
  }

  try {
    const gwDb = getGatewayDb();
    gwDb
      .update(gwSessions)
      .set({ status: "expired", updatedAt: now })
      .where(eq(gwSessions.id, sessionId))
      .run();
  } catch (gwErr) {
    log.warn(
      { err: gwErr, sessionId },
      "Gateway DB session retire dual-write failed (best-effort)",
    );
  }
}
