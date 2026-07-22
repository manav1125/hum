# Instance backups — ops notes (P0-5, alpha)

**Status:** built 2026-07-19, uncommitted on `cue/handoff-bundle`. Territory:
`assistant/**` only (HQ's `hq.db` backup is owned by another agent; the gateway
vbundle worker was left untouched).

## What ships

A **nightly online SQLite snapshot** of `assistant.db`, taken by the daemon
itself and designed around the known failure modes of the vbundle
export/restore path (resetDb deadlock on a busy daemon, ~2 GB OOM, HTTP
timeouts on large DBs):

- `PRAGMA wal_checkpoint(FULL)` then `VACUUM INTO` — both executed by a
  **sqlite3 CLI subprocess** (`runAsyncSqlite`), so the copy is a consistent
  read snapshot that never blocks the daemon's writers, never buffers the DB
  in the daemon process, and cannot deadlock. FULL, never TRUNCATE, per the
  WAL rules in `assistant/CLAUDE.md`. The Docker image installs `sqlite3`.
- Output is a compacted, fully-checkpointed **single-file DB** (no `.wal`/
  `.shm` sidecars), written to a hidden temp file, header-verified, then
  atomically renamed to `assistant-YYYYMMDD-HHMMSS.db`.
- **Rotation: keep 7** (config `backup.db.retention`).
- **Optional offsite ship** to any S3-compatible bucket (Tigris default) via
  a dependency-free SigV4 signed PUT, streamed from disk. Strictly after the
  local snapshot is durable; failure is logged and non-fatal.
- Scheduling piggybacks on the memory jobs worker tick (same
  checkpoint-gated pattern as `db-maintenance.ts`): default **ON**, runs at
  most once per `minIntervalHours` (20) inside a UTC quiet window
  (03:00–06:00). Failures log + skip; nothing blocks startup.

Code:

- `assistant/src/backup/db-snapshot.ts` — snapshot core + worker gate +
  restore runbook (file header)
- `assistant/src/backup/s3-offsite.ts` — env contract + SigV4 uploader
- `assistant/src/config/schemas/backup.ts` — new `backup.db` subtree
- `assistant/src/memory/jobs-worker.ts` — tick wiring
- `assistant/src/tools/terminal/safe-env.ts` — non-secret env forwarding
- Tests: `assistant/src/backup/__tests__/db-snapshot.test.ts`,
  `assistant/src/config/__tests__/backup-schema.test.ts`

## Config

```jsonc
// config.json (all defaults shown — nothing needs to be written to enable)
"backup": {
  "db": {
    "enabled": true,            // default ON
    "retention": 7,             // local snapshots kept
    "windowStartHourUtc": 3,    // quiet window [3, 6) UTC
    "windowEndHourUtc": 6,      // start == end → no window restriction
    "minIntervalHours": 20,     // 20 not 24 so a late run never skips a night
    "directory": null           // null → <backup root>/db
  }
}
```

Disable per instance: `assistant config set backup.db.enabled false`.

## Env contract

| Var | Required | Meaning |
| --- | --- | --- |
| `VELLUM_BACKUP_DIR` | **yes, on Fly** | Backup root. Point at the persistent volume (e.g. `/data/backups`); snapshots land in `<root>/db/`. Without it the default is `~/.vellum/backups/db` — on a Fly machine that may be the ephemeral rootfs. |
| `CUE_BACKUP_S3_BUCKET` | for offsite | Bucket name. Offsite is disabled unless bucket + both keys are set. |
| `CUE_BACKUP_S3_ACCESS_KEY_ID` | for offsite | Credential (never forwarded to agent child processes). |
| `CUE_BACKUP_S3_SECRET_ACCESS_KEY` | for offsite | Credential (same). |
| `CUE_BACKUP_S3_ENDPOINT` | no | Default `https://fly.storage.tigris.dev`. Works with R2/MinIO/S3 (path-style URLs). |
| `CUE_BACKUP_S3_REGION` | no | Default `auto` (Tigris). |
| `CUE_BACKUP_S3_PREFIX` | no | Object key prefix; defaults to `$FLY_APP_NAME`, else `cue-instance`. Keys: `<prefix>/assistant-YYYYMMDD-HHMMSS.db`. |

**Offsite retention is bucket-side by design** (upload-only keeps the
instance credential's blast radius to "write new objects" — prefer a key
without delete permission). Set a Tigris/S3 lifecycle rule, e.g. expire
objects after 30 days.

## Rollout (per instance; example cue-manav-prod)

Bare-machine Fly apps have no release, so env goes via `machine update`
(the same gotcha as the migration — `fly secrets set` fails):

```sh
fly machine update <machine-id> -a cue-manav-prod \
  --env VELLUM_BACKUP_DIR=/data/backups \
  --env CUE_BACKUP_S3_BUCKET=cue-instance-backups \
  --env CUE_BACKUP_S3_ACCESS_KEY_ID=tid_... \
  --env CUE_BACKUP_S3_SECRET_ACCESS_KEY=tsec_... \
  -y
```

(Adjust `/data` to the actual volume mount path of the instance.) Create the
Tigris bucket once: `fly storage create` in the org, one shared bucket, keys
scoped write-only if possible; per-instance separation comes from the
`$FLY_APP_NAME` prefix.

For newly provisioned instances, bake the two non-secret vars into the
provisioner's machine env and inject the key pair from HQ (HQ side is the
other agent's territory).

Verify next morning:

```sh
fly ssh console -a cue-manav-prod -C "ls -lh /data/backups/db"
# and in logs:  grep "Nightly DB snapshot complete"
```

First snapshot can also be forced by temporarily setting
`backup.db.windowStartHourUtc` = `windowEndHourUtc` (window off) — the
20 h min-interval still applies, so on a fresh DB (checkpoint 0) it runs on
the next worker tick.

## Restore runbook

(Also in the `db-snapshot.ts` file header.) Snapshots are plain SQLite
files; restore is a **daemon-off file swap** — never use the daemon's HTTP
restore on a live daemon (that is the path with the deadlock history).

1. Pick a snapshot from `<VELLUM_BACKUP_DIR>/db/` on the volume, or download
   from the bucket (`<prefix>/assistant-....db`).
2. Stop the daemon without losing the machine:
   `fly machine update <id> --entrypoint "sleep infinity" -y`
3. `fly ssh console`, then in the workspace data dir (contains
   `assistant.db`):
   ```sh
   mv assistant.db assistant.db.broken.$(date +%s)
   rm -f assistant.db-wal assistant.db-shm   # stale sidecars must not pair
   cp /data/backups/db/assistant-<TS>.db assistant.db
   ```
4. Revert the entrypoint (restore the original from the image config /
   redeploy) and let the daemon boot.
5. Verify `/readyz`, open the app, check newest conversations. RPO is
   nightly: writes after the snapshot timestamp are gone.

Whole-volume loss: `fly volumes snapshots list` → restore if Fly snapshots
exist, else fresh volume + newest offsite copy, then steps 3–5. Also set
`snapshot_retention` at volume-create time in the provisioner (fly-driver —
HQ territory, flagged to that agent).

## Watch items / known limits

- **Worker coupling:** the snapshot gate runs on the memory jobs worker
  tick. If `memory.enabled=false` the worker never ticks and snapshots stop.
  No alpha instance runs with memory off; revisit if that changes.
- **Failure cadence:** the checkpoint advances on failed attempts too, so a
  persistently failing snapshot retries nightly (loud `Nightly DB snapshot
  failed` error log each night) rather than hammering every tick. Pair with
  P0-6 alerting.
- **Scope:** DB only. Config/credentials/workspace files are not in the
  snapshot — full-workspace migration remains the vbundle path. For alpha,
  the DB is the unrecoverable asset (config is reprovisionable, credentials
  re-auth).
- **Disk headroom:** VACUUM INTO writes a compacted copy, and 7 copies of a
  compacted DB fit easily after the conversation-prune work (25 MB class),
  but a runaway DB (500 MB class) × 7 ≈ 3.5 GB — the disk-pressure guard
  already skips background work (including this gate) under pressure.
- **Gateway vbundle worker** (`gateway/src/backup/backup-worker.ts`) is
  unchanged and still default-off with a macOS iCloud offsite default; it
  remains the desktop/self-host full-workspace story, not the instance one.
