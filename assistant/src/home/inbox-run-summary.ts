/**
 * Inbox run summary store — the counts behind the morning brief's
 * "overnight inbox cleanup" row.
 *
 * Each inbox-management run (see skills/inbox-management) ends with a small
 * summary: how many messages were archived, how many reply drafts were
 * created, and how many messages were deliberately kept and marked important.
 * The run records it here (via the `inbox_run_report` bundled tool) and the
 * morning brief reads the latest run inside its lookback window.
 *
 * Same persistence mechanism as the home surfaces' impact store
 * (src/home/impact-store.ts): append-only JSONL in the workspace data dir, so
 * concurrent records never race on a read-modify-write — writers append, the
 * reader folds. Never throws: recording a summary is fire-and-forget and must
 * not break the run that produced it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("inbox-run-summary");

const SUMMARY_FILENAME = "inbox-run-summaries.jsonl";

export interface InboxRunSummary {
  /** Messages archived (or, at Stage 0, that would have been archived). */
  archived: number;
  /** Reply drafts created in-thread. */
  drafted: number;
  /** Messages deliberately kept in the inbox and marked important. */
  keptImportant: number;
  /** ISO-8601 time the run finished. */
  ranAt: string;
}

function summaryPath(): string {
  return join(getDataDir(), SUMMARY_FILENAME);
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : null;
}

/**
 * Record one inbox-run summary. Fire-and-forget — never throws. `ranAt`
 * defaults to now so callers don't have to stamp it.
 */
export function recordInboxRunSummary(summary: {
  archived: number;
  drafted: number;
  keptImportant: number;
  ranAt?: string;
}): void {
  try {
    const archived = asCount(summary.archived);
    const drafted = asCount(summary.drafted);
    const keptImportant = asCount(summary.keptImportant);
    if (archived === null || drafted === null || keptImportant === null) {
      log.warn({ summary }, "Ignoring inbox run summary with invalid counts");
      return;
    }
    const ranAt = summary.ranAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(ranAt))) {
      log.warn({ ranAt }, "Ignoring inbox run summary with invalid ranAt");
      return;
    }
    mkdirSync(getDataDir(), { recursive: true });
    const line = JSON.stringify({ archived, drafted, keptImportant, ranAt });
    appendFileSync(summaryPath(), line + "\n", "utf-8");
  } catch (err) {
    log.warn({ err: String(err) }, "Failed to record inbox run summary");
  }
}

/** Read all recorded summaries (tolerant of partial/corrupt lines). */
function readSummaries(): InboxRunSummary[] {
  const path = summaryPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: InboxRunSummary[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as InboxRunSummary;
      if (
        parsed &&
        asCount(parsed.archived) !== null &&
        asCount(parsed.drafted) !== null &&
        asCount(parsed.keptImportant) !== null &&
        typeof parsed.ranAt === "string" &&
        !Number.isNaN(Date.parse(parsed.ranAt))
      ) {
        out.push(parsed);
      }
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/**
 * The most recent run summary whose `ranAt` falls at/after `sinceMs`, or null
 * when no run happened in the window. Never throws.
 */
export function readLatestInboxRunSummary(
  sinceMs: number,
): InboxRunSummary | null {
  let latest: InboxRunSummary | null = null;
  let latestMs = -Infinity;
  for (const summary of readSummaries()) {
    const t = Date.parse(summary.ranAt);
    if (t < sinceMs) continue;
    if (t > latestMs) {
      latest = summary;
      latestMs = t;
    }
  }
  return latest;
}
