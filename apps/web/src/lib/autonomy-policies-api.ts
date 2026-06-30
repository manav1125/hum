/**
 * Per-category autonomy policy CRUD for the gateway.
 *
 * Like {@link ./threshold-api.ts}, these endpoints live on the gateway
 * (`/v1/assistants/{id}/permissions/autonomy-policies`), not the daemon, and
 * are not yet part of any generated OpenAPI spec. The functions here use the
 * raw HeyAPI client until gateway codegen is wired up.
 *
 * The user opts each action category into one of three modes:
 *   - "auto":  run without asking
 *   - "ask":   always prompt
 *   - "never": always deny
 */

import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export const AUTONOMY_CATEGORIES = [
  "research",
  "draft",
  "send",
  "money",
  "delete",
  "other",
] as const;
export type AutonomyCategory = (typeof AUTONOMY_CATEGORIES)[number];

export type AutonomyMode = "auto" | "ask" | "never";

export type AutonomyPolicies = Record<AutonomyCategory, AutonomyMode>;

/**
 * Safe defaults, mirroring the gateway. Used only to backfill any category the
 * gateway omitted from its response — the gateway should always return a
 * complete map, but we never want a missing key to read as `undefined`.
 */
const SAFE_DEFAULTS: AutonomyPolicies = {
  research: "auto",
  draft: "auto",
  send: "auto",
  money: "ask",
  delete: "ask",
  other: "auto",
};

function isMode(value: unknown): value is AutonomyMode {
  return value === "auto" || value === "ask" || value === "never";
}

function normalize(raw: unknown): AutonomyPolicies {
  const result: AutonomyPolicies = { ...SAFE_DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const category of AUTONOMY_CATEGORIES) {
      const value = record[category];
      if (isMode(value)) result[category] = value;
    }
  }
  return result;
}

export async function getAutonomyPolicies(
  assistantId: string,
): Promise<AutonomyPolicies> {
  const { data, error, response } = await client.get<
    { policies: Record<string, unknown> },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/permissions/autonomy-policies",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch autonomy policies.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch autonomy policies.",
    );
    throw new ApiError(response.status, msg);
  }
  const result = data as { policies?: Record<string, unknown> };
  return normalize(result.policies ?? {});
}

export async function setAutonomyPolicies(
  assistantId: string,
  policies: Partial<AutonomyPolicies>,
): Promise<AutonomyPolicies> {
  const { data, error, response } = await client.put<
    { policies: Record<string, unknown> },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/permissions/autonomy-policies",
    path: { assistant_id: assistantId },
    body: { policies },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update autonomy policies.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to update autonomy policies.",
    );
    throw new ApiError(response.status, msg);
  }
  const result = data as { policies?: Record<string, unknown> };
  return normalize(result.policies ?? {});
}
