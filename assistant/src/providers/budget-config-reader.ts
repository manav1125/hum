/**
 * Gateway-backed budget config reader (cost guardrails).
 *
 * Reads the budget config from the gateway via IPC. The gateway is the sole
 * source of truth (it owns the `budget_config` table). The daemon's
 * {@link BudgetCapProvider} consumes this to decide whether to block an LLM
 * call.
 *
 * FAIL-OPEN contract: unlike the autonomy-policy reader (which fails CLOSED on
 * the consequential categories), this reader fails OPEN for availability. When
 * the gateway is unreachable we return the LAST-KNOWN config if we have one,
 * otherwise the safe default — which is NO cap + kill switch OFF. The cap only
 * enforces when it positively knows the user configured one and the value is
 * readable. A transient gateway blip must never brick the assistant.
 *
 * Caching the last-known config is deliberate: a flapping gateway must not let
 * a user-set cap silently lapse to "no cap" for the duration of an outage. We
 * keep serving the last value we read until the gateway recovers.
 */

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("budget-config-reader");

export interface BudgetConfig {
  /** Daily spend cap in USD, or null = no daily cap (off). */
  dailyCapUsd: number | null;
  /** Calendar-month spend cap in USD, or null = no monthly cap (off). */
  monthlyCapUsd: number | null;
  /** When true, every LLM call is blocked regardless of spend. */
  killSwitch: boolean;
  /** Percent of a cap (1–100) at which a one-time alert is emitted. */
  alertThresholdPct: number;
}

/**
 * SAFE DEFAULT — used only when the gateway is unreachable AND we have never
 * successfully read a config. Fail OPEN: no cap, kill switch off, so the
 * assistant keeps working. Must match the gateway-side `DEFAULT_BUDGET_CONFIG`.
 */
export const SAFE_DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  dailyCapUsd: null,
  monthlyCapUsd: null,
  killSwitch: false,
  alertThresholdPct: 80,
};

function parseCap(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function parsePct(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 100
  ) {
    return value;
  }
  return 80;
}

/**
 * Normalize an arbitrary gateway response into a complete config. Unknown or
 * invalid fields fall back to their default. Always returns a complete config.
 */
function normalize(raw: unknown): BudgetConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...SAFE_DEFAULT_BUDGET_CONFIG };
  }
  const record = raw as Record<string, unknown>;
  return {
    dailyCapUsd: parseCap(record.dailyCapUsd),
    monthlyCapUsd: parseCap(record.monthlyCapUsd),
    killSwitch: record.killSwitch === true,
    alertThresholdPct: parsePct(record.alertThresholdPct),
  };
}

// ── Short-TTL cache + last-known fallback ────────────────────────────────────
// The short TTL avoids an IPC roundtrip on every LLM call in a burst while
// still reflecting a budget change the user just made within a few seconds.
// `lastKnown` is held INDEFINITELY (no TTL) and only ever serves as the
// unreachable-gateway fallback so a flapping gateway can't disable an
// already-configured cap.

let cached: BudgetConfig | null = null;
let cachedTimestamp = 0;
let lastKnown: BudgetConfig | null = null;
const CACHE_TTL_MS = 5_000;

/** Test-only: clear both the TTL cache and the last-known fallback. */
export function _clearBudgetConfigCacheForTesting(): void {
  cached = null;
  cachedTimestamp = 0;
  lastKnown = null;
}

/**
 * Read the budget config from the gateway via IPC.
 *
 * Caches for {@link CACHE_TTL_MS}. On any IPC error or unexpected response,
 * returns the last successfully-read config if available, otherwise the
 * fail-OPEN safe default (no cap, kill switch off).
 */
export async function getBudgetConfig(): Promise<BudgetConfig> {
  const now = Date.now();
  if (cached && now - cachedTimestamp < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const result = (await ipcCall("get_budget_config")) as unknown;
    if (result === undefined || result === null) {
      throw new Error("Gateway IPC returned no result for budget config");
    }
    const config = normalize(result);
    cached = config;
    cachedTimestamp = Date.now();
    lastKnown = config;
    return config;
  } catch (err) {
    // Gateway unreachable — fail OPEN for availability. Serve the last-known
    // config if we have one (so a configured cap survives an outage), else the
    // no-cap safe default. Do not cache the fallback under the TTL so the next
    // call re-attempts the gateway promptly once it recovers.
    log.warn(
      { error: String(err) },
      "Failed to fetch budget config — failing open (serving last-known or no-cap default)",
    );
    return lastKnown ? { ...lastKnown } : { ...SAFE_DEFAULT_BUDGET_CONFIG };
  }
}
