/**
 * Cue HQ — hq.db backup (P0-5, HQ half of the alpha-readiness audit).
 *
 * hq.db holds every customer row AND every instance's actor-token signing
 * key in plaintext (instances.secretsJson). Losing the volume it lives on
 * would make magic-link sign-in unrecoverable for every existing customer.
 * Until an offsite target exists, this module provides the minimum safety
 * net: a boot-time WAL checkpoint plus timestamped, rotated snapshots via
 * SQLite `VACUUM INTO` (consistent single-transaction copies, no -wal/-shm
 * sidecars).
 *
 * Snapshots land in HQ_DB_BACKUP_DIR — on Fly that should be a directory on
 * the /data volume (default: <db dir>/backups → /data/backups in prod), so
 * they at least survive an app redeploy/crash and ride along in Fly's
 * volume snapshots. A same-volume copy does NOT survive volume loss;
 * pairing this with Fly's automatic volume snapshots (retention set at
 * volume-create; see fly-driver.ts) is the alpha-grade story, and a true
 * offsite target (Litestream / object storage) is the documented follow-up.
 *
 * Env contract:
 *   HQ_DB_BACKUP_DIR         — snapshot directory (default <db dir>/backups)
 *   HQ_DB_BACKUP_INTERVAL_MS — snapshot cadence (default 21600000 = 6 h)
 *   HQ_DB_BACKUP_KEEP        — snapshots to retain (default 28 ≈ 7 days @ 6 h)
 *   HQ_DB_BACKUP_DISABLED    — "1"/"true" turns the scheduler off (dev)
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { HqDb } from "./db.js";

export const BACKUP_PREFIX = "hq-";
export const BACKUP_SUFFIX = ".db";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_KEEP = 28;

export interface DbBackupOptions {
  /** Snapshot directory (default: HQ_DB_BACKUP_DIR → <db dir>/backups). */
  dir?: string;
  /** Snapshots to retain, oldest pruned first (default HQ_DB_BACKUP_KEEP). */
  keep?: number;
  /** Timestamp override for deterministic tests. */
  now?: Date;
}

export function defaultBackupDir(): string {
  const fromEnv = process.env.HQ_DB_BACKUP_DIR?.trim();
  if (fromEnv) return fromEnv;
  const dbPath = process.env.HQ_DB_PATH ?? "hq.db";
  return join(dirname(resolve(dbPath)), "backups");
}

function timestampSlug(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
}

export interface DbBackupResult {
  ok: boolean;
  path?: string;
  /** Snapshot files pruned by rotation. */
  pruned: string[];
  error?: string;
}

/**
 * Take one snapshot + rotate. Never throws — the caller records the outcome
 * as an audit event and a backup failure must never take HQ down.
 */
export function runDbBackup(db: HqDb, opts: DbBackupOptions = {}): DbBackupResult {
  const dir = opts.dir ?? defaultBackupDir();
  const keep = Math.max(
    1,
    opts.keep ?? Number(process.env.HQ_DB_BACKUP_KEEP ?? DEFAULT_KEEP),
  );
  try {
    mkdirSync(dir, { recursive: true });
    let dest = join(
      dir,
      `${BACKUP_PREFIX}${timestampSlug(opts.now ?? new Date())}${BACKUP_SUFFIX}`,
    );
    // VACUUM INTO refuses to overwrite; de-collide sub-second re-runs.
    try {
      statSync(dest);
      dest = dest.replace(
        BACKUP_SUFFIX,
        `-${Math.random().toString(36).slice(2, 6)}${BACKUP_SUFFIX}`,
      );
    } catch {
      // dest does not exist — the normal case.
    }
    db.backupTo(dest);

    const snapshots = readdirSync(dir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .sort(); // timestamp-named ⇒ lexicographic = chronological
    const pruned: string[] = [];
    while (snapshots.length > keep) {
      const victim = snapshots.shift()!;
      try {
        unlinkSync(join(dir, victim));
        pruned.push(victim);
      } catch {
        // Already gone / permission hiccup — rotation retries next run.
      }
    }
    return { ok: true, path: dest, pruned };
  } catch (err) {
    return {
      ok: false,
      pruned: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isBackupDisabled(): boolean {
  const raw = process.env.HQ_DB_BACKUP_DISABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Boot wiring: checkpoint the WAL, take an immediate snapshot, then repeat
 * on an interval. Outcomes are recorded as `db_backup_completed` /
 * `db_backup_failed` audit events (visible on /admin and /admin/status).
 */
export function startDbBackupScheduler(
  db: HqDb,
  opts: DbBackupOptions & { intervalMs?: number } = {},
): { stop: () => void } {
  if (isBackupDisabled()) {
    console.warn("[hq/backup] HQ_DB_BACKUP_DISABLED — hq.db backups are OFF");
    return { stop: () => {} };
  }
  const intervalMs =
    opts.intervalMs ??
    Number(process.env.HQ_DB_BACKUP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);

  const tick = () => {
    const result = runDbBackup(db, opts);
    if (result.ok) {
      db.recordEvent("db_backup_completed", null, {
        path: result.path,
        pruned: result.pruned.length,
      });
      console.info(`[hq/backup] snapshot written: ${result.path}`);
    } else {
      db.recordEvent("db_backup_failed", null, { error: result.error });
      console.error(`[hq/backup] SNAPSHOT FAILED: ${result.error}`);
    }
  };

  tick(); // boot-time checkpoint + first snapshot, synchronously
  const timer = setInterval(tick, intervalMs);
  // Never hold the process open just for backups.
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
