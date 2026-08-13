/**
 * Regression cover for `writeConfigFileAtomic` preserving the ownership of the
 * config file it replaces.
 *
 * `$VELLUM_WORKSPACE_DIR/config.json` has two writers: the gateway replaces it
 * atomically (tmp file + rename) and the daemon writes it in place
 * (`assistant/src/config/loader.ts` `saveRawConfig`). Under
 * `CUE_DROP_DAEMON_PRIVILEGES=1` the gateway is root and the daemon is uid
 * 1001, so before this fix the first gateway-side write — a privacy-settings
 * save, or velay — replaced the 1001-owned file with a root-owned one and
 * every later daemon config write failed EACCES. Several of those call sites
 * swallow the error, so it degrades into "settings silently don't stick".
 *
 * These tests drive the injected fs seam rather than real ownership: a
 * non-root test process cannot `chown` a file to another uid, so a test that
 * required a genuinely cross-uid file could only ever be skipped. What is
 * asserted here is the decision — whether we chown, with what arguments, and
 * that the write survives the chown failing. The last real-fs test covers the
 * same-uid path, which is every deployment today.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import {
  type OwnershipFsOps,
  writeConfigFileAtomic,
} from "../config-file-utils.js";
import { testWorkspaceDir } from "./test-preload.js";

const configPath = join(testWorkspaceDir, "config.json");

type ChownCall = { path: string; uid: number; gid: number };
type ChmodCall = { path: string; mode: number };

/**
 * A fake `node:fs` for the ownership step. `statSync` answers from a table
 * keyed by "is this the target or the tmp file", which is how we stage a
 * cross-uid situation without needing root.
 */
function fakeOps(opts: {
  target: { uid: number; gid: number; mode: number };
  tmp: { uid: number; gid: number; mode: number };
  chownThrows?: Error;
  chmodThrows?: Error;
  statThrows?: Error;
}): {
  ops: OwnershipFsOps;
  chowns: ChownCall[];
  chmods: ChmodCall[];
} {
  const chowns: ChownCall[] = [];
  const chmods: ChmodCall[] = [];
  const ops: OwnershipFsOps = {
    statSync: (path) => {
      if (opts.statThrows) throw opts.statThrows;
      return path === configPath ? opts.target : opts.tmp;
    },
    chownSync: (path, uid, gid) => {
      chowns.push({ path, uid, gid });
      if (opts.chownThrows) throw opts.chownThrows;
    },
    chmodSync: (path, mode) => {
      chmods.push({ path, mode });
      if (opts.chmodThrows) throw opts.chmodThrows;
    },
  };
  return { ops, chowns, chmods };
}

/** Seed an existing config.json owned (for real) by the test process. */
function seedConfig(data: Record<string, unknown>): void {
  writeConfigFileAtomic(data);
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

afterEach(() => {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    /* best-effort */
  }
});

describe("writeConfigFileAtomic: ownership preservation", () => {
  test("carries the existing file's uid/gid onto the replacement", () => {
    seedConfig({ privacy: { telemetry: false } });

    // Stage the CUE_DROP_DAEMON_PRIVILEGES shape: the file on disk belongs to
    // the daemon (1001), the tmp file we just wrote belongs to root.
    const { ops, chowns } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100644 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
    });

    writeConfigFileAtomic({ privacy: { telemetry: true } }, ops);

    expect(chowns).toHaveLength(1);
    expect(chowns[0]?.uid).toBe(1001);
    expect(chowns[0]?.gid).toBe(1001);
    // The chown lands on the tmp file, before the rename — so the file is
    // never visible at the real path with the wrong owner.
    expect(chowns[0]?.path).not.toBe(configPath);
    expect(chowns[0]?.path).toContain(".config.");
    expect(chowns[0]?.path.endsWith(".tmp")).toBe(true);

    // ...and the write itself still happened.
    expect(readConfig()).toEqual({ privacy: { telemetry: true } });
  });

  test("preserves a narrowed mode rather than widening it to the umask default", () => {
    seedConfig({ a: 1 });

    const { ops, chmods } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100600 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
    });

    writeConfigFileAtomic({ a: 2 }, ops);

    expect(chmods).toHaveLength(1);
    expect(chmods[0]?.mode).toBe(0o600);
    expect(readConfig()).toEqual({ a: 2 });
  });

  test("does not chown when the file does not exist yet", () => {
    expect(existsSync(configPath)).toBe(false);

    // Deliberately mismatched stats: if the code consulted them at all on the
    // create path it would chown, and this assertion would catch it.
    const { ops, chowns, chmods } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100600 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
    });

    writeConfigFileAtomic({ fresh: true }, ops);

    expect(chowns).toHaveLength(0);
    expect(chmods).toHaveLength(0);
    expect(readConfig()).toEqual({ fresh: true });
  });

  test("completes the write when the chown fails", () => {
    seedConfig({ before: true });

    const { ops, chowns } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100644 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
      chownThrows: Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM",
      }),
    });

    expect(() => writeConfigFileAtomic({ after: true }, ops)).not.toThrow();
    expect(chowns).toHaveLength(1);
    // Losing the ownership is a latent permissions problem; losing the write
    // is a lost user setting right now. The write must win.
    expect(readConfig()).toEqual({ after: true });
  });

  test("completes the write when the stat fails", () => {
    seedConfig({ before: true });

    const { ops, chowns, chmods } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100644 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
      statThrows: Object.assign(new Error("EACCES"), { code: "EACCES" }),
    });

    expect(() => writeConfigFileAtomic({ after: true }, ops)).not.toThrow();
    expect(chowns).toHaveLength(0);
    expect(chmods).toHaveLength(0);
    expect(readConfig()).toEqual({ after: true });
  });

  test("issues no chown or chmod when owner and mode already match", () => {
    seedConfig({ same: 1 });

    const identical = { uid: 501, gid: 20, mode: 0o100644 };
    const { ops, chowns, chmods } = fakeOps({
      target: identical,
      tmp: identical,
    });

    writeConfigFileAtomic({ same: 2 }, ops);

    // This is the same-uid case — every deployment today. It must stay
    // syscall-for-syscall what it was before the fix.
    expect(chowns).toHaveLength(0);
    expect(chmods).toHaveLength(0);
    expect(readConfig()).toEqual({ same: 2 });
  });

  test("real fs: a same-uid rewrite leaves owner and mode untouched", () => {
    seedConfig({ v: 1 });
    const before = statSync(configPath);

    // No injected ops: the production path, against the real filesystem, as
    // the unprivileged test user.
    writeConfigFileAtomic({ v: 2 });

    const after = statSync(configPath);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(readConfig()).toEqual({ v: 2 });
  });

  test("leaves no temp file behind", () => {
    seedConfig({ v: 1 });
    const { ops } = fakeOps({
      target: { uid: 1001, gid: 1001, mode: 0o100600 },
      tmp: { uid: 0, gid: 0, mode: 0o100644 },
    });
    writeConfigFileAtomic({ v: 2 }, ops);

    const leftovers = readdirSync(testWorkspaceDir).filter(
      (f) => f.startsWith(".config.") && f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
