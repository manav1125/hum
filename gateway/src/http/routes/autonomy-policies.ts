/**
 * Per-category autonomy policy CRUD endpoints for the gateway.
 *
 * The user opts each action category (research / draft / send / money /
 * delete / other) into one of three autonomy modes:
 *   - "auto":  run without asking (still subject to deny rules + risk logic)
 *   - "ask":   always prompt
 *   - "never": always deny
 *
 * GET  /v1/permissions/autonomy-policies → { policies: Record<category, mode> }
 *      with SAFE DEFAULTS filled in for any category that has no stored row.
 * PUT  /v1/permissions/autonomy-policies validates mode ∈ {auto,ask,never}
 *      and upserts the provided category rows.
 *
 * The gateway is the sole owner of this persistence (NOT localStorage, NOT
 * daemon files). The daemon reads the resolved map over IPC.
 */

import { sql } from "drizzle-orm";

import { getGatewayDb } from "../../db/connection.js";
import { autonomyCategoryPolicies } from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("autonomy-policies");

// ---------------------------------------------------------------------------
// Shared vocabulary + SAFE DEFAULTS
// ---------------------------------------------------------------------------

export const AUTONOMY_CATEGORIES = [
  "research",
  "draft",
  "send",
  "money",
  "delete",
  "other",
] as const;
export type AutonomyCategory = (typeof AUTONOMY_CATEGORIES)[number];

export const AUTONOMY_MODES = ["auto", "ask", "never"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/**
 * SAFE DEFAULTS — applied when a category has no stored row.
 *
 * Research and drafting are low-consequence and auto-run by default. Anything
 * that can send a message, move money, or delete data defaults to "ask", and
 * the catch-all "other" defaults to "ask" too. NEVER default money/send/delete
 * to "auto".
 */
export const SAFE_DEFAULT_POLICIES: Record<AutonomyCategory, AutonomyMode> = {
  research: "auto",
  draft: "auto",
  send: "ask",
  money: "ask",
  delete: "ask",
  other: "ask",
};

function isValidCategory(value: unknown): value is AutonomyCategory {
  return (
    typeof value === "string" &&
    AUTONOMY_CATEGORIES.includes(value as AutonomyCategory)
  );
}

function isValidMode(value: unknown): value is AutonomyMode {
  return (
    typeof value === "string" && AUTONOMY_MODES.includes(value as AutonomyMode)
  );
}

/**
 * Resolve the full policy map: start from the safe defaults, then overlay any
 * stored rows. Centralized so the GET handler and the IPC handler share one
 * source of truth for the defaults.
 */
export function resolveAutonomyPolicies(): Record<
  AutonomyCategory,
  AutonomyMode
> {
  const policies: Record<AutonomyCategory, AutonomyMode> = {
    ...SAFE_DEFAULT_POLICIES,
  };
  const db = getGatewayDb();
  const rows = db.select().from(autonomyCategoryPolicies).all();
  for (const row of rows) {
    if (isValidCategory(row.category) && isValidMode(row.mode)) {
      policies[row.category] = row.mode;
    }
  }
  return policies;
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/autonomy-policies
// ---------------------------------------------------------------------------

export function createAutonomyPoliciesGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const policies = resolveAutonomyPolicies();
      return Response.json({ policies });
    } catch (err) {
      log.error({ err }, "Failed to read autonomy policies");
      // Fail closed: on a DB read error, still return the SAFE defaults rather
      // than an error the UI might paper over with stale or absent values.
      return Response.json({ policies: { ...SAFE_DEFAULT_POLICIES } });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/autonomy-policies
// ---------------------------------------------------------------------------

export function createAutonomyPoliciesPutHandler() {
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

    // Accept either { policies: { category: mode } } or a flat
    // { category: mode } map. Validate every entry before writing anything.
    const raw = (body as Record<string, unknown>).policies ?? body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return Response.json(
        { error: "`policies` must be an object of category → mode" },
        { status: 400 },
      );
    }

    const updates: Array<{ category: AutonomyCategory; mode: AutonomyMode }> =
      [];
    for (const [category, mode] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (!isValidCategory(category)) {
        return Response.json(
          {
            error: `Unknown category "${category}". Must be one of: ${AUTONOMY_CATEGORIES.join(", ")}`,
          },
          { status: 400 },
        );
      }
      if (!isValidMode(mode)) {
        return Response.json(
          {
            error: `Invalid mode for "${category}". Must be one of: ${AUTONOMY_MODES.join(", ")}`,
          },
          { status: 400 },
        );
      }
      updates.push({ category, mode });
    }

    try {
      const db = getGatewayDb();
      for (const { category, mode } of updates) {
        db.insert(autonomyCategoryPolicies)
          .values({ category, mode })
          .onConflictDoUpdate({
            target: autonomyCategoryPolicies.category,
            set: { mode, updatedAt: sql`datetime('now')` },
          })
          .run();
      }
      // Return the full resolved map so the client always has the complete,
      // defaults-applied view after a write.
      return Response.json({ policies: resolveAutonomyPolicies() });
    } catch (err) {
      log.error({ err }, "Failed to upsert autonomy policies");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
