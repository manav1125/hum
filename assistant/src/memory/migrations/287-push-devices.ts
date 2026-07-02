import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_push_devices_v1";

/**
 * Create the push_devices registry: one row per mobile device token
 * registered for remote push (APNs today, FCM later). Tokens are unique —
 * re-registering an existing token refreshes its metadata instead of
 * inserting a duplicate. Rows are pruned when APNs reports the token as
 * invalid (410 Unregistered / 400 BadDeviceToken).
 */
export function migrateCreatePushDevices(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS push_devices (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        token TEXT NOT NULL,
        device_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS push_devices_token_unique
      ON push_devices (token)
    `);

    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS push_devices_platform_idx
      ON push_devices (platform)
    `);
  });
}
