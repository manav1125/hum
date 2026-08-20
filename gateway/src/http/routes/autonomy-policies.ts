/**
 * Per-category autonomy policy CRUD endpoints for the gateway.
 *
 * The user opts each action category (research / draft / send / money /
 * delete / other) into one of three autonomy modes:
 *   - "auto":  run without asking (still subject to deny rules + risk logic)
 *   - "ask":   always prompt
 *   - "never": always deny
 *
 * GET  /v1/permissions/autonomy-policies → { policies, sources }
 *      `policies` has SAFE DEFAULTS filled in for any category with no stored
 *      row; `sources` says, per category, which of the two you are looking at.
 * PUT  /v1/permissions/autonomy-policies validates mode ∈ {auto,ask,never}
 *      and upserts the provided category rows.
 *
 * The gateway is the sole owner of this persistence (NOT localStorage, NOT
 * daemon files). The daemon reads the resolved map over IPC.
 *
 * WHY `sources` EXISTS
 * --------------------
 * A resolved map cannot be read back as a user's answer. `send: "auto"` is
 * both the value an owner picks when they want unattended sending AND the
 * value this file hands out to an instance nobody has ever configured — and a
 * client that cannot tell those apart either re-asks a question already
 * answered or, worse, presents a default as if it were a choice.
 *
 * The first-run consent screen (`domains/onboarding/signon/consent-scopes.ts`)
 * is the caller that made this load-bearing: its gate is device-scoped on
 * purpose, so it replays on every new laptop against an instance that may
 * already hold real policy. It must seed its switches from what the instance
 * holds — but only where "what the instance holds" is an ANSWER. Seeding from
 * the resolved map instead would render its "Send and spend" card ON for every
 * brand-new instance, which is precisely the default this project already had
 * a background run email a partner over.
 *
 * Nothing new is stored to support this. A row in `autonomy_category_policies`
 * exists if and only if somebody wrote that category, so the table has always
 * carried the distinction; `resolveAutonomyPolicies` simply discarded it while
 * overlaying defaults. `sources` stops discarding it. That is why this, rather
 * than an "answered" marker alongside the map: a marker is a second fact that
 * can disagree with the first, and every future writer would have to remember
 * to set it. The row cannot drift from itself.
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
 * Where a category's resolved mode came from.
 *
 * `"stored"` — a row exists, so a human (or a client acting on a human's
 *   answer) wrote this. It is a choice and may be read back as one.
 * `"default"` — no row. The mode is this file's opinion, not the user's, and a
 *   client must not present it as an answer.
 */
export const AUTONOMY_POLICY_SOURCES = ["stored", "default"] as const;
export type AutonomyPolicySource = (typeof AUTONOMY_POLICY_SOURCES)[number];

export type AutonomyPolicyState = {
  policies: Record<AutonomyCategory, AutonomyMode>;
  sources: Record<AutonomyCategory, AutonomyPolicySource>;
};

/**
 * DEFAULTS — applied when a category has no stored row.
 *
 * Tuned for "just get a result": research, drafting, sending, and the catch-all
 * "other" (builds, file ops, most tools) auto-run, so the assistant isn't
 * gated on a prompt for everyday work. Only the two genuinely irreversible /
 * costly categories — moving money and destructive deletes — ask by default.
 * The user can tighten any category to "ask"/"never" (or loosen money/delete)
 * from the Trust console. Keep money + delete at "ask" unless the user
 * explicitly opts into full autonomy.
 */
export const SAFE_DEFAULT_POLICIES: Record<AutonomyCategory, AutonomyMode> = {
  research: "auto",
  draft: "auto",
  send: "auto",
  money: "ask",
  delete: "ask",
  other: "auto",
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

/** Every category attributed to the defaults — the "we know nothing" map. */
function allDefaultSources(): Record<AutonomyCategory, AutonomyPolicySource> {
  return Object.fromEntries(
    AUTONOMY_CATEGORIES.map((category) => [category, "default" as const]),
  ) as Record<AutonomyCategory, AutonomyPolicySource>;
}

/**
 * Resolve the full policy map AND its provenance: start from the safe
 * defaults, then overlay any stored rows, marking each overlaid category
 * `"stored"`.
 *
 * A row whose mode fails validation is left at the default AND left marked
 * `"default"`: we have a row but no usable answer in it, and reporting that as
 * a choice would let a corrupt write masquerade as consent.
 */
export function resolveAutonomyPolicyState(): AutonomyPolicyState {
  const policies: Record<AutonomyCategory, AutonomyMode> = {
    ...SAFE_DEFAULT_POLICIES,
  };
  const sources = allDefaultSources();
  const db = getGatewayDb();
  const rows = db.select().from(autonomyCategoryPolicies).all();
  for (const row of rows) {
    if (isValidCategory(row.category) && isValidMode(row.mode)) {
      policies[row.category] = row.mode;
      sources[row.category] = "stored";
    }
  }
  return { policies, sources };
}

/**
 * The resolved map alone, for callers that only enforce it. The daemon's IPC
 * reader is one: enforcement acts on the mode and has no use for who chose it.
 */
export function resolveAutonomyPolicies(): Record<
  AutonomyCategory,
  AutonomyMode
> {
  return resolveAutonomyPolicyState().policies;
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/autonomy-policies
// ---------------------------------------------------------------------------

export function createAutonomyPoliciesGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      return Response.json(resolveAutonomyPolicyState());
    } catch (err) {
      log.error({ err }, "Failed to read autonomy policies");
      // Fail closed: on a DB read error, still return the SAFE defaults rather
      // than an error the UI might paper over with stale or absent values —
      // and attribute every one of them to the defaults, because a read that
      // did not happen is the one case where we provably know nothing about
      // what the user chose.
      return Response.json({
        policies: { ...SAFE_DEFAULT_POLICIES },
        sources: allDefaultSources(),
      });
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
      // defaults-applied view after a write — with provenance, so a client that
      // writes and then re-reads sees the categories it just wrote flip to
      // "stored" rather than having to assume it.
      return Response.json(resolveAutonomyPolicyState());
    } catch (err) {
      log.error({ err }, "Failed to upsert autonomy policies");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
