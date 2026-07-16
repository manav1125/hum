/**
 * Per-peer A2A authentication.
 *
 * Inbound A2A identity used to be self-asserted (`x-a2a-sender-id` header /
 * `params.metadata.senderId`) and gated only by the trusted-contact
 * allowlist — anyone who knew a trusted peer's id could impersonate it.
 *
 * During the invite handshake we now mint a high-entropy `peerToken`, shared
 * by both sides and stored in the assistant-contact metadata. Inbound calls
 * must present it as `Authorization: Bearer <peerToken>`; we verify it against
 * the token stored for the contact matching the asserted sender id. The
 * trusted-contact allowlist remains a second, independent gate.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { findContactByAddress } from "../contacts/contact-store.js";
import type { VellumAssistantMetadata } from "../contacts/types.js";
import { getDb } from "../memory/db-connection.js";
import { assistantContactMetadata } from "../memory/schema.js";
import { eq } from "drizzle-orm";
import { getLogger } from "../util/logger.js";

const log = getLogger("a2a-peer-auth");

/** Generate a URL-safe 256-bit per-connection peer token. */
export function generatePeerToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Read the stored Vellum assistant metadata for a contact, if any.
 * Returns null when the contact has no metadata row or it fails to parse.
 */
function readVellumMetadata(contactId: string): VellumAssistantMetadata | null {
  const db = getDb();
  const row = db
    .select()
    .from(assistantContactMetadata)
    .where(eq(assistantContactMetadata.contactId, contactId))
    .get();

  if (!row || row.species !== "vellum" || !row.metadata) return null;

  try {
    return JSON.parse(row.metadata) as VellumAssistantMetadata;
  } catch {
    return null;
  }
}

/**
 * Merge a `peerToken` into a contact's Vellum assistant metadata, preserving
 * the existing `assistantId`/`gatewayUrl`. Upserts the row.
 */
export function storePeerToken(params: {
  contactId: string;
  assistantId: string;
  gatewayUrl: string;
  peerToken: string;
}): void {
  const db = getDb();
  const metadataJson = JSON.stringify({
    assistantId: params.assistantId,
    gatewayUrl: params.gatewayUrl,
    peerToken: params.peerToken,
  } satisfies VellumAssistantMetadata);

  db.insert(assistantContactMetadata)
    .values({
      contactId: params.contactId,
      species: "vellum",
      metadata: metadataJson,
    })
    .onConflictDoUpdate({
      target: assistantContactMetadata.contactId,
      set: { species: "vellum", metadata: metadataJson },
    })
    .run();
}

/**
 * Resolve the stored per-peer token for a given A2A sender address.
 * Returns null when the sender is unknown or has no token (pre-auth peer).
 */
export function getPeerTokenForSender(
  senderAssistantId: string,
): string | null {
  const contact = findContactByAddress("a2a", senderAssistantId);
  if (!contact) return null;
  const metadata = readVellumMetadata(contact.id);
  return metadata?.peerToken ?? null;
}

/** Constant-time string comparison that is safe on unequal lengths. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still perform a comparison against a same-length buffer so the early
    // return does not leak length via timing on the fast path.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export type PeerAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_token" | "unknown_sender" | "token_mismatch";
    };

/**
 * Verify a presented Bearer token against the stored per-peer token for the
 * asserted sender.
 *
 * - `missing_token`  — no Bearer token presented.
 * - `unknown_sender` — no contact/token exists for the asserted sender id.
 * - `token_mismatch` — a token was presented but did not match.
 *
 * Back-compat: a contact established before per-peer auth has no stored token,
 * so it resolves to `unknown_sender` here. Callers decide whether to allow
 * such legacy peers through the trusted-contact allowlist alone (see the
 * `allowUntokenedPeers` flag in the RPC handler) during the rollout window.
 */
export function verifyPeerToken(params: {
  senderAssistantId: string;
  presentedToken: string | null | undefined;
}): PeerAuthResult {
  const presented = params.presentedToken?.trim();
  if (!presented) return { ok: false, reason: "missing_token" };

  const stored = getPeerTokenForSender(params.senderAssistantId);
  if (!stored) {
    log.debug(
      { senderAssistantId: params.senderAssistantId },
      "No stored peer token for asserted sender",
    );
    return { ok: false, reason: "unknown_sender" };
  }

  if (!constantTimeEquals(presented, stored)) {
    return { ok: false, reason: "token_mismatch" };
  }
  return { ok: true };
}

/**
 * Parse a Bearer token out of an `Authorization` header value.
 * Returns null when the header is absent or not a Bearer scheme.
 */
export function parseBearer(
  authorization: string | null | undefined,
): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1]!.trim() : null;
}
