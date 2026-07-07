/**
 * Cue HQ — Slack request signature verification (WS4).
 *
 * Slack's v0 signing scheme (https://api.slack.com/authentication/verifying-requests-from-slack):
 *   base string  v0:<x-slack-request-timestamp>:<raw body>
 *   signature    "v0=" + hex(HMAC-SHA256(base, signing secret))
 * compared timing-safe against the x-slack-signature header, with a
 * timestamp tolerance window against replay (Slack recommends 5 minutes).
 *
 * Mirrors verifyStripeSignature() in stripe.ts: pure function over the raw
 * body + headers, with a signing helper for tests.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNATURE_VERSION = "v0";
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function verifySlackSignature(params: {
  rawBody: string;
  /** x-slack-request-timestamp header (seconds since epoch). */
  timestampHeader: string | null;
  /** x-slack-signature header ("v0=<hex>"). */
  signatureHeader: string | null;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): boolean {
  const {
    rawBody,
    timestampHeader,
    signatureHeader,
    secret,
    toleranceSeconds = SLACK_TIMESTAMP_TOLERANCE_SECONDS,
    nowMs = Date.now(),
  } = params;
  if (!secret || !timestampHeader || !signatureHeader) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;

  if (!signatureHeader.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) return false;
  const providedHex = signatureHeader.slice(
    SLACK_SIGNATURE_VERSION.length + 1,
  );
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;

  const expected = createHmac("sha256", secret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestampHeader}:${rawBody}`)
    .digest();
  const provided = Buffer.from(providedHex, "hex");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/** Build a valid x-slack-signature header — used by tests. */
export function signSlackPayload(
  rawBody: string,
  secret: string,
  tsSeconds: number = Math.floor(Date.now() / 1000),
): { timestamp: string; signature: string } {
  const timestamp = String(tsSeconds);
  const hex = createHmac("sha256", secret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`)
    .digest("hex");
  return { timestamp, signature: `${SLACK_SIGNATURE_VERSION}=${hex}` };
}

// ── signed OAuth state (install-link → callback round trip) ──────────────

/**
 * The OAuth `state` parameter binds an install back to the HQ customer who
 * initiated it: `<customerId>.<issuedAtMs>.<hmac>`, HMAC'd with the Slack
 * signing secret. Verified on /slack/install AND /slack/oauth/callback so a
 * forged state can never bind someone else's workspace to a customer.
 */
export function mintInstallState(
  customerId: string,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const payload = `${customerId}.${nowMs}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

const INSTALL_STATE_TTL_MS = 60 * 60_000; // links are minted on demand; 1h is plenty

export function verifyInstallState(
  state: string,
  secret: string,
  nowMs: number = Date.now(),
): { ok: true; customerId: string } | { ok: false } {
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false };
  const [customerId, issuedAtRaw, sig] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!customerId || !Number.isFinite(issuedAt)) return { ok: false };
  if (nowMs - issuedAt > INSTALL_STATE_TTL_MS || issuedAt > nowMs + 60_000) {
    return { ok: false };
  }
  const expected = createHmac("sha256", secret)
    .update(`${customerId}.${issuedAtRaw}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false };
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false };
  }
  return { ok: true, customerId };
}
