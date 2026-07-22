/**
 * The self-host actor token, cached for the main process.
 *
 * A self-host install's credential is the long-lived `actor_client_v1` JWT the
 * connect link seeded into the renderer's localStorage (`cue:selfHost:*`, see
 * `apps/web/src/lib/self-hosted/cue-self-host.ts`). Main has no copy of it and
 * must not grow one — a second store is a second thing to expire, revoke and
 * leak. So main BORROWS it from the window, which is exactly what
 * `self-host-request` already does.
 *
 * What this module adds is a cache. Reading the renderer is asynchronous
 * (`executeJavaScript`), but the host-proxy SSE/poster pair builds its auth
 * headers synchronously on every request. The cache bridges the two: refresh
 * asynchronously (on connect, and before every SSE reconnect), read
 * synchronously from the header builders.
 *
 * The reader itself is injected rather than imported so this module — and
 * therefore `host-proxy-router` — stays free of an electron/BrowserWindow
 * dependency. `index.ts` wires the real one at startup.
 */

/** Reads the current actor token from wherever the session actually lives. */
export type SelfHostActorTokenReader = () => Promise<string | null>;

/** Default: no session source wired → self-host auth is simply unavailable. */
let reader: SelfHostActorTokenReader | null = null;
let cached: string | null = null;

/** Wire the token source. Called once from `index.ts`. */
export function setSelfHostActorTokenReader(
  next: SelfHostActorTokenReader | null,
): void {
  reader = next;
  if (!next) cached = null;
}

/**
 * The last token read, without touching the renderer. Null until the first
 * successful {@link refreshSelfHostActorToken}.
 */
export function getCachedSelfHostActorToken(): string | null {
  return cached;
}

/**
 * Re-read the token from the session source and update the cache. Returns the
 * fresh token, or null when no reader is wired / the renderer holds none.
 *
 * A failed read CLEARS the cache: continuing to present a token the session no
 * longer has would keep a revoked or signed-out install looking connected.
 */
export async function refreshSelfHostActorToken(): Promise<string | null> {
  if (!reader) return null;
  let next: string | null = null;
  try {
    next = await reader();
  } catch {
    next = null;
  }
  cached = next && next.length > 0 ? next : null;
  return cached;
}

/** Test seam. */
export function __resetSelfHostActorTokenForTesting(): void {
  reader = null;
  cached = null;
}
