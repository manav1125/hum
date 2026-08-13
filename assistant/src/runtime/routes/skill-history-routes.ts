/**
 * Skill revision history route.
 *
 * `GET skills/:id/history` returns a skill's recent updates, newest first,
 * each with a combined diff across the skill directory. Read-only and
 * deterministic: revisions come from the workspace git repository (which
 * already retains prior content), so no model turn is spent viewing what
 * changed. Port of upstream 4fe79f4a13, kept in its own route module so the
 * sibling skills-routes file stays untouched.
 *
 * Lives outside `skills-routes.ts` deliberately; registration order in
 * `routes/index.ts` is what places it on the shared HTTP+IPC surface.
 */

import { z } from "zod";

import { getSkillLocalDetail } from "../../daemon/handlers/skills.js";
import { getSkillHistory } from "../../workspace/skill-history.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const skillHistoryResponseSchema = z.object({
  skillId: z.string().describe("The skill these revisions belong to"),
  revisions: z
    .array(
      z.object({
        id: z.string().describe("Opaque revision identifier"),
        changedAt: z.string().describe("ISO-8601 time of the update"),
        files: z
          .array(z.string())
          .describe("Paths changed, relative to the skill directory"),
        diff: z
          .string()
          .describe("Unified diff of this update, scoped to the skill"),
      }),
    )
    .describe("Recent updates, newest first"),
  truncatedByCompaction: z
    .boolean()
    .describe(
      "Older history was squashed away, so the oldest entry is a floor rather than the skill's creation",
    ),
});

export async function handleGetSkillHistory({
  pathParams,
  queryParams,
}: RouteHandlerArgs): Promise<z.infer<typeof skillHistoryResponseSchema>> {
  const skillId = pathParams!.id!;
  const rawLimit = queryParams?.limit;
  const limit =
    typeof rawLimit === "string" && rawLimit.trim().length > 0
      ? Number.parseInt(rawLimit, 10)
      : undefined;
  try {
    // Same current-resource boundary as the sibling skill routes. Git retains
    // a deleted skill's commits, so without this a removed skill would keep
    // answering with history for something the rest of the API reports as
    // gone. An existing skill with nothing recorded still gets an empty
    // list, which is the honest answer for a bundled skill or one the
    // workspace has not committed yet. The check runs before the read so a
    // gone skill costs no git traversal.
    const detail = getSkillLocalDetail(skillId);
    if (!detail.ok) {
      if (detail.status === 404) {
        throw new NotFoundError(`Skill "${skillId}" not found`);
      }
      throw new InternalError(detail.error);
    }
    return await getSkillHistory(skillId, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof InternalError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    // The id reaches a git pathspec, so a malformed one is the caller's
    // error. Anything else escaping the service is a server fault: the
    // read is otherwise fail-soft and returns an empty history.
    if (message.startsWith("Invalid skill id")) {
      throw new BadRequestError(message);
    }
    throw new InternalError(message);
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getSkillHistory",
    endpoint: "skills/:id/history",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get skill revision history",
    description:
      "Return a skill's recent updates, newest first, each with a combined diff across the skill directory. Read-only: revisions come from the workspace git repository, which already retains prior content. Commits whose only in-skill change is the `lastUsedAt` usage stamp are omitted, so entries are edits rather than loads.",
    tags: ["skills"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        required: false,
        description:
          "Maximum revisions to return, newest first. Defaults to 20 and is clamped to 100.",
      },
    ],
    responseBody: skillHistoryResponseSchema,
    additionalResponses: {
      "400": {
        description: "Malformed skill id.",
      },
      "404": {
        description: "No skill with this id exists on this assistant.",
      },
    },
    handler: handleGetSkillHistory,
  },
];
