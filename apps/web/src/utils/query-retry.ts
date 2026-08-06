/**
 * Global TanStack Query retry policy.
 *
 * The default react-query behaviour retries every failed query 3× — including
 * `429 Too Many Requests`. Against the daemon's 300 req/min limiter that is
 * self-defeating: once a burst (window-focus refetch, reconnect, many queries
 * at once) crosses the limit, retrying the 429s keeps the request rate pinned
 * above the limit so it never recovers — a sustained 429 storm. This predicate
 * never retries rate-limited (429) or other 4xx client errors (they don't
 * self-heal), and retries only transient server (5xx) and network errors.
 *
 * Per-query `retry` options still override this default, so queries that opt
 * into `shouldRetryDaemonError` (401 auth-race, 503 startup) or `retry: false`
 * keep their own behaviour.
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/query-retries
 */

import { ApiError } from "@/utils/api-errors";

const MAX_RETRIES = 3;

/**
 * How many times a rate-limited READ may retry.
 *
 * This used to be zero, and the reasoning above was sound when it was written:
 * against a 300 req/min limiter, retrying 429s three times keeps the request
 * rate pinned above the limit and it never recovers.
 *
 * That premise is stale. The daemon's authenticated budget is now 2,000/min
 * (rate-limiter.ts raised it from 300 for exactly this reason — a multi-surface
 * SPA legitimately bursts past the old ceiling), and loopback is 5,000. What
 * survived was the client refusing to retry at all, so a single transient 429
 * during a burst is terminal and the surface renders its failure — which on
 * several pages meant an EMPTY state, i.e. a rate limit presented to the owner
 * as "you have nothing here".
 *
 * One retry cannot sustain a storm: the rate at most doubles for a single
 * round and then stops, which is the same trade `rateLimitRetry` already makes
 * for mutations and has held there. Three retries could, which is why this is
 * deliberately not `MAX_RETRIES`.
 *
 * Jitter is not decoration. A burst 429s many queries at once; without it they
 * would all retry on the same tick and rebuild the burst exactly.
 */
const MAX_RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_BASE_DELAY_MS = 1_200;
const RATE_LIMIT_JITTER_MS = 600;

/**
 * Daemon wire-format error codes → HTTP status. The generated daemon SDK
 * (HeyAPI, `throwOnError: true`) throws the *parsed error body* —
 * `{ error: { code, message } }` — which carries no `status` field, so
 * without this mapping every daemon 4xx looked like a network error and got
 * retried. Codes mirror `assistant/src/runtime/routes/errors.ts`.
 */
const DAEMON_ERROR_CODE_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RANGE_NOT_SATISFIABLE: 416,
  UNPROCESSABLE_ENTITY: 422,
  FAILED_DEPENDENCY: 424,
  RATE_LIMITED: 429,
  BAD_GATEWAY: 502,
};

/**
 * Best-effort HTTP status extraction across the error shapes our query
 * functions throw: {@link ApiError} (carries `status`), HeyAPI client errors
 * (a `status` field), `Response`-shaped errors (`response.status`), and
 * daemon error bodies (`{ error: { code } }`, mapped via
 * {@link DAEMON_ERROR_CODE_STATUS}). Returns `undefined` for network errors /
 * non-HTTP failures.
 */
export function httpStatusFromError(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (error && typeof error === "object") {
    const e = error as {
      status?: unknown;
      response?: { status?: unknown };
      error?: { code?: unknown };
    };
    if (typeof e.status === "number") return e.status;
    if (e.response && typeof e.response.status === "number") {
      return e.response.status;
    }
    if (
      e.error &&
      typeof e.error === "object" &&
      typeof e.error.code === "string"
    ) {
      return DAEMON_ERROR_CODE_STATUS[e.error.code];
    }
  }
  return undefined;
}

/**
 * Default retry predicate: never retry a 4xx (especially 429), retry transient
 * 5xx / network errors up to {@link MAX_RETRIES}.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  const status = httpStatusFromError(error);
  // Checked before the generic 4xx bail below, which would otherwise swallow
  // it: a 429 is the one 4xx that DOES self-heal, because the thing that has
  // to change is the clock.
  if (status === 429) return failureCount < MAX_RATE_LIMIT_RETRIES;
  if (failureCount >= MAX_RETRIES) return false;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return true;
}

/**
 * Capped exponential backoff: 1s, 2s, 4s, … capped at 30s.
 *
 * A rate-limited retry takes a jittered fixed delay instead, matching
 * `rateLimitRetry`'s mutation backoff — see {@link MAX_RATE_LIMIT_RETRIES}
 * for why the jitter is load-bearing.
 */
export function queryRetryDelay(attempt: number, error?: unknown): number {
  if (httpStatusFromError(error) === 429) {
    return RATE_LIMIT_BASE_DELAY_MS + Math.random() * RATE_LIMIT_JITTER_MS;
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}
