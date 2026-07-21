/**
 * Regression test for the src/cli.ts entry-point trap.
 *
 * `src/cli.ts` is the interactive chat UI module (loaded by the default
 * action), not the commander CLI entry point. It used to be runnable
 * directly — `bun run src/cli.ts config set <key> <value>` evaluated the
 * imports and exited 0 having executed nothing, which read as a
 * successful config write that silently never happened.
 *
 * The module now carries an `import.meta.main` guard: direct invocation
 * must exit non-zero with a stderr message pointing at the real entry
 * point (src/index.ts).
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ASSISTANT_ROOT = join(import.meta.dir, "..", "..");

describe("src/cli.ts direct invocation guard", () => {
  test("running a command through src/cli.ts fails loudly instead of silently no-oping", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/cli.ts", "config", "set", "llm.flashTier.model", "x"],
      {
        cwd: ASSISTANT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not the assistant CLI entry point");
    expect(stderr).toContain("src/index.ts");
  }, 30_000);

  test("importing src/cli.ts as a module does not trip the guard", async () => {
    // The default action (`assistant` with no subcommand) imports startCli
    // from this module — the guard must only fire for direct execution.
    const mod = await import("../cli.js");
    expect(typeof mod.startCli).toBe("function");
  });
});
