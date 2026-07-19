/**
 * Tests for the nightly online DB snapshot (`db-snapshot.ts`).
 *
 * All filesystem work runs against temp directories. Snapshot creation is
 * exercised with a real bun:sqlite database and an injected `executeSql`
 * runner (production uses the sqlite3 CLI subprocess via `runAsyncSqlite`;
 * the injected runner opens its own connection on the same file, which is
 * the same "separate connection takes the read snapshot" topology).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  formatDbSnapshotFilename,
  isInBackupWindow,
  listDbSnapshots,
  parseDbSnapshotTimestamp,
  performDbSnapshot,
  pruneDbSnapshots,
} from "../db-snapshot.js";
import { readS3ConfigFromEnv, signS3Put } from "../s3-offsite.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cue-db-snapshot-"));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Runs SQL against `dbPath` on a fresh connection, like the CLI backend. */
function makeRunner(dbPath: string) {
  return async (sql: string) => {
    try {
      const db = new Database(dbPath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
      return { ok: true, error: null };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

function createSourceDb(dbPath: string, rows = 5): void {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  for (let i = 0; i < rows; i++) {
    db.exec(`INSERT INTO items (name) VALUES ('row-${i}')`);
  }
  db.close();
}

describe("snapshot filenames", () => {
  test("format/parse round-trip (UTC, second precision)", () => {
    const now = new Date("2026-07-19T03:14:15.926Z");
    const filename = formatDbSnapshotFilename(now);
    expect(filename).toBe("assistant-20260719-031415.db");
    expect(parseDbSnapshotTimestamp(filename)?.toISOString()).toBe(
      "2026-07-19T03:14:15.000Z",
    );
  });

  test("accepts collision-suffixed names, rejects everything else", () => {
    expect(
      parseDbSnapshotTimestamp("assistant-20260719-031415-a1b2c3.db"),
    ).not.toBeNull();
    expect(parseDbSnapshotTimestamp("assistant.db")).toBeNull();
    expect(parseDbSnapshotTimestamp(".partial-deadbeef.db")).toBeNull();
    expect(
      parseDbSnapshotTimestamp("backup-20260719-031415.vbundle"),
    ).toBeNull();
    // Calendar-normalized garbage (Feb 31) must not round-trip.
    expect(parseDbSnapshotTimestamp("assistant-20260231-031415.db")).toBeNull();
  });
});

describe("listDbSnapshots / pruneDbSnapshots", () => {
  test("lists newest-first and ignores non-snapshot clutter", async () => {
    const dir = join(root, "snaps");
    mkdirSync(dir);
    writeFileSync(join(dir, "assistant-20260101-000000.db"), "a");
    writeFileSync(join(dir, "assistant-20260301-000000.db"), "c");
    writeFileSync(join(dir, "assistant-20260201-000000.db"), "b");
    writeFileSync(join(dir, ".partial-abc123.db"), "junk");
    writeFileSync(join(dir, "README.txt"), "junk");

    const entries = await listDbSnapshots(dir);
    expect(entries.map((e) => e.filename)).toEqual([
      "assistant-20260301-000000.db",
      "assistant-20260201-000000.db",
      "assistant-20260101-000000.db",
    ]);
  });

  test("missing directory lists as empty", async () => {
    expect(await listDbSnapshots(join(root, "nope"))).toEqual([]);
  });

  test("prune keeps the newest N and deletes the rest", async () => {
    const dir = join(root, "rotate");
    mkdirSync(dir);
    for (let day = 1; day <= 10; day++) {
      const dd = String(day).padStart(2, "0");
      writeFileSync(join(dir, `assistant-202607${dd}-030000.db`), "x");
    }

    const { kept, deleted } = await pruneDbSnapshots(dir, 7);
    expect(kept).toHaveLength(7);
    expect(deleted.map((e) => e.filename).sort()).toEqual([
      "assistant-20260701-030000.db",
      "assistant-20260702-030000.db",
      "assistant-20260703-030000.db",
    ]);
    expect(readdirSync(dir).sort()).toEqual(kept.map((e) => e.filename).sort());
  });

  test("prune with retention >= count deletes nothing", async () => {
    const dir = join(root, "under");
    mkdirSync(dir);
    writeFileSync(join(dir, "assistant-20260701-030000.db"), "x");
    const { kept, deleted } = await pruneDbSnapshots(dir, 7);
    expect(kept).toHaveLength(1);
    expect(deleted).toHaveLength(0);
  });
});

describe("isInBackupWindow", () => {
  test("plain window [3, 6)", () => {
    expect(isInBackupWindow(2, 3, 6)).toBe(false);
    expect(isInBackupWindow(3, 3, 6)).toBe(true);
    expect(isInBackupWindow(5, 3, 6)).toBe(true);
    expect(isInBackupWindow(6, 3, 6)).toBe(false);
  });

  test("midnight-wrapping window [22, 2)", () => {
    expect(isInBackupWindow(23, 22, 2)).toBe(true);
    expect(isInBackupWindow(1, 22, 2)).toBe(true);
    expect(isInBackupWindow(2, 22, 2)).toBe(false);
    expect(isInBackupWindow(12, 22, 2)).toBe(false);
  });

  test("start == end means no restriction", () => {
    expect(isInBackupWindow(0, 4, 4)).toBe(true);
    expect(isInBackupWindow(15, 4, 4)).toBe(true);
  });
});

describe("performDbSnapshot", () => {
  test("creates a valid standalone SQLite snapshot and rotates old ones", async () => {
    const dbPath = join(root, "assistant.db");
    createSourceDb(dbPath, 25);
    const dir = join(root, "backups", "db");
    mkdirSync(dir, { recursive: true });
    // Pre-existing snapshots: retention 2 → after the new one, only the
    // newest two survive.
    writeFileSync(join(dir, "assistant-20260101-030000.db"), "old-1");
    writeFileSync(join(dir, "assistant-20260102-030000.db"), "old-2");

    const now = new Date("2026-07-19T03:30:00Z");
    const result = await performDbSnapshot({
      dbPath,
      dir,
      retention: 2,
      now,
      executeSql: makeRunner(dbPath),
    });

    expect(result.entry.filename).toBe("assistant-20260719-033000.db");
    expect(result.entry.sizeBytes).toBeGreaterThan(0);
    expect(result.prunedCount).toBe(1);
    expect(existsSync(result.entry.path)).toBe(true);

    // The snapshot is an independent, readable SQLite DB with the data.
    const snap = new Database(result.entry.path, { readonly: true });
    const count = snap.query("SELECT COUNT(*) AS c FROM items").get() as {
      c: number;
    };
    snap.close();
    expect(count.c).toBe(25);

    // Rotation kept the new snapshot + the newest old one; no temp files.
    const names = readdirSync(dir).sort();
    expect(names).toEqual([
      "assistant-20260102-030000.db",
      "assistant-20260719-033000.db",
    ]);
  });

  test("failure leaves no partial files and throws", async () => {
    const dbPath = join(root, "assistant.db");
    createSourceDb(dbPath);
    const dir = join(root, "failing");

    await expect(
      performDbSnapshot({
        dbPath,
        dir,
        retention: 7,
        executeSql: async (sql) =>
          sql.startsWith("VACUUM")
            ? { ok: false, error: "disk I/O error" }
            : { ok: true, error: null },
      }),
    ).rejects.toThrow("VACUUM INTO failed");

    // Directory was created but holds no partial or snapshot files.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("rejects a snapshot that is not a SQLite file", async () => {
    const dbPath = join(root, "assistant.db");
    createSourceDb(dbPath);
    const dir = join(root, "corrupt");

    await expect(
      performDbSnapshot({
        dbPath,
        dir,
        retention: 7,
        executeSql: async (sql) => {
          if (sql.startsWith("VACUUM INTO")) {
            // Simulate a runner that "succeeds" but writes garbage.
            const target = /'(.*)'/.exec(sql)![1]!.replace(/''/g, "'");
            writeFileSync(target, "not a database");
          }
          return { ok: true, error: null };
        },
      }),
    ).rejects.toThrow("not a SQLite database");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("s3-offsite config + signing", () => {
  test("incomplete env disables offsite", () => {
    expect(readS3ConfigFromEnv({})).toBeNull();
    expect(
      readS3ConfigFromEnv({ CUE_BACKUP_S3_BUCKET: "cue-backups" }),
    ).toBeNull();
    expect(
      readS3ConfigFromEnv({
        CUE_BACKUP_S3_BUCKET: "cue-backups",
        CUE_BACKUP_S3_ACCESS_KEY_ID: "AKID",
      }),
    ).toBeNull();
  });

  test("complete env resolves with Tigris defaults and Fly-app prefix", () => {
    const cfg = readS3ConfigFromEnv({
      CUE_BACKUP_S3_BUCKET: "cue-backups",
      CUE_BACKUP_S3_ACCESS_KEY_ID: "AKID",
      CUE_BACKUP_S3_SECRET_ACCESS_KEY: "SECRET",
      FLY_APP_NAME: "cue-manav-prod",
    });
    expect(cfg).toEqual({
      endpoint: "https://fly.storage.tigris.dev",
      bucket: "cue-backups",
      region: "auto",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      prefix: "cue-manav-prod",
    });
  });

  test("explicit endpoint/region/prefix override defaults; slashes trimmed", () => {
    const cfg = readS3ConfigFromEnv({
      CUE_BACKUP_S3_BUCKET: "b",
      CUE_BACKUP_S3_ACCESS_KEY_ID: "AKID",
      CUE_BACKUP_S3_SECRET_ACCESS_KEY: "SECRET",
      CUE_BACKUP_S3_ENDPOINT: "https://minio.internal:9000/",
      CUE_BACKUP_S3_REGION: "us-east-1",
      CUE_BACKUP_S3_PREFIX: "inst-42/",
    });
    expect(cfg?.endpoint).toBe("https://minio.internal:9000");
    expect(cfg?.region).toBe("us-east-1");
    expect(cfg?.prefix).toBe("inst-42");
  });

  test("signed PUT is deterministic and well-formed (regression pin)", () => {
    const cfg = {
      endpoint: "https://fly.storage.tigris.dev",
      bucket: "cue-backups",
      region: "auto",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      prefix: "cue-manav-prod",
    };
    const now = new Date("2026-07-19T03:45:00Z");
    const signed = signS3Put(
      cfg,
      "cue-manav-prod/assistant-20260719-034500.db",
      1024,
      now,
    );

    expect(signed.url).toBe(
      "https://fly.storage.tigris.dev/cue-backups/cue-manav-prod/assistant-20260719-034500.db",
    );
    expect(signed.headers["x-amz-date"]).toBe("20260719T034500Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(signed.headers["Content-Length"]).toBe("1024");
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260719\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // Deterministic: same inputs, same signature.
    const again = signS3Put(
      cfg,
      "cue-manav-prod/assistant-20260719-034500.db",
      1024,
      now,
    );
    expect(again.headers.Authorization).toBe(signed.headers.Authorization);
  });
});
