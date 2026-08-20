/**
 * Oversized output is spilled, and the marker never lies about it.
 *
 * The mutation checks guard the three ways this could quietly go back to
 * throwing the overflow away: bounding without spilling, claiming a file that
 * was never written, and leaving the spill directory readable by anyone on the
 * machine.
 */

import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  boundOutput,
  cleanupSpilledFiles,
  spillText,
} from "../output-spill.js";

afterEach(() => {
  cleanupSpilledFiles();
});

describe("small output is left alone", () => {
  test("under the limit passes through untouched", () => {
    const out = boundOutput("short", 100, "t");
    expect(out.content).toBe("short");
    expect(out.wasBounded).toBe(false);
    expect(out.spill).toBeUndefined();
  });

  test("exactly at the limit is not bounded", () => {
    const text = "x".repeat(50);
    expect(boundOutput(text, 50, "t").wasBounded).toBe(false);
  });
});

describe("oversized output keeps everything", () => {
  const big = "A".repeat(500) + "NEEDLE" + "B".repeat(500);

  test("MUTATION CHECK: the overflow is recoverable, not discarded", () => {
    // The whole point. `slice() + "… (truncated)"` loses the tail, and the
    // interesting line is as likely to be at the end as the start.
    const out = boundOutput(big, 100, "t");
    expect(out.wasBounded).toBe(true);
    expect(out.spill).toBeDefined();
    const recovered = readFileSync(out.spill!.locator, "utf-8");
    expect(recovered).toBe(big);
    expect(recovered).toContain("NEEDLE");
  });

  test("the preview is bounded and the marker states the real size", () => {
    const out = boundOutput(big, 100, "t");
    expect(out.content).toContain("<output_bounded");
    expect(out.content).toContain(`bytes="${big.length}"`);
    // The model is told how to get the rest, not merely that there is a rest.
    expect(out.content).toContain(out.spill!.locator);
    expect(out.spill!.retrievalHint).toContain(out.spill!.locator);
  });

  test("byte count is the byte count, not the character count", () => {
    // A multi-byte body would report a too-small size if this used .length.
    const text = "é".repeat(400);
    const ref = spillText(text, "t")!;
    expect(ref.bytes).toBe(Buffer.byteLength(text, "utf-8"));
    expect(ref.bytes).toBeGreaterThan(text.length);
  });
});

describe("the file is not readable by the rest of the machine", () => {
  test("MUTATION CHECK: spill file is owner-only and lives in a 0700 dir", () => {
    // Spilled text is arbitrary command and third-party output on a shared
    // machine. A world-readable temp file is a disclosure, and a predictable
    // one is a symlink race.
    const ref = spillText("secret-ish payload", "t")!;
    expect(statSync(ref.locator).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(ref.locator)).mode & 0o777).toBe(0o700);
  });

  test("names are unguessable — two spills never collide", () => {
    const a = spillText("one", "t")!;
    const b = spillText("two", "t")!;
    expect(a.locator).not.toBe(b.locator);
  });
});

describe("a failed spill is reported, never implied", () => {
  test("MUTATION CHECK: an unwritable dir yields no fake locator", () => {
    // If the write fails the marker must say the rest is gone. A locator that
    // does not resolve is worse than no locator: the model spends a tool call
    // discovering we lied.
    const probe = spillText("x", "t")!;
    const dir = dirname(probe.locator);
    cleanupSpilledFiles();
    chmodSync(dir, 0o500); // read+execute, no write
    try {
      const out = boundOutput("y".repeat(200), 10, "t");
      expect(out.wasBounded).toBe(true);
      expect(out.spill).toBeUndefined();
      expect(out.content).toContain('unavailable="true"');
      expect(out.content).toContain("not retrievable");
      expect(out.content).not.toContain("Read /");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("cleanup", () => {
  test("removes what it wrote and is safe to repeat", () => {
    const ref = spillText("bye", "t")!;
    expect(statSync(ref.locator).isFile()).toBe(true);
    cleanupSpilledFiles();
    expect(() => statSync(ref.locator)).toThrow();
    expect(() => cleanupSpilledFiles()).not.toThrow();
  });
});
