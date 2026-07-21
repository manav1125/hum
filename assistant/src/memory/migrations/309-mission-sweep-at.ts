import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Mission sweep clock — add `sweep_at` (local "HH:mm") to missions.
 *
 * The cadence engine previously fired daily/weekly cycles on a rolling
 * interval from `last_cycle_at`, so sweep times drifted with daemon restarts
 * and manual runs. `sweep_at` anchors daily/weekly sweeps to a wall-clock
 * time in the daemon's timezone (hourly cadence ignores it). New missions
 * default to "08:00" at the store layer; existing rows stay NULL and keep
 * the legacy rolling-interval behavior — the honest clock-less fallback
 * (clients render "sweeps daily" without a time).
 */
export function migrateMissionSweepAt(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (!tableHasColumn(database, "missions", "sweep_at")) {
    raw.exec(/*sql*/ `ALTER TABLE missions ADD COLUMN sweep_at TEXT`);
  }
}
