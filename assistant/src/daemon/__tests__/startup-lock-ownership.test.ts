/**
 * Breaking the daemon startup lock must be decided by ownership, not age.
 *
 * The lock used to be broken on elapsed time alone, which gets the dangerous
 * case backwards. A daemon that legitimately takes longer than the timeout to
 * start is not a crashed one — and stealing its lock starts a SECOND daemon
 * against the same workspace. That is the one failure this codebase refuses to
 * degrade into: two daemons are invisible to health checks, unreachable by
 * stop commands, and both keep running the scheduler, memory worker and
 * background wake against a shared database, so every side effect happens
 * twice.
 *
 * The inverse matters too: a crashed starter must not block the next one for
 * a full two minutes when its process is provably gone.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import { getDaemonStartupLockPath } from "../../util/platform.js";
import { acquireStartupLock, releaseStartupLock } from "../daemon-control.js";

const lockPath = getDaemonStartupLockPath();

function clearLock(): void {
  rmSync(lockPath, { force: true });
}
afterEach(clearLock);

describe("startup lock ownership", () => {
  test("acquiring records this process as the owner", () => {
    clearLock();
    expect(acquireStartupLock()).toBe(true);

    const rec = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid: number;
      ts: number;
    };
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.ts).toBe("number");
  });

  test("a lock held by a LIVE owner is not broken while it is fresh", () => {
    // The regression that matters: a slow start is not a crashed one, and
    // stealing its lock is what produces two daemons.
    clearLock();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );

    expect(acquireStartupLock()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a live owner past the stale window still loses the lock", () => {
    // The escape hatch for PID reuse. Liveness alone cannot distinguish our
    // holder from an unrelated process that inherited its number, so age
    // remains the backstop — without it such a lock would never be released.
    clearLock();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60_000 }),
    );

    expect(acquireStartupLock()).toBe(true);
  });

  test("a lock whose owner is gone is broken immediately, however fresh", () => {
    // A crashed starter must not block the next one for the stale timeout.
    // PID 0x7FFFFFFF is above any real pid_max, so it cannot be running.
    clearLock();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 0x7fffffff, ts: Date.now() }),
    );

    expect(acquireStartupLock()).toBe(true);
    const rec = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number };
    expect(rec.pid).toBe(process.pid);
  });

  test("a legacy ownerless lock still falls back to the age rule", () => {
    // Written by an older build as a bare timestamp. Unverifiable, so the
    // previous behaviour is the safest available answer: fresh is respected.
    clearLock();
    writeFileSync(lockPath, String(Date.now()));
    expect(acquireStartupLock()).toBe(false);

    clearLock();
    writeFileSync(lockPath, String(Date.now() - 10 * 60_000));
    expect(acquireStartupLock()).toBe(true);
  });

  test("an unreadable lock is never broken", () => {
    // Possibly a peer mid-write. Breaking it would race two acquirers.
    clearLock();
    writeFileSync(lockPath, "not json and not a number");
    expect(acquireStartupLock()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("releasing does not delete a lock another process owns", () => {
    // Ours was broken, someone else acquired: an unconditional unlink would
    // free their lock and let a third start run concurrently.
    clearLock();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 0x7ffffffe, ts: Date.now() }),
    );

    releaseStartupLock();

    expect(existsSync(lockPath)).toBe(true);
  });

  test("releasing removes our own lock", () => {
    clearLock();
    expect(acquireStartupLock()).toBe(true);
    releaseStartupLock();
    expect(existsSync(lockPath)).toBe(false);
  });
});
