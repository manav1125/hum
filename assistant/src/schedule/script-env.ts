/**
 * The environment a script-mode schedule hands to its child.
 *
 * Stored as JSON on the schedule, resolved at fire time. Values may be
 * `${credential:service/field}` references, so the schedule row and every log
 * line carry the reference while the secret exists only in the child's
 * environment for the life of the run.
 */

import {
  CredentialReferenceError,
  resolveCredentialReferencesInEnv,
} from "../tools/credentials/env-references.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("schedule-script-env");

/**
 * The identity a scheduled script presents to the credential tool policy. A
 * credential must name this in its `allowedTools` before it can be injected.
 */
export function scheduleCredentialConsumer(jobId: string): string {
  return `schedule:${jobId}`;
}

/** Raised when a schedule's declared environment cannot be produced. */
export class ScheduleEnvError extends Error {}

/**
 * Parse and resolve a schedule's declared environment.
 *
 * @throws ScheduleEnvError when the JSON is unusable or a credential
 *   reference cannot be resolved. The run must fail loudly: starting the
 *   script with the variable unset turns a missing secret into an unexplained
 *   401 from whatever it talks to, long after the cause.
 */
export async function resolveScheduleScriptEnv(
  jobId: string,
  scriptEnvJson: string | null | undefined,
): Promise<Record<string, string> | undefined> {
  if (!scriptEnvJson || scriptEnvJson.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(scriptEnvJson);
  } catch {
    throw new ScheduleEnvError(
      `schedule ${jobId} has a script environment that is not valid JSON`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScheduleEnvError(
      `schedule ${jobId} script environment must be a JSON object of string values`,
    );
  }

  const declared: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== "string") {
      throw new ScheduleEnvError(
        `schedule ${jobId} script environment value for "${key}" must be a string`,
      );
    }
    declared[key] = value;
  }

  try {
    return await resolveCredentialReferencesInEnv(
      declared,
      scheduleCredentialConsumer(jobId),
    );
  } catch (err) {
    if (err instanceof CredentialReferenceError) {
      log.error(
        { jobId, reference: err.reference },
        "Scheduled run blocked: credential reference could not be resolved",
      );
      throw new ScheduleEnvError(`schedule ${jobId}: ${err.message}`);
    }
    throw err;
  }
}
