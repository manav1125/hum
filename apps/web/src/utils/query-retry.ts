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
  if (failureCount >= MAX_RETRIES) return false;
  const status = httpStatusFromError(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return true;
}

/** Capped exponential backoff: 1s, 2s, 4s, … capped at 30s. */
export function queryRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
