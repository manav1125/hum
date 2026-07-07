/**
 * One-line hook for mutating call sites to notify the config-as-code
 * recorder (WS5) that durable config changed.
 *
 * Deliberately a leaf module with ZERO static imports so low-level stores
 * (config loader, schedule store, skill stores) can import it without
 * creating cycles. The recorder itself is loaded lazily on first use; it is
 * flag-gated (`configRepo.enabled`, default OFF) and fire-and-forget — this
 * call can never throw, block, or fail the caller's mutation.
 */

export type ConfigChangeActor = "user" | "assistant" | "system";

export function notifyConfigChange(
  cause: string,
  actor: ConfigChangeActor,
): void {
  import("./index.js")
    .then((m) => m.recordConfigChange({ cause, actor }))
    .catch(() => {
      // Recorder unavailable — the mutation must proceed regardless.
    });
}
