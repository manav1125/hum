/**
 * A file read must be bounded by characters, not only by lines.
 *
 * The line cap (2000) bounds nothing on its own: a minified bundle, a
 * one-line JSON blob, a newline-free CSV or a base64 payload is a SINGLE
 * line, so the cap admits the whole file. The on-disk guard sits at 100 MB,
 * so between the two nothing stopped a 90 MB single-line file from being read
 * whole — and a file-read result is honored in full for the rest of the turn,
 * so it then rides every subsequent LLM call. That is a wedge rather than a
 * slow turn: the oversized request lives in history, so every retry resends
 * it and compaction meets the same rejection.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { DEFAULT_READ_CHAR_LIMIT, FileSystemOps } from "./file-ops-service.js";

const dir = mkdtempSync(join(tmpdir(), "read-char-budget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Permissive policy: this exercises the read budget, not path safety.
const ops = new FileSystemOps((path) => ({ ok: true, resolved: path }));

function writeAndRead(name: string, content: string) {
  const p = join(dir, name);
  writeFileSync(p, content);
  const res = ops.readFileSafe({ path: p });
  if (!res.ok) throw new Error(`read failed: ${JSON.stringify(res.error)}`);
  return res.value.content;
}

describe("file read character budget", () => {
  test("a single enormous line is cut at the budget", () => {
    // The case the line cap cannot see: one line, far past any sane size.
    const content = writeAndRead("minified.js", "x".repeat(500_000));

    expect(content.length).toBeLessThan(DEFAULT_READ_CHAR_LIMIT + 1_000);
    expect(content).toContain("Truncated at the");
    expect(content).toContain("mid-line");
  });

  test("the notice reports the real file size, not the returned size", () => {
    // A model told only what it received cannot tell a window from a whole
    // file, which is the reasoning failure the notice exists to prevent.
    const content = writeAndRead("blob.json", "y".repeat(300_000));
    expect(content).toContain("300,000 characters");
  });

  test("ordinary source is untouched by the budget", () => {
    // 400 lines of realistic code — must round-trip with no notice at all,
    // or the budget is a regression on every normal read.
    const src = Array.from(
      { length: 400 },
      (_, i) =>
        `  const value${i} = compute(${i}); // a comment of some length`,
    ).join("\n");
    const content = writeAndRead("normal.ts", src);

    expect(content).not.toContain("Truncated");
    expect(content).toContain("value399");
  });

  test("many short lines still hit the LINE cap, with a resumable offset", () => {
    // The pre-existing path must keep working and keep offering `offset=`,
    // which the character notice deliberately does not.
    const src = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
    const content = writeAndRead("long.txt", src);

    expect(content).toContain("showing through line 2000 of 2500");
    expect(content).toContain("offset=2001");
  });

  test("an explicit charLimit overrides the default", () => {
    const p = join(dir, "explicit.txt");
    writeFileSync(p, "z".repeat(10_000));
    const res = ops.readFileSafe({ path: p, charLimit: 500 });
    if (!res.ok) throw new Error("read failed");

    expect(res.value.content.length).toBeLessThan(1_500);
    expect(res.value.content).toContain("Truncated at the");
  });
});
