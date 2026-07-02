/**
 * CRUD for the `push_devices` registry — mobile device tokens registered
 * for remote push (APNs today, FCM later).
 *
 * Tokens are unique: registering an already-known token refreshes its
 * metadata (`deviceName`, `lastSeenAt`) instead of inserting a duplicate,
 * so clients can safely re-register on every app launch. Devices are
 * removed either explicitly (user disables push / signs out) or by the
 * APNs sender when Apple reports the token invalid (410 Unregistered /
 * 400 BadDeviceToken).
 */

import { eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { pushDevices } from "../memory/schema.js";

export type PushDevicePlatform = "ios" | "android";

export interface PushDevice {
  id: string;
  platform: PushDevicePlatform;
  token: string;
  deviceName: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
}

function rowToDevice(row: typeof pushDevices.$inferSelect): PushDevice {
  return {
    id: row.id,
    platform: row.platform as PushDevicePlatform,
    token: row.token,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Register a device token, or refresh it when the token is already known.
 * Idempotent — safe to call on every app launch.
 */
export function registerPushDevice(opts: {
  platform: PushDevicePlatform;
  token: string;
  deviceName?: string;
}): PushDevice {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.token, opts.token))
    .get();

  if (existing) {
    db.update(pushDevices)
      .set({
        platform: opts.platform,
        // Only overwrite the stored name when the client sent one — a
        // re-registration without a name must not erase a known name.
        ...(opts.deviceName !== undefined
          ? { deviceName: opts.deviceName }
          : {}),
        updatedAt: now,
        lastSeenAt: now,
      })
      .where(eq(pushDevices.token, opts.token))
      .run();
    const updated = db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.token, opts.token))
      .get();
    // The row cannot vanish between the update and the re-read on the
    // daemon's single SQLite connection; fall back defensively anyway.
    return updated ? rowToDevice(updated) : rowToDevice(existing);
  }

  const row: typeof pushDevices.$inferInsert = {
    id: crypto.randomUUID(),
    platform: opts.platform,
    token: opts.token,
    deviceName: opts.deviceName ?? null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  db.insert(pushDevices).values(row).run();
  return rowToDevice(row as typeof pushDevices.$inferSelect);
}

/** List registered devices, optionally filtered by platform. */
export function listPushDevices(platform?: PushDevicePlatform): PushDevice[] {
  const db = getDb();
  const rows = platform
    ? db
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.platform, platform))
        .all()
    : db.select().from(pushDevices).all();
  return rows.map(rowToDevice);
}

/**
 * Remove a device token. Returns true when a row was deleted, false when
 * the token was not registered (idempotent — callers treat both as success).
 */
export function removePushDevice(token: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: pushDevices.id })
    .from(pushDevices)
    .where(eq(pushDevices.token, token))
    .get();
  if (!existing) return false;
  db.delete(pushDevices).where(eq(pushDevices.token, token)).run();
  return true;
}
