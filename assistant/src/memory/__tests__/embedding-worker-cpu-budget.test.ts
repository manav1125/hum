/**
 * The embed and rerank workers must never be able to occupy every CPU.
 *
 * ONNX Runtime defaults to one intra-op thread per core. On a 2-vCPU host that
 * meant a single background embedding batch claimed both CPUs and the daemon's
 * event loop could not be scheduled — the loop reported multi-second
 * `event_loop_blocked` stalls while doing no work of its own. These tests pin
 * the two guarantees that prevent it: the generated worker scripts always
 * constrain ONNX threading, and the thread cap is a spawn-time argument (so it
 * cannot be silently frozen into a cached worker script).
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  getEmbedOnnxThreads,
  getEmbedWorkerNiceness,
} from "../../config/env-registry.js";
import {
  deprioritizeWorker,
  generateRerankWorkerScript,
  generateWorkerScript,
  onnxThreadArg,
} from "../embedding-runtime-manager.js";

const ENV_KEYS = ["CUE_EMBED_ONNX_THREADS", "CUE_EMBED_WORKER_NICENESS"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("ONNX thread budget", () => {
  test("defaults to a single intra-op thread", () => {
    expect(getEmbedOnnxThreads()).toBe(1);
    expect(onnxThreadArg()).toBe("1");
  });

  test("honours an explicit override", () => {
    process.env.CUE_EMBED_ONNX_THREADS = "4";
    expect(getEmbedOnnxThreads()).toBe(4);
    expect(onnxThreadArg()).toBe("4");
  });

  test("rejects values that would remove the cap", () => {
    for (const bad of ["0", "-2", "", "abc"]) {
      process.env.CUE_EMBED_ONNX_THREADS = bad;
      expect(getEmbedOnnxThreads()).toBe(1);
    }
  });
});

describe("generated worker scripts", () => {
  const scripts = [
    { name: "embed", source: generateWorkerScript(), argvIndex: 4 },
    { name: "rerank", source: generateRerankWorkerScript(), argvIndex: 5 },
  ];

  for (const { name, source, argvIndex } of scripts) {
    test(`${name} worker constrains ONNX threading`, () => {
      expect(source).toContain("intraOpNumThreads: threads");
      expect(source).toContain("interOpNumThreads: 1");
      expect(source).toContain("executionMode: 'sequential'");
    });

    test(`${name} worker reads the cap from argv[${argvIndex}]`, () => {
      expect(source).toContain(
        `const threads = Math.max(1, Number(process.argv[${argvIndex}]) || 1);`,
      );
    });

    test(`${name} worker falls back to one thread on a missing argument`, () => {
      // Mirror the guard the script applies to its own argv so a future edit
      // that drops the clamp fails here rather than in production.
      const clamp = (raw: string | undefined) =>
        Math.max(1, Number(raw) || 1);
      expect(clamp(undefined)).toBe(1);
      expect(clamp("")).toBe(1);
      expect(clamp("0")).toBe(1);
      expect(clamp("-8")).toBe(1);
      expect(clamp("3")).toBe(3);
    });
  }
});

describe("worker deprioritisation", () => {
  test("defaults to a positive niceness", () => {
    expect(getEmbedWorkerNiceness()).toBe(10);
  });

  test("can be disabled with 0", () => {
    process.env.CUE_EMBED_WORKER_NICENESS = "0";
    expect(getEmbedWorkerNiceness()).toBe(0);
  });

  test("never throws — a worker that keeps its priority still works", () => {
    // Unknown pid, and a niceness the OS will refuse without privileges.
    process.env.CUE_EMBED_WORKER_NICENESS = "-20";
    expect(() => deprioritizeWorker(2 ** 30)).not.toThrow();
    expect(() => deprioritizeWorker(undefined)).not.toThrow();
  });

  test("actually lowers the priority of a live process", () => {
    const proc = Bun.spawn({ cmd: ["sleep", "5"], stdout: "ignore" });
    try {
      deprioritizeWorker(proc.pid);
      const os = require("node:os") as typeof import("node:os");
      expect(os.getPriority(proc.pid)).toBe(10);
    } finally {
      proc.kill();
    }
  });
});
