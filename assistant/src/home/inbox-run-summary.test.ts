/**
 * Inbox run summary store — record + latest-in-window read, invalid-input
 * rejection, and torn-line tolerance. Writes go to the per-test temp
 * workspace's data dir (the preload override), never a live workspace.
 */

import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { getDataDir } from "../util/platform.js";
import {
  readLatestInboxRunSummary,
  recordInboxRunSummary,
} from "./inbox-run-summary.js";

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

// Each test starts from an empty log (the store appends; tests in this file
// share one temp workspace). The path is a JSONL under the per-test temp
// data dir — never a live workspace (the preload verifier guarantees it).
beforeEach(() => {
  rmSync(join(getDataDir(), "inbox-run-summaries.jsonl"), { force: true });
});

describe("inbox-run-summary store", () => {
  test("records a run and reads it back inside the window", () => {
    const ranAt = iso(1 * HOUR);
    recordInboxRunSummary({ archived: 14, drafted: 3, keptImportant: 2, ranAt });
    const latest = readLatestInboxRunSummary(Date.now() - 24 * HOUR);
    expect(latest).toEqual({ archived: 14, drafted: 3, keptImportant: 2, ranAt });
  });

  test("returns the most recent run, and runs before sinceMs are invisible", () => {
    const oldRun = iso(30 * HOUR);
    const mid = iso(5 * HOUR);
    const newest = iso(2 * HOUR);
    recordInboxRunSummary({ archived: 1, drafted: 0, keptImportant: 0, ranAt: newest });
    recordInboxRunSummary({ archived: 2, drafted: 0, keptImportant: 0, ranAt: oldRun });
    recordInboxRunSummary({ archived: 3, drafted: 0, keptImportant: 0, ranAt: mid });

    expect(readLatestInboxRunSummary(Date.now() - 24 * HOUR)?.ranAt).toBe(
      newest,
    );
    // A window that ends before every run finds nothing.
    expect(readLatestInboxRunSummary(Date.now() + HOUR)).toBeNull();
    // A wider window still prefers the newest, not the last-written.
    expect(readLatestInboxRunSummary(Date.now() - 48 * HOUR)?.ranAt).toBe(
      newest,
    );
  });

  test("ranAt defaults to now when omitted", () => {
    recordInboxRunSummary({ archived: 0, drafted: 1, keptImportant: 0 });
    const latest = readLatestInboxRunSummary(Date.now() - 1000);
    expect(latest?.drafted).toBe(1);
  });

  test("invalid counts are rejected, and torn lines don't break reads", () => {
    recordInboxRunSummary({ archived: -1, drafted: 0, keptImportant: 0 });
    recordInboxRunSummary({
      archived: Number.NaN,
      drafted: 0,
      keptImportant: 0,
    });
    // Simulate a torn write straight into the JSONL file.
    mkdirSync(getDataDir(), { recursive: true });
    appendFileSync(
      join(getDataDir(), "inbox-run-summaries.jsonl"),
      '{"archived": 5, "draf\n',
      "utf-8",
    );
    const marker = iso(0);
    recordInboxRunSummary({
      archived: 7,
      drafted: 0,
      keptImportant: 1,
      ranAt: marker,
    });
    const latest = readLatestInboxRunSummary(Date.now() - HOUR);
    expect(latest?.archived).toBe(7);
    expect(latest?.keptImportant).toBe(1);
  });
});
