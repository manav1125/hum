/**
 * Pino log serializers that scrub sensitive data (bearer tokens, API keys,
 * authorization headers) from logged values.
 *
 * This is a standalone copy for the gateway package — kept in sync with
 * assistant/src/util/log-redact.ts.  The gateway has no dependency on the
 * assistant package, so we duplicate the lightweight serializer rather than
 * adding a cross-package import.
 */

import { PREFIX_PATTERNS } from "@vellumai/service-contracts/secret-patterns";

// ---------------------------------------------------------------------------
// Sensitive-value patterns
// ---------------------------------------------------------------------------

const BEARER_RE = /Bearer [A-Za-z0-9._\-]+/g;

/**
 * Every prefix-based secret pattern we know, sourced from the one list.
 *
 * This module used to keep its own copy, which drifted: the canonical list had
 * grown OpenRouter, Fireworks, Slack app tokens, Linear, Notion, PyPI,
 * Perplexity, Tavily and PEM private keys, and none of them were redacted in
 * gateway logs. An OpenRouter key is this product's production brain
 * credential, so the copy was silently leaking the most important one.
 *
 * The list lives in service-contracts precisely so both sides can read it.
 * Add new integrations there, not here.
 *
 * The canonical patterns carry no `g` flag by contract; `replaceAll` needs
 * one, so each is recompiled global at module load.
 */
const API_KEY_PATTERNS: RegExp[] = PREFIX_PATTERNS.map(
  (p) => new RegExp(p.regex.source, "g"),
);

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-vellum-velay-bridge-auth",
]);

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

/**
 * Redact known secret formats out of a log string.
 *
 * Exported so the coverage test can assert the gateway keeps pace with the
 * canonical pattern list — the drift this module used to have was invisible
 * precisely because nothing checked it.
 */
export function redactSecretsInString(value: string): string {
  return redactString(value);
}

function redactString(value: string): string {
  let result = value;
  result = result.replace(BEARER_RE, "Bearer [REDACTED]");
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deep value redaction
// ---------------------------------------------------------------------------

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactValue(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Error serialization — extracts non-enumerable Error fields and cause chain
// ---------------------------------------------------------------------------

function serializeError(err: unknown, depth: number): unknown {
  if (depth > 8 || err == null) return err;

  if (!(err instanceof Error)) {
    return err;
  }

  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };

  if ("code" in err && typeof (err as { code: unknown }).code === "string") {
    serialized.code = (err as { code: string }).code;
  }

  if (err.stack) {
    serialized.stack = err.stack;
  }

  if (err.cause !== undefined) {
    serialized.cause = serializeError(err.cause, depth + 1);
  }

  // Preserve any additional enumerable properties
  for (const [key, val] of Object.entries(err)) {
    if (!(key in serialized)) {
      serialized[key] = val;
    }
  }

  return serialized;
}

// ---------------------------------------------------------------------------
// Pino serializers
// ---------------------------------------------------------------------------

export const logSerializers: Record<string, (value: unknown) => unknown> = {
  err: (err) => redactValue(serializeError(err, 0), 0),
  req: (req) => redactValue(req, 0),
  res: (res) => redactValue(res, 0),
};
