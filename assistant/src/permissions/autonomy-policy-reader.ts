/**
 * Gateway-backed per-category autonomy policy reader.
 *
 * Reads the autonomy policy map from the gateway via IPC. The gateway is the
 * sole source of truth (it owns the `autonomy_category_policies` table). When
 * the gateway is unreachable, this reader returns FAIL-CLOSED safe defaults:
 * research/draft → "auto", send/money/delete/other → "ask". It NEVER defaults
 * the consequential categories (send/money/delete) to "auto".
 */

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { AutonomyClass } from "./autonomy-class.js";

const log = getLogger("autonomy-policy-reader");

export type AutonomyMode = "auto" | "ask" | "never";
export type AutonomyPolicyMap = Record<AutonomyClass, AutonomyMode>;

/**
 * SAFE DEFAULTS — used when the gateway is unreachable or returns an
 * unexpected shape. Must match the gateway-side defaults. Fail closed:
 * send/money/delete/other → "ask", never "auto".
 */
const SAFE_DEFAULTS: AutonomyPolicyMap = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  other: "ask",
};

const CATEGORIES: ReadonlyArray<AutonomyClass> = [
  "research",
  "draft",
  "send",
  "money",
  "delete",
  "other",
];

function isValidMode(value: unknown): value is AutonomyMode {
  return value === "auto" || value === "ask" || value === "never";
}

// ── Short-TTL cache ──────────────────────────────────────────────────────────
// A short TTL avoids an IPC roundtrip on every tool call in a burst while still
// reflecting a policy change the user just made within a few seconds.

let cached: AutonomyPolicyMap | null = null;
let cachedTimestamp = 0;
const CACHE_TTL_MS = 5_000;

/** Test-only: clear the cache. */
export function _clearAutonomyPolicyCacheForTesting(): void {
  cached = null;
  cachedTimestamp = 0;
}

/**
 * Normalize an arbitrary gateway response into a complete policy map, filling
 * any missing or invalid category with its safe default. Always returns a
 * fully-populated map.
 */
function normalize(raw: unknown): AutonomyPolicyMap {
  const policies =
    raw && typeof raw === "object" && "policies" in raw
      ? (raw as { policies: unknown }).policies
      : raw;

  const result: AutonomyPolicyMap = { ...SAFE_DEFAULTS };
  if (policies && typeof policies === "object" && !Array.isArray(policies)) {
    const record = policies as Record<string, unknown>;
    for (const category of CATEGORIES) {
      const value = record[category];
      if (isValidMode(value)) {
        result[category] = value;
      }
    }
  }
  return result;
}

/**
 * Read the per-category autonomy policy map from the gateway via IPC.
 *
 * Caches for {@link CACHE_TTL_MS}. On any IPC error or unexpected response,
 * returns the fail-closed safe defaults so no consequential category is ever
 * silently treated as "auto" when the gateway is down.
 */
export async function getAutonomyPolicy(): Promise<AutonomyPolicyMap> {
  const now = Date.now();
  if (cached && now - cachedTimestamp < CACHE_TTL_MS) {
    return cached;
  }

  try {
    // ipcCall returns undefined on transport failure, or the handler payload.
    const result = (await ipcCall("get_autonomy_policies")) as unknown;
    if (result === undefined || result === null) {
      throw new Error("Gateway IPC returned no result for autonomy policies");
    }
    const map = normalize(result);
    cached = map;
    cachedTimestamp = Date.now();
    return map;
  } catch (err) {
    // Gateway unreachable — fail closed. Do not cache the fallback so the next
    // call re-attempts the gateway promptly once it recovers.
    log.warn(
      { error: String(err) },
      "Failed to fetch autonomy policies, falling back to safe defaults (send/money/delete → ask)",
    );
    return { ...SAFE_DEFAULTS };
  }
}
