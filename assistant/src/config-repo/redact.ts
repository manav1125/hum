/**
 * Redaction for the config-as-code exporter (WS5).
 *
 * CRITICAL INVARIANT: keys/tokens/credentials must NEVER be written into the
 * exported config-repo tree. Two complementary layers enforce this:
 *
 *  1. Key-pattern blanking — any object key that *names* credential material
 *     (apiKey, token, secret, password, …) has its string value replaced
 *     wholesale, regardless of what the value looks like.
 *  2. Value-shape scrubbing — any string value (under any key, and in
 *     free-form markdown) has known secret shapes (sk-…, r8_…, whsec_…,
 *     ghp_…, AKIA…, xox…, Bearer …, JWTs, api_key=…) replaced in place.
 *
 * Both layers are pure functions with no I/O so they are trivially testable.
 */

const REDACTED = "[redacted]";

/**
 * Object keys that name credential material. Matched case-insensitively
 * against the raw key. Deliberately broad — a false positive redacts a
 * harmless value; a false negative leaks a secret.
 */
export const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|secret|token|password|passwd|credential|private[-_]?key|access[-_]?key|auth(orization)?$|bearer|signing[-_]?key|client[-_]?secret|webhook[-_]?secret|encryption[-_]?key)/i;

/**
 * Secret value shapes scrubbed out of every exported string. Sourced from the
 * execution brief's pattern list (§3 WS5) plus the common provider prefixes
 * already used across the codebase.
 */
export const SECRET_VALUE_PATTERNS: RegExp[] = [
  // Anthropic / OpenRouter / OpenAI style keys (sk-ant-…, sk-or-…, sk-…)
  /\bsk-(?:ant-|or-)?[A-Za-z0-9_-]{8,}\b/g,
  // Replicate
  /\br8_[A-Za-z0-9]{8,}\b/g,
  // Stripe webhook secrets
  /\bwhsec_[A-Za-z0-9]{8,}\b/g,
  // Stripe live/test secret keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxs-, xoxe-…)
  /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer <token>
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // JWTs (three base64url segments starting with eyJ)
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // api_key=… / apikey=… / api-key: … query/header fragments
  /\bapi[-_]?key\s*[=:]\s*[^\s&"']{6,}/gi,
];

/** Replace every known secret shape inside a string with `[redacted]`. */
export function scrubSecretsFromString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Reset lastIndex defensively — the patterns are module-level /g regexes.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact a JSON-ish value for export: blank values under secret-named
 * keys and scrub secret shapes out of every remaining string. Returns a new
 * structure; the input is never mutated.
 */
export function redactConfigValue(value: unknown): unknown {
  return redactInner(value, false);
}

function redactInner(value: unknown, underSecretKey: boolean): unknown {
  if (typeof value === "string") {
    if (underSecretKey) {
      return value.length > 0 ? REDACTED : value;
    }
    return scrubSecretsFromString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, underSecretKey));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = redactInner(inner, underSecretKey || isSecretKey(key));
    }
    return out;
  }
  // number | boolean | null | undefined — nothing to redact. A number/bool
  // under a secret key carries no credential material.
  return value;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
