/**
 * inbox_run_report bundled tool — validates counts and records a summary the
 * morning brief's store read can see (real store, per-test temp workspace).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { run } from "../config/bundled-skills/messaging/tools/inbox-run-report.js";
import { readLatestInboxRunSummary } from "../home/inbox-run-summary.js";
import type { ToolContext } from "../tools/types.js";
import { getDataDir } from "../util/platform.js";

const ctx = {} as ToolContext;

beforeEach(() => {
  rmSync(join(getDataDir(), "inbox-run-summaries.jsonl"), { force: true });
});

describe("inbox_run_report", () => {
  test("records the counts and the store reads them back", async () => {
    const result = await run(
      { archived: 14, drafted: 3, kept_important: 2 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("14 archived");
    const latest = readLatestInboxRunSummary(Date.now() - 60_000);
    expect(latest).toMatchObject({
      archived: 14,
      drafted: 3,
      keptImportant: 2,
    });
  });

  test("rejects missing or negative counts without recording", async () => {
    for (const input of [
      {},
      { archived: 1, drafted: 0 },
      { archived: -1, drafted: 0, kept_important: 0 },
      { archived: "many", drafted: 0, kept_important: 0 },
    ]) {
      const result = await run(input as Record<string, unknown>, ctx);
      expect(result.isError).toBe(true);
    }
    expect(readLatestInboxRunSummary(0)).toBeNull();
  });
});
