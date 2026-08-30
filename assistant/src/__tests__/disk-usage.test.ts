import { beforeEach, describe, expect, mock, test } from "bun:test";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

let existingPaths = new Set<string>();
const workspaceDir = "/workspace";
let minikubeStorageSize: string | undefined;
let statfsResult = {
  bsize: 4096,
  blocks: 0,
  bavail: 0,
};
let spawnResult: {
  status: number | null;
  stdout: string;
} = {
  status: 0,
  stdout: "",
};
let spawnCalls: Array<{ command: string; args: string[] }> = [];

mock.module("node:fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  statfsSync: () => statfsResult,
}));

mock.module("node:child_process", () => ({
  // Callback-style execFile: `promisify(execFile)` in the module under test
  // wraps this. A non-zero simulated status rejects, mirroring how the real
  // promisified execFile rejects on non-zero exit.
  execFile: (
    command: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, result?: { stdout: string }) => void,
  ) => {
    spawnCalls.push({ command, args });
    if (spawnResult.status !== 0) {
      cb(new Error(`exit ${spawnResult.status}`));
      return;
    }
    cb(null, { stdout: spawnResult.stdout });
  },
}));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualEnvRegistry = await import("../config/env-registry.js");
mock.module("../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getMinikubeStorageSize: () => minikubeStorageSize,
}));

// Spread the real module: an exhaustive factory deletes every export it
// does not name, for this file's own import graph and every file that
// runs after it in the same process.
const actualPlatform = await import("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...actualPlatform,
  getWorkspaceDir: () => workspaceDir,
}));

const { __resetDiskUsageCacheForTests, getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

function statfsFor(totalBytes: number, freeBytes: number) {
  return {
    bsize: MIB,
    blocks: totalBytes / MIB,
    bavail: freeBytes / MIB,
  };
}

describe("disk usage sampler", () => {
  beforeEach(() => {
    existingPaths = new Set([workspaceDir]);
    minikubeStorageSize = undefined;
    statfsResult = statfsFor(100 * MIB, 25 * MIB);
    spawnResult = { status: 0, stdout: "" };
    spawnCalls = [];
    __resetDiskUsageCacheForTests();
  });

  test("reports regular statfs usage", async () => {
    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: "/workspace",
      totalMb: 100,
      usedMb: 75,
      freeMb: 25,
    });
    expect(spawnCalls).toHaveLength(0);
  });

  test("falls back to root when the workspace path does not exist", async () => {
    existingPaths = new Set();

    const usage = await getDiskUsageInfo();

    expect(usage?.path).toBe("/");
  });

  test("uses PVC capacity and du usage when host filesystem is larger", async () => {
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 0,
      stdout: `${100 * MIB}\t/workspace\n`,
    };

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: "/workspace",
      totalMb: 1024,
      usedMb: 100,
      freeMb: 924,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", "/workspace"] },
    ]);
  });

  test("includes /data in PVC du usage when it exists separately", async () => {
    existingPaths = new Set([workspaceDir, "/data"]);
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 0,
      stdout: `${100 * MIB}\t/workspace\n${20 * MIB}\t/data\n`,
    };

    const usage = await getDiskUsageInfo();

    expect(usage?.usedMb).toBe(120);
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", "/workspace", "/data"] },
    ]);
  });

  test("returns null for malformed Kubernetes memory strings", async () => {
    expect(parseK8sMemoryBytes("")).toBeNull();
    expect(parseK8sMemoryBytes("abc")).toBeNull();
    expect(parseK8sMemoryBytes("12Zi")).toBeNull();
    expect(parseK8sMemoryBytes("-1Gi")).toBeNull();
    expect(parseK8sMemoryBytes("0Gi")).toBeNull();
  });

  test("falls back to statfs when du fails in PVC mode", async () => {
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 1,
      stdout: "",
    };

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: "/workspace",
      totalMb: 10240,
      usedMb: 2048,
      freeMb: 8192,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", "/workspace"] },
    ]);
  });
});
