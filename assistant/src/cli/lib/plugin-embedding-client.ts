/**
 * CLI-side client for the one plugin-registry operation that requires the
 * running daemon: seeding the curated + indexed plugin manifests into the
 * shared Qdrant embedding space (`memory_v2_concept_pages`).
 *
 * Unlike the rest of the registry surface (search / versions / reindex
 * fetch), this cannot be done from the CLI process — the embedding backend
 * and Qdrant connection live inside the daemon. So the `assistant plugins
 * reindex --embed` subcommand delegates here, and this helper forwards to
 * the daemon's `plugins_seed_embeddings` route over IPC.
 *
 * This mirrors `daemon-credential-client.ts`: a `cli/lib/` helper that
 * speaks IPC on behalf of an otherwise-`local` command. Keeping the
 * `cliIpcCall` import here (not in `commands/plugins.ts`) is what lets the
 * `plugins` command stay `local` without tripping `cli/no-daemon-internals`
 * — the ESLint rule only inspects files that call `registerCommand`.
 */

import { cliIpcCall } from "../../ipc/cli-client.js";

/** Count of plugin manifests seeded / skipped by the daemon. */
export interface SeedPluginEmbeddingsResult {
  seeded: number;
  skipped: number;
}

/**
 * Outcome of a seed request. `ok: false` carries the daemon-side error plus
 * an `unreachable` flag so the CLI can distinguish "daemon isn't running,
 * start it and retry" from a genuine daemon-side failure.
 */
export type SeedPluginEmbeddingsOutcome =
  | { ok: true; result: SeedPluginEmbeddingsResult }
  | { ok: false; error: string; unreachable: boolean };

/**
 * True when the IPC error string means the daemon wasn't reachable at all
 * (as opposed to reached-but-failed). Matches the stable connect/timeout
 * strings surfaced by `cliIpcCall` (see `src/ipc/cli-client.ts`).
 */
function isDaemonUnreachable(error: string): boolean {
  return (
    error.startsWith("Could not connect to the assistant at ") ||
    error.startsWith("Connection error:") ||
    error === "Connection closed before response" ||
    error === "Request timed out" ||
    error === "Stream timed out waiting for first byte"
  );
}

/**
 * Ask the running daemon to seed the plugin registry into the shared
 * embedding space. Best-effort on the daemon side (an unavailable embedding
 * backend yields `{ seeded: 0 }` rather than an error); a `false` outcome
 * here means the request never reached a healthy daemon.
 */
export async function seedPluginEmbeddingsViaDaemon(opts?: {
  includeUnreviewed?: boolean;
}): Promise<SeedPluginEmbeddingsOutcome> {
  const body =
    opts?.includeUnreviewed !== undefined
      ? { includeUnreviewed: opts.includeUnreviewed }
      : {};
  const r = await cliIpcCall<SeedPluginEmbeddingsResult>(
    "plugins_seed_embeddings",
    { body },
  );
  if (r.ok && r.result) return { ok: true, result: r.result };
  const error = r.error ?? "plugin embedding seed failed";
  return { ok: false, error, unreachable: isDaemonUnreachable(error) };
}
