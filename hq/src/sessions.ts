/**
 * Cue HQ — website sessions (the customer-facing /account surface).
 *
 * Sign-in is an emailed one-time link (`POST /signin` → email → `GET
 * /auth?token=…`), which sets a signed, httpOnly session cookie good for
 * 30 days. That is how every ordinary customer gets in, and the only way
 * they can: no customer has a password.
 *
 * The one exception is an account that cannot reach a mailbox at all —
 * today that means the App Review demo account. Such an account carries an
 * argon2id hash in `customers.signinPasswordHash` (migration 9) and is
 * asked for a password instead of being emailed a link. The hash-verify
 * helpers for that path are at the bottom of this file.
 *
 * Two token kinds live here:
 *   - one-time sign-in tokens: 32 random bytes, stored as a SHA-256 hash
 *     in `signin_tokens` (db.ts), 15-minute TTL, consumed exactly once.
 *   - the session cookie: stateless `v1.<customerId>.<exp>.<hmac>` signed
 *     with HQ_SESSION_SECRET — no server-side session table.
 *
 * Env contract:
 *   HQ_SESSION_SECRET — HMAC key for session cookies. Unset ⇒ the site
 *   auth routes respond 503 (nothing throws at boot).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "cue_hq_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SIGNIN_TOKEN_TTL_MS = 15 * 60_000; // 15 minutes

export function isSessionConfigured(): boolean {
  return !!process.env.HQ_SESSION_SECRET;
}

function secret(): string {
  const s = process.env.HQ_SESSION_SECRET;
  if (!s) throw new Error("HQ_SESSION_SECRET not configured");
  return s;
}

// ── one-time sign-in tokens ──────────────────────────────────────────────

/** Generate a raw sign-in token (goes into the email link, never stored). */
export function generateSigninToken(): string {
  return randomBytes(32).toString("hex");
}

/** The stored form of a sign-in token. */
export function hashSigninToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// ── direct sign-in passwords (the mailbox-less exception) ────────────────

/** Shortest password we will store. Long enough that argon2id is not the
 *  only thing standing between an account and a guess. */
export const MIN_SIGNIN_PASSWORD_LENGTH = 12;

/**
 * Hash a direct sign-in password (argon2id, Bun's default parameters).
 * Throws on a password below the minimum length so a weak one can never be
 * written by an operator typo.
 */
export async function hashSigninPassword(password: string): Promise<string> {
  if (password.length < MIN_SIGNIN_PASSWORD_LENGTH) {
    throw new Error(
      `password must be at least ${MIN_SIGNIN_PASSWORD_LENGTH} characters`,
    );
  }
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/**
 * Verify a password against a stored hash. Never throws: a malformed or
 * truncated hash returns false rather than 500-ing the sign-in route.
 */
export async function verifySigninPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// ── stateless signed session cookie ──────────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mint the cookie *value*: `v1.<customerId-b64url>.<expEpochSec>.<sig>`. */
export function mintSessionValue(
  customerId: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const body = `v1.${Buffer.from(customerId, "utf-8").toString("base64url")}.${exp}`;
  return `${body}.${sign(body)}`;
}

/** Verify a cookie value → customerId, or null (bad sig / expired / malformed). */
export function verifySessionValue(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!value || !isSessionConfigured()) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [v, id64, expStr, sig] = parts;
  const body = `${v}.${id64}.${expStr}`;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
  try {
    return Buffer.from(id64, "base64url").toString("utf-8") || null;
  } catch {
    return null;
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

/** Build the Set-Cookie header for a fresh session. */
export function sessionSetCookieHeader(
  value: string,
  opts: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds ?? SESSION_TTL_SECONDS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Read one cookie off a request (no dependency on a cookie lib). */
export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Resolve the authed customerId from a request's session cookie. */
export function customerIdFromRequest(req: Request): string | null {
  return verifySessionValue(getCookie(req, SESSION_COOKIE_NAME));
}

/**
 * CSRF guard for cookie-authed mutations: SameSite=Lax already blocks
 * cross-site POSTs in modern browsers; as defence in depth, when an Origin
 * header is present it must match the request host.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches + curl omit it
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
