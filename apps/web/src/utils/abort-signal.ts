/**
 * AbortSignal composition helpers.
 *
 * `withTimeout` folds a caller-owned cancel signal (typically TanStack
 * Query's per-fetch `signal`) together with a hard client-side deadline.
 * A request that hangs at the socket level — a suspended WKWebView
 * connection after the app returns from background is the canonical
 * case — must surface as an error the caller can retry, never as an
 * infinite in-flight fetch. This matters doubly for TanStack Query:
 * a query whose `queryFn` never settles stays in `fetching` state
 * forever, and every later `invalidateQueries`/`refetchOnMount` for the
 * same key dedupes into the hung fetch and silently does nothing.
 */

/** Caller cancel signal + a hard timeout, in one AbortSignal. */
export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : timeout;
}
