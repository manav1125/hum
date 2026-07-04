import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Flip `memory.v2.router.enabled` from the previously-seeded `true` to the
 * new schema default `false` for workspaces that never customized the
 * router.
 *
 * Why: the memory-v2 LLM router is a BLOCKING per-turn model call that runs
 * before the main agent call — it roughly doubles wall-clock turn latency —
 * and its forced tool call is unreliable through OpenRouter (frequent schema
 * validation failures pay the full latency and inject nothing). The config
 * schema default flipped to `false`, but config materialization writes the
 * fully-parsed config (defaults included) back to `config.json`, so every
 * existing workspace carries an explicit `enabled: true` that the schema
 * flip alone cannot reach.
 *
 * Detection mirrors migration 087's "only rewrite the exact seeded shape"
 * pattern: we only flip when every other router knob still holds its seeded
 * default. A workspace that tuned `batch_size`, tier sizes, prompt path, or
 * history knobs was actively using the router — that's a deliberate choice
 * and is preserved. (`CUE_DISABLE_MEMORY_ROUTER` remains available as the
 * env-level emergency off for those workspaces.)
 */
export const disableMemoryV2RouterSeededDefaultMigration: WorkspaceMigration = {
  id: "103-disable-memory-v2-router-seeded-default",
  description:
    "Turn off the per-turn memory-v2 LLM router where it was only on via the old seeded default (latency: it doubled turn time and is unreliable through OpenRouter)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const memory = readObject(config.memory);
    const v2 = readObject(memory?.v2);
    const router = readObject(v2?.router);
    if (!router) return;
    if (router.enabled !== true) return;

    // Only flip untouched seeded shapes. Any customized knob means the
    // workspace deliberately uses the router — leave it alone.
    const isSeededDefaultShape =
      matchesDefault(router.max_page_ids, 25) &&
      matchesDefault(router.router_prompt_path, null) &&
      matchesDefault(router.batch_size, null) &&
      matchesDefault(router.tier1_size, null) &&
      matchesDefault(router.tier2_size, null) &&
      matchesDefault(router.historical_pairs, 1) &&
      matchesDefault(router.historical_pairs_max_chars, null);
    if (!isSeededDefaultShape) return;

    router.enabled = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: after the flip, an explicit `false` is
    // indistinguishable from a user's own choice.
  },
};

/** Field is at its seeded default when absent OR explicitly the default. */
function matchesDefault(value: unknown, expected: unknown): boolean {
  return value === undefined || value === expected;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
