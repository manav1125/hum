/**
 * Budget config + kill-switch CRUD for the gateway.
 *
 * Like {@link ./autonomy-policies-api.ts}, these endpoints live on the gateway
 * (`/v1/assistants/{id}/permissions/budget`), not the daemon, and are not yet
 * part of any generated OpenAPI spec. The functions here use the raw HeyAPI
 * client until gateway codegen is wired up.
 *
 * The gateway is the sole owner of this persistence (a single-row
 * `budget_config` table). The daemon's budget-cap provider reads the resolved
 * config over IPC and BLOCKS LLM calls once a cap is exceeded or the kill
 * switch is on.
 *
 * Unlike the autonomy endpoint (which wraps its payload in `{ policies }`), the
 * budget GET/PUT return the config object at the top level.
 */

import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

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
 * DEFAULTS — mirror the gateway. Used to backfill any field the gateway
 * omitted from its response so a missing key never reads as `undefined`. Caps
 * OFF, kill switch OFF, alert at 80%.
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  dailyCapUsd: null,
  monthlyCapUsd: null,
  killSwitch: false,
  alertThresholdPct: 80,
};

/** A cap is null (no cap) or a finite number > 0; anything else → null. */
function normalizeCap(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function normalize(raw: unknown): BudgetConfig {
  const result: BudgetConfig = { ...DEFAULT_BUDGET_CONFIG };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    result.dailyCapUsd = normalizeCap(record.dailyCapUsd);
    result.monthlyCapUsd = normalizeCap(record.monthlyCapUsd);
    if (typeof record.killSwitch === "boolean") {
      result.killSwitch = record.killSwitch;
    }
    if (
      typeof record.alertThresholdPct === "number" &&
      Number.isFinite(record.alertThresholdPct)
    ) {
      result.alertThresholdPct = record.alertThresholdPct;
    }
  }
  return result;
}

export async function getBudgetConfig(
  assistantId: string,
): Promise<BudgetConfig> {
  const { data, error, response } = await client.get<
    Record<string, unknown>,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/permissions/budget",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch budget settings.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch budget settings.",
    );
    throw new ApiError(response.status, msg);
  }
  return normalize(data);
}

export async function setBudgetConfig(
  assistantId: string,
  patch: Partial<BudgetConfig>,
): Promise<BudgetConfig> {
  const { data, error, response } = await client.put<
    Record<string, unknown>,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/permissions/budget",
    path: { assistant_id: assistantId },
    body: patch,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update budget settings.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to update budget settings.",
    );
    throw new ApiError(response.status, msg);
  }
  return normalize(data);
}
