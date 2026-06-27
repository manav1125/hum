/**
 * Shared rewrite for assistant-scoped client paths.
 *
 * Clients address the daemon through `/v1/assistants/{id}/<route>` URLs, but
 * the daemon's routes — both its flat HTTP endpoints and its IPC route schema —
 * are keyed on the bare `/v1/<route>` form. Both the HTTP runtime proxy
 * (`runtime-proxy.ts`) and the IPC runtime proxy (`ipc-runtime-proxy.ts`) must
 * strip the `/v1/assistants/{id}` segment identically before forwarding /
 * matching, otherwise a route that works through one transport 404s through the
 * other. Keeping the single regex here guarantees the two transports can never
 * drift, so every current and future daemon route propagates the same way.
 */

const ASSISTANT_SCOPED_RE = /^\/v1\/assistants\/[^/]+\/(.+)$/;

/**
 * Rewrite an inbound client pathname to the flat daemon pathname.
 *
 * `/v1/assistants/{id}/work-items` → `/v1/work-items`.
 * Flat `/v1/<route>` paths (and any non-matching path) pass through unchanged.
 */
export function toFlatDaemonPath(pathname: string): string {
  const match = pathname.match(ASSISTANT_SCOPED_RE);
  return match ? `/v1/${match[1]}` : pathname;
}
