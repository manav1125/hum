/**
 * Direct APNs sender — token-based auth (.p8 signing key) with ES256 JWTs,
 * POSTing alerts to `api.push.apple.com/3/device/{token}`.
 *
 * Transport: APNs only speaks HTTP/2, and Bun's `fetch` negotiates
 * HTTP/1.1, so this module uses the `node:http2` client (implemented by
 * Bun) with a short-lived session per send. Push volume is a handful of
 * alerts per day, so connection reuse is not worth the keep-alive
 * bookkeeping Apple requires for pooled sessions.
 *
 * Configuration comes entirely from env (see config/env-registry.ts):
 * CUE_APNS_KEY_P8 / CUE_APNS_KEY_PATH, CUE_APNS_KEY_ID, CUE_APNS_TEAM_ID,
 * CUE_APNS_BUNDLE_ID, CUE_APNS_ENV. When no key is configured the sender
 * degrades to a silent no-op — `logApnsStartupStatus()` emits a single
 * boot-time info line either way so operators can tell which mode they
 * are in without grepping for absence of errors.
 *
 * JWTs are cached and reminted every 45 minutes (Apple accepts tokens
 * between 20 and 60 minutes old).
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, constants as http2Constants } from "node:http2";

import {
  getApnsBundleId,
  getApnsEnv,
  getApnsKeyId,
  getApnsKeyP8,
  getApnsKeyPath,
  getApnsTeamId,
} from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("apns-sender");

// Apple requires provider tokens to be 20–60 minutes old. Remint at 45.
const JWT_MAX_AGE_MS = 45 * 60 * 1000;

/** Per-request deadline covering connect + request + response. */
const SEND_TIMEOUT_MS = 10_000;

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

// ── Config resolution ─────────────────────────────────────────────────

export interface ApnsConfig {
  /** PEM contents of the .p8 signing key. */
  keyPem: string;
  /** 10-character Key ID (JWT `kid` header). */
  keyId: string;
  /** Apple Developer Team ID (JWT `iss` claim). */
  teamId: string;
  /** iOS bundle id (`apns-topic` header). */
  bundleId: string;
  env: "sandbox" | "production";
}

/**
 * Resolve the APNs configuration from env, or null when incomplete.
 * Reads the key file lazily so a bad path degrades to "not configured"
 * (with a warning) instead of throwing into callers.
 */
export function resolveApnsConfig(): ApnsConfig | null {
  const keyId = getApnsKeyId();
  const teamId = getApnsTeamId();
  if (!keyId || !teamId) return null;

  let keyPem = getApnsKeyP8();
  if (!keyPem) {
    const keyPath = getApnsKeyPath();
    if (!keyPath) return null;
    try {
      keyPem = readFileSync(keyPath, "utf-8");
    } catch (err) {
      log.warn(
        { err: String(err), keyPath },
        "CUE_APNS_KEY_PATH is set but the key file could not be read — APNs push disabled",
      );
      return null;
    }
  }

  return {
    keyPem,
    keyId,
    teamId,
    bundleId: getApnsBundleId(),
    env: getApnsEnv(),
  };
}

export function isApnsConfigured(): boolean {
  return resolveApnsConfig() !== null;
}

/**
 * Emit the one boot-time status line. Call once from daemon startup —
 * never throws.
 */
export function logApnsStartupStatus(): void {
  try {
    const config = resolveApnsConfig();
    if (config) {
      log.info(
        { env: config.env, bundleId: config.bundleId, keyId: config.keyId },
        "APNs push sender configured",
      );
    } else {
      log.info(
        "APNs push not configured (set CUE_APNS_KEY_P8 or CUE_APNS_KEY_PATH + CUE_APNS_KEY_ID + CUE_APNS_TEAM_ID) — iOS push notifications disabled",
      );
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Failed to resolve APNs startup status");
  }
}

// ── JWT ───────────────────────────────────────────────────────────────

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mint an APNs provider JWT: ES256 over `{alg, kid}.{iss, iat}`.
 *
 * ES256 signatures must be in raw IEEE P1363 form (r||s, 64 bytes), not
 * the DER form node produces by default — hence `dsaEncoding`.
 *
 * Exported for unit tests; production callers go through the caching
 * wrapper inside `sendApnsAlert`.
 */
export function createApnsJwt(
  config: Pick<ApnsConfig, "keyPem" | "keyId" | "teamId">,
  nowMs: number = Date.now(),
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64url(
    JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(config.keyPem);
  const signature = sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

let cachedJwt: { token: string; mintedAt: number; keyId: string } | null = null;

function getProviderJwt(config: ApnsConfig): string {
  const now = Date.now();
  if (
    cachedJwt &&
    cachedJwt.keyId === config.keyId &&
    now - cachedJwt.mintedAt < JWT_MAX_AGE_MS
  ) {
    return cachedJwt.token;
  }
  const token = createApnsJwt(config, now);
  cachedJwt = { token, mintedAt: now, keyId: config.keyId };
  return token;
}

// ── Send ──────────────────────────────────────────────────────────────

export interface ApnsAlert {
  title: string;
  body: string;
  /** Collapses replacement pushes; maps to `apns-collapse-id`. */
  collapseId?: string;
  /** Groups notifications in the iOS notification center. */
  threadId?: string;
  /** Custom payload keys delivered alongside `aps` (deep-link metadata). */
  data?: Record<string, unknown>;
}

/**
 * Build the APNs JSON payload for an alert. Custom `data` keys are spread
 * at the TOP LEVEL next to `aps` — that placement is the wire contract
 * with the iOS shell: `CueNotificationRouter.deepLinkURL` reads
 * `userInfo["path"]` (and friends) directly off the payload root, not from
 * a nested container. Exported for the contract test.
 */
export function buildApnsPayload(alert: ApnsAlert): Record<string, unknown> {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      ...(alert.threadId ? { "thread-id": alert.threadId } : {}),
    },
    ...(alert.data ?? {}),
  };
}

export type ApnsSendResult =
  | { ok: true }
  | {
      ok: false;
      /** "not_configured" | HTTP status reason from APNs | transport error. */
      reason: string;
      status?: number;
      /**
       * True when APNs reported the device token as permanently invalid
       * (410 Unregistered / 400 BadDeviceToken) — callers should drop the
       * token from the registry.
       */
      tokenInvalid?: boolean;
    };

/**
 * Send one alert push to one device token. Resolves (never rejects) with
 * a structured result — callers decide whether to log or prune tokens.
 */
export async function sendApnsAlert(
  deviceToken: string,
  alert: ApnsAlert,
): Promise<ApnsSendResult> {
  const config = resolveApnsConfig();
  if (!config) {
    return { ok: false, reason: "not_configured" };
  }

  let jwt: string;
  try {
    jwt = getProviderJwt(config);
  } catch (err) {
    log.warn(
      { err: String(err) },
      "Failed to mint APNs provider JWT — check the .p8 key material",
    );
    return { ok: false, reason: `jwt_mint_failed: ${String(err)}` };
  }

  const body = JSON.stringify(buildApnsPayload(alert));

  return await new Promise<ApnsSendResult>((resolve) => {
    let settled = false;
    const finish = (result: ApnsSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.close();
      resolve(result);
    };

    const session = connect(APNS_HOSTS[config.env]);
    const timeout = setTimeout(() => {
      session.destroy();
      finish({ ok: false, reason: "timeout" });
    }, SEND_TIMEOUT_MS);

    session.on("error", (err) => {
      finish({ ok: false, reason: `session_error: ${String(err)}` });
    });

    const request = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      [http2Constants.HTTP2_HEADER_AUTHORITY]: new URL(APNS_HOSTS[config.env])
        .host,
      authorization: `bearer ${jwt}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      ...(alert.collapseId ? { "apns-collapse-id": alert.collapseId } : {}),
      "content-type": "application/json",
    });

    let status = 0;
    request.on("response", (headers) => {
      status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
    });

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (status === 200) {
        finish({ ok: true });
        return;
      }
      let reason = `http_${status}`;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          reason?: string;
        };
        if (parsed.reason) reason = parsed.reason;
      } catch {
        // Non-JSON error body — keep the status-based reason.
      }
      const tokenInvalid =
        status === 410 ||
        reason === "BadDeviceToken" ||
        reason === "DeviceTokenNotForTopic" ||
        reason === "Unregistered";
      finish({ ok: false, reason, status, tokenInvalid });
    });
    request.on("error", (err) => {
      finish({ ok: false, reason: `request_error: ${String(err)}` });
    });

    request.end(body);
  });
}
