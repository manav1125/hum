/**
 * Memory-tab usage telemetry — NO-OP STUB.
 *
 * Upstream reports Memory-tab interactions through a shared
 * `lib/telemetry/{consent,ingest}` transport (consent-gated, batched, riding
 * the onboarding ingest wire shape). This fork has no `lib/telemetry/` layer,
 * so the graph components call into this stub instead: same call sites, same
 * event vocabulary, zero uploads. When a telemetry transport lands, replace
 * the body with upstream's `clients/web/src/domains/intelligence/
 * memory-telemetry.ts` implementation — the component-facing signature is
 * already identical.
 */

/** Which Memory-tab interaction is being reported. */
type MemoryStep = "opened" | "search" | "node_opened" | "chat_from_node";

/** Report one Memory-tab interaction. No-op in this fork (see module doc). */
export function emitMemoryEvent(_step: MemoryStep): void {
  // Intentionally empty — no telemetry transport in this fork.
}
