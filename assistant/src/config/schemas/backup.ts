import { z } from "zod";

export const BackupDestinationSchema = z
  .object({
    path: z
      .string({ error: "backup.offsite.destinations[].path must be a string" })
      .describe("Absolute path to the offsite destination directory"),
    encrypt: z
      .boolean({
        error: "backup.offsite.destinations[].encrypt must be a boolean",
      })
      .default(true)
      .describe(
        "Encrypt backups written to this destination. Defaults to true; set to false only for destinations where the user trusts physical control (e.g. an external SSD).",
      ),
  })
  .describe("A single offsite backup destination");

export type BackupDestination = z.infer<typeof BackupDestinationSchema>;

export const BackupOffsiteConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "backup.offsite.enabled must be a boolean" })
      .default(true)
      .describe("Whether offsite backup is enabled"),
    destinations: z
      .array(BackupDestinationSchema)
      .nullable()
      .default(null)
      .describe(
        "Offsite destinations. null means use the default iCloud Drive destination with encryption on; an explicit array (including []) overrides the default.",
      ),
  })
  .describe("Offsite backup configuration");

export type BackupOffsiteConfig = z.infer<typeof BackupOffsiteConfigSchema>;

export const DbSnapshotConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "backup.db.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the nightly online SQLite snapshot of the assistant DB is enabled. Default ON — this is the instance-level data-loss safety net. Snapshots are taken with VACUUM INTO from a sqlite3 subprocess, which never blocks the live daemon.",
      ),
    retention: z
      .number({ error: "backup.db.retention must be a number" })
      .int("backup.db.retention must be an integer")
      .min(1, "backup.db.retention must be >= 1")
      .max(60, "backup.db.retention must be <= 60")
      .default(7)
      .describe("Number of local DB snapshots to retain (oldest pruned)"),
    windowStartHourUtc: z
      .number({ error: "backup.db.windowStartHourUtc must be a number" })
      .int("backup.db.windowStartHourUtc must be an integer")
      .min(0, "backup.db.windowStartHourUtc must be >= 0")
      .max(23, "backup.db.windowStartHourUtc must be <= 23")
      .default(3)
      .describe(
        "Start of the UTC quiet window (inclusive hour) in which the nightly snapshot may run",
      ),
    windowEndHourUtc: z
      .number({ error: "backup.db.windowEndHourUtc must be a number" })
      .int("backup.db.windowEndHourUtc must be an integer")
      .min(0, "backup.db.windowEndHourUtc must be >= 0")
      .max(24, "backup.db.windowEndHourUtc must be <= 24")
      .default(6)
      .describe(
        "End of the UTC quiet window (exclusive hour). A window that wraps midnight (start > end) is supported; start == end means no window restriction.",
      ),
    minIntervalHours: z
      .number({ error: "backup.db.minIntervalHours must be a number" })
      .int("backup.db.minIntervalHours must be an integer")
      .min(1, "backup.db.minIntervalHours must be >= 1")
      .max(168, "backup.db.minIntervalHours must be <= 168")
      .default(20)
      .describe(
        "Minimum hours between snapshots. 20 (not 24) so a nightly window is never skipped because yesterday's run landed late in the window.",
      ),
    directory: z
      .string({ error: "backup.db.directory must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Directory for DB snapshots. null means <backup root>/db, where the backup root honors VELLUM_BACKUP_DIR (set it to a persistent-volume path in containerized deployments).",
      ),
  })
  .describe(
    "Nightly online SQLite snapshot of the assistant DB (see src/backup/db-snapshot.ts)",
  );

export type DbSnapshotConfig = z.infer<typeof DbSnapshotConfigSchema>;

export const BackupConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "backup.enabled must be a boolean" })
      .default(false)
      .describe("Whether automated backups are enabled"),
    intervalHours: z
      .number({ error: "backup.intervalHours must be a number" })
      .int("backup.intervalHours must be an integer")
      .min(1, "backup.intervalHours must be >= 1")
      .max(168, "backup.intervalHours must be <= 168")
      .default(6)
      .describe("Interval between automated backups, in hours"),
    retention: z
      .number({ error: "backup.retention must be a number" })
      .int("backup.retention must be an integer")
      .min(1, "backup.retention must be >= 1")
      .max(100, "backup.retention must be <= 100")
      .default(3)
      .describe("Number of recent backups to retain"),
    offsite: BackupOffsiteConfigSchema.default(
      BackupOffsiteConfigSchema.parse({}),
    ),
    db: DbSnapshotConfigSchema.default(DbSnapshotConfigSchema.parse({})),
    localDirectory: z
      .string({ error: "backup.localDirectory must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Directory for local backup snapshots. null means use the default workspace-adjacent location.",
      ),
  })
  .describe("Automated backup configuration");

export type BackupConfig = z.infer<typeof BackupConfigSchema>;
