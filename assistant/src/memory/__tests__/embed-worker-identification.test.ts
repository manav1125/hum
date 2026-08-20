/**
 * The embed-worker PID guard.
 *
 * A 4 GB instance accumulated four ~500 MB embed workers and was OOM-killed.
 * Identification shelled out to `ps` via `spawnSync`, and BOTH a non-zero exit
 * and a throw returned "not our worker" — a verdict whose handler drops the
 * PID file *without killing*. Under memory pressure the fork for `ps` is
 * exactly what fails, so the guard against runaway memory broke precisely when
 * memory was short, orphaned a live 500 MB worker, and made the next spawn
 * worse. These tests pin the two properties that fix it: the decision is made
 * from evidence actually read, and "could not tell" is not "somebody else's".
 */

import { describe, expect, test } from "bun:test";

import { classifyPidCmdline, readProcCmdline } from "../embedding-local.js";

const WORKER_PATH = "/workspace/embedding-models/embed-worker.mjs";
const REAL_WORKER_CMDLINE = `/usr/local/bin/bun --smol ${WORKER_PATH} Xenova/bge-small-en-v1.5 /workspace/embedding-models/model-cache 1`;

describe("classifyPidCmdline", () => {
  test("recognises our worker from its real command line", () => {
    expect(classifyPidCmdline(REAL_WORKER_CMDLINE, WORKER_PATH)).toBe("ours");
  });

  test("recognises an unrelated process as someone else's", () => {
    expect(
      classifyPidCmdline("/usr/bin/qdrant --config /etc/q.yaml", WORKER_PATH),
    ).toBe("other");
  });

  test("an unreadable command line is unknown, NOT other", () => {
    // This is the whole bug. `other` drops the PID file without killing, so
    // returning it here orphans a live worker that nothing will reclaim.
    expect(classifyPidCmdline(null, WORKER_PATH)).toBe("unknown");
  });

  test("an empty command line is unknown, NOT other", () => {
    expect(classifyPidCmdline("", WORKER_PATH)).toBe("unknown");
    expect(classifyPidCmdline("   ", WORKER_PATH)).toBe("unknown");
  });

  test("a worker for a different workspace is other, not ours", () => {
    const otherWorkspace = REAL_WORKER_CMDLINE.replaceAll(
      "/workspace/",
      "/srv/other/",
    );
    expect(classifyPidCmdline(otherWorkspace, WORKER_PATH)).toBe("other");
  });
});

describe("readProcCmdline", () => {
  const hasProc = process.platform === "linux";

  test.skipIf(!hasProc)("reads our own command line without forking", () => {
    const mine = readProcCmdline(process.pid);
    expect(mine).not.toBeNull();
    // argv[0] is the runtime; whatever it is, the string is non-empty and
    // NUL separators have been normalised to spaces.
    expect(mine!.length).toBeGreaterThan(0);
    expect(mine).not.toContain("\0");
  });

  test.skipIf(!hasProc)("returns null for a pid that does not exist", () => {
    // 0x7FFFFFFF is above any real pid_max.
    expect(readProcCmdline(0x7fffffff)).toBeNull();
  });

  test.skipIf(hasProc)("returns null where /proc does not exist", () => {
    expect(readProcCmdline(process.pid)).toBeNull();
  });
});
