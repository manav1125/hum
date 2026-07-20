/**
 * Shared 429 handling for TanStack mutations (UAT 2026-07-21 P1: burst
 * mutations hit the daemon's rate limiter and surfaced as dead-end
 * "Couldn't save" errors with no retry).
 *
 * The generated HeyAPI mutation fns run with `throwOnError: true`, which
 * throws the parsed error BODY (see `client.gen.ts`): the daemon's 429 is
 * `{ error: { code: "RATE_LIMITED", message: "Too Many Requests" } }` and the
 * gateway's auth limiter is `{ error: "Too many failed attempts…" }`. Both
 * shapes are recognized here.
 *
 * Spread {@link rateLimitRetry} into a `useMutation` call to retry ONCE on a
 * rate-limited failure after a short jittered backoff. `onError` (and any
 * error UI keyed off `isError`) only fires after the retry also fails, so the
 * quiet amber "try again" lines stay accurate.
 */

/** True when a thrown mutation error is a rate-limit (429) rejection. */
export function isRateLimitedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return /too many (requests|failed attempts)/i.test(error);
  }
  if (typeof error !== "object") return false;
  const body = error as { error?: unknown };
  const inner = body.error;
  if (typeof inner === "string") {
    return /too many (requests|failed attempts)/i.test(inner);
  }
  if (inner && typeof inner === "object") {
    const code = (inner as { code?: unknown }).code;
    if (code === "RATE_LIMITED") return true;
    const message = (inner as { message?: unknown }).message;
    if (typeof message === "string" && /too many requests/i.test(message)) {
      return true;
    }
  }
  return false;
}

const RETRY_BASE_DELAY_MS = 1_200;
const RETRY_JITTER_MS = 600;

/**
 * Mutation options fragment: retry once on 429 with a jittered backoff.
 * Non-rate-limit errors never retry (a 404/validation failure won't heal).
 */
export const rateLimitRetry = {
  retry: (failureCount: number, error: unknown): boolean =>
    failureCount < 1 && isRateLimitedError(error),
  retryDelay: (): number =>
    RETRY_BASE_DELAY_MS + Math.random() * RETRY_JITTER_MS,
} as const;
