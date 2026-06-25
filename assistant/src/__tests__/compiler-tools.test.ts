import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { ensureCompilerTools } from "../bundler/compiler-tools.js";

// ---------------------------------------------------------------------------
// Regression: app compilation must resolve esbuild + preact from the
// installed `node_modules` (the container / server path), never relying on a
// JIT download that fails in the Render Linux container. `esbuild` and
// `preact` are declared as assistant dependencies precisely so the
// platform-correct native binary ships in the image.
// ---------------------------------------------------------------------------

describe("ensureCompilerTools", () => {
  test("resolves esbuild + preact from installed node_modules", async () => {
    const tools = await ensureCompilerTools();

    // The esbuild binary path must point at the installed platform package's
    // native binary, not the JIT-download workspace cache.
    expect(tools.esbuildBin).toContain("node_modules");
    expect(tools.esbuildBin).toContain("@esbuild/");
    expect(existsSync(tools.esbuildBin)).toBe(true);

    // preact must resolve to the installed package directory.
    expect(tools.preactDir).toContain("node_modules");
    expect(tools.preactDir.endsWith("preact")).toBe(true);
    expect(existsSync(tools.preactDir)).toBe(true);
  });

  test("returns the installed esbuild binary that actually executes", async () => {
    const tools = await ensureCompilerTools();

    const proc = Bun.spawn({
      cmd: [tools.esbuildBin, "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(proc.exitCode).toBe(0);
    // Pinned version — matches assistant/package.json + bun.lock.
    expect(stdout.trim()).toBe("0.24.2");
  });
});
