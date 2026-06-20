/**
 * Budget config CRUD endpoints for the gateway (cost guardrails).
 *
 * The user sets optional spend caps + a kill switch. The gateway is the sole
 * owner of this persistence (a single-row `budget_config` table). The daemon's
 * budget-cap provider reads the resolved config over IPC and only BLOCKS LLM
 * calls when a cap is positively set and reached, or when the kill switch is on.
 *
 * GET  /v1/permissions/budget → the config with DEFAULTS filled in:
 *      caps null (off), killSwitch false, alertThresholdPct 80.
 * PUT  /v1/permissions/budget validates + upserts the singleton row:
 *      caps must be a positive finite number or null; killSwitch a boolean;
 *      alertThresholdPct an integer 1–100.
 *
 * DEFAULTS are intentionally OFF so we never enforce a cap the user did not
 * set. Alerts only fire once a cap is configured.
 */

import { eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../../db/connection.js";
import { budgetConfig } from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("budget-config");

// ---------------------------------------------------------------------------
// Shared shape + defaults
// ---------------------------------------------------------------------------

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
 * DEFAULTS — used when no row exists, or on a read error. Caps OFF, kill
 * switch OFF, alert at 80%. Must match the daemon-side safe defaults.
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  dailyCapUsd: null,
  monthlyCapUsd: null,
  killSwitch: false,
  alertThresholdPct: 80,
};

/**
 * Resolve the budget config from the singleton row, falling back to defaults
 * for a missing row. Centralized so the GET handler and the IPC handler share
 * one source of truth.
 */
export function resolveBudgetConfig(): BudgetConfig {
  const db = getGatewayDb();
  const row = db
    .select()
    .from(budgetConfig)
    .where(eq(budgetConfig.id, 1))
    .get();

  if (!row) return { ...DEFAULT_BUDGET_CONFIG };

  return {
    dailyCapUsd: row.dailyCapUsd ?? null,
    monthlyCapUsd: row.monthlyCapUsd ?? null,
    killSwitch: row.killSwitch === 1,
    alertThresholdPct: row.alertThresholdPct ?? 80,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** A cap is valid if it is null, or a finite number strictly greater than 0. */
function parseCap(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined; // invalid
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/budget
// ---------------------------------------------------------------------------

export function createBudgetGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      return Response.json(resolveBudgetConfig());
    } catch (err) {
      log.error({ err }, "Failed to read budget config");
      // Return defaults rather than an error so the UI shows a usable state.
      return Response.json({ ...DEFAULT_BUDGET_CONFIG });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/budget
// ---------------------------------------------------------------------------

export function createBudgetPutHandler() {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const raw = body as Record<string, unknown>;
    const current = resolveBudgetConfig();

    // Each field is optional — a PUT patches the singleton. Validate any field
    // that is present; leave unspecified fields at their current value.
    const next: BudgetConfig = { ...current };

    if ("dailyCapUsd" in raw) {
      const parsed = parseCap(raw.dailyCapUsd);
      if (parsed === undefined) {
        return Response.json(
          { error: "`dailyCapUsd` must be a positive number or null" },
          { status: 400 },
        );
      }
      next.dailyCapUsd = parsed;
    }

    if ("monthlyCapUsd" in raw) {
      const parsed = parseCap(raw.monthlyCapUsd);
      if (parsed === undefined) {
        return Response.json(
          { error: "`monthlyCapUsd` must be a positive number or null" },
          { status: 400 },
        );
      }
      next.monthlyCapUsd = parsed;
    }

    if ("killSwitch" in raw) {
      if (typeof raw.killSwitch !== "boolean") {
        return Response.json(
          { error: "`killSwitch` must be a boolean" },
          { status: 400 },
        );
      }
      next.killSwitch = raw.killSwitch;
    }

    if ("alertThresholdPct" in raw) {
      const pct = raw.alertThresholdPct;
      if (
        typeof pct !== "number" ||
        !Number.isInteger(pct) ||
        pct < 1 ||
        pct > 100
      ) {
        return Response.json(
          { error: "`alertThresholdPct` must be an integer between 1 and 100" },
          { status: 400 },
        );
      }
      next.alertThresholdPct = pct;
    }

    try {
      const db = getGatewayDb();
      db.insert(budgetConfig)
        .values({
          id: 1,
          dailyCapUsd: next.dailyCapUsd,
          monthlyCapUsd: next.monthlyCapUsd,
          killSwitch: next.killSwitch ? 1 : 0,
          alertThresholdPct: next.alertThresholdPct,
        })
        .onConflictDoUpdate({
          target: budgetConfig.id,
          set: {
            dailyCapUsd: next.dailyCapUsd,
            monthlyCapUsd: next.monthlyCapUsd,
            killSwitch: next.killSwitch ? 1 : 0,
            alertThresholdPct: next.alertThresholdPct,
            updatedAt: sql`datetime('now')`,
          },
        })
        .run();
      return Response.json(resolveBudgetConfig());
    } catch (err) {
      log.error({ err }, "Failed to upsert budget config");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
