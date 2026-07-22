/**
 * The deliberate abort used to no-op platform-bound requests in local mode.
 *
 * Lives in its own module — free of the client-registration side effects in
 * `api-interceptors.ts` — so consumers that only need to *recognise* the
 * abort (the lifecycle service, error reporters) can import the predicate
 * without installing interceptors as a side effect of the import.
 */

/**
 * Reason attached to the abort raised by `platformFeaturesGate`. Callers use
 * {@link isPlatformFeaturesDisabledAbort} rather than matching this string.
 */
export const PLATFORM_FEATURES_DISABLED_ABORT_REASON =
  "Platform features disabled in local mode";

/**
 * True when `err` is the deliberate abort `platformFeaturesGate` raises for
 * platform-bound requests in local mode.
 *
 * This is a *policy* no-op, not a connectivity failure: the request was never
 * meant to leave the client. Consumers that treat any thrown fetch as a
 * transport failure (and therefore degrade the assistant to "unreachable")
 * must exclude it, or a healthy self-hosted app reports itself disconnected
 * every time something re-checks assistant status.
 */
export function isPlatformFeaturesDisabledAbort(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    err.name === "AbortError" &&
    err.message === PLATFORM_FEATURES_DISABLED_ABORT_REASON
  );
}
