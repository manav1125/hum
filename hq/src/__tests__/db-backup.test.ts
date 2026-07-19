/**
 * P0-5 (HQ half): hq.db snapshot backups — VACUUM INTO copies, rotation,
 * and readability of the snapshot (it must open as a complete HqDb).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDbBackup, defaultBackupDir } from "../db-backup.js";
import { HqDb } from "../db.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hq-backup-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runDbBackup", () => {
  test("snapshot is a complete, independently readable copy", () => {
    const db = new HqDb(":memory:");
    const customer = db.createCustomer({ email: "maya@example.com", name: "Maya" });
    db.addInviteEmail("wave1@example.com");

    const result = runDbBackup(db, { dir, keep: 5 });
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();

    const copy = new HqDb(result.path!);
    expect(copy.getCustomer(customer.id)?.email).toBe("maya@example.com");
    expect(copy.isEmailInvited("wave1@example.com")).toBe(true);
    copy.close();
    db.close();
  });

  test("rotation prunes oldest snapshots beyond keep", () => {
    const db = new HqDb(":memory:");
    for (let i = 0; i < 5; i++) {
      const result = runDbBackup(db, {
        dir,
        keep: 3,
        now: new Date(Date.UTC(2026, 6, 19, 3, 0, i)),
      });
      expect(result.ok).toBe(true);
    }
    const files = readdirSync(dir).filter((f) => f.startsWith("hq-"));
    expect(files.length).toBe(3);
    // Oldest two (…000000 / …000001) were pruned; the newest survive.
    expect(files.sort()[0]).toContain("030002");
    db.close();
  });

  test("non-snapshot files in the backup dir are never touched", () => {
    const db = new HqDb(":memory:");
    writeFileSync(join(dir, "keep-me.txt"), "important");
    for (let i = 0; i < 3; i++) {
      runDbBackup(db, { dir, keep: 1, now: new Date(Date.UTC(2026, 6, 19, 4, 0, i)) });
    }
    const files = readdirSync(dir);
    expect(files).toContain("keep-me.txt");
    expect(files.filter((f) => f.startsWith("hq-")).length).toBe(1);
    db.close();
  });

  test("failure is reported, not thrown", () => {
    const db = new HqDb(":memory:");
    const result = runDbBackup(db, { dir: "/nonexistent-root/nope", keep: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    db.close();
  });
});

describe("defaultBackupDir", () => {
  test("env override wins; else <db dir>/backups", () => {
    const savedDir = process.env.HQ_DB_BACKUP_DIR;
    const savedPath = process.env.HQ_DB_PATH;
    try {
      process.env.HQ_DB_BACKUP_DIR = "/data/backups";
      expect(defaultBackupDir()).toBe("/data/backups");
      delete process.env.HQ_DB_BACKUP_DIR;
      process.env.HQ_DB_PATH = "/data/hq.db";
      expect(defaultBackupDir()).toBe("/data/backups");
    } finally {
      if (savedDir === undefined) delete process.env.HQ_DB_BACKUP_DIR;
      else process.env.HQ_DB_BACKUP_DIR = savedDir;
      if (savedPath === undefined) delete process.env.HQ_DB_PATH;
      else process.env.HQ_DB_PATH = savedPath;
    }
  });
});
