import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Migration 331 — `cron_jobs.script_env_json`, the environment a script-mode
 * schedule hands to its child process.
 *
 * Slot 331 is the next free one after 330 (ritual snapshots).
 *
 * A scheduled script runs with no human present, which is precisely why it
 * could not reach a secret: the request proxy is bound to a tool call and
 * `assistant credentials reveal` waits on an approval nobody is there to
 * give. The only workaround was to write the secret into the command string,
 * where it shows up in `ps` output and in every stored copy of the schedule.
 *
 * This column carries a JSON object of environment variables, whose values
 * may be `${credential:service/field}` references resolved at fire time. The
 * reference is what persists here; the secret exists only in the child's
 * environment, for the life of the run.
 *
 * No backfill: existing schedules have no declared environment, and null
 * means exactly that.
 */
export function migrateScheduleScriptEnv(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN script_env_json TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
