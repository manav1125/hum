#!/usr/bin/env bun
/**
 * Apply the arrival relevance gate to the work items that predate it.
 *
 * The gate filters new mail at the arrival boundary. Everything already in the
 * queued lane when it shipped was minted with no predicate in front of it and
 * will never be filtered — this is how that backlog gets the same treatment.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless `--apply` is passed, and even
 * then nothing is deleted: a filed item is archived and linked to its
 * `arrivals` row, and `POST arrivals/:id/reverse` restores that exact row.
 *
 *   bun run scripts/retro-arrival-gate.ts                    # dry run, human report
 *   bun run scripts/retro-arrival-gate.ts --json             # dry run, machine output
 *   bun run scripts/retro-arrival-gate.ts --limit 20         # dry run over the 20 oldest
 *   bun run scripts/retro-arrival-gate.ts --apply            # write
 *
 * Flags:
 *   --apply                 Write. Off by default.
 *   --channel <c>           Work-item sourceType to sweep (default watcher:gmail).
 *   --limit <n>             Stop after n candidates.
 *   --json                  Emit the full report as JSON.
 *   --use-model-on-thin     Let the flash judge rule on rows whose mail headers
 *                           did not survive. OFF by default: with no headers the
 *                           judge sees a subject line and a sender, and filing a
 *                           real person's mail on that is the failure this tool
 *                           is built to avoid. Read a dry run first.
 *
 * Re-runnable: the `arrivals` row is the marker, so a second run skips
 * everything the first one decided and an interrupted run resumes cleanly.
 */

import {
  formatRetrofitReport,
  retrofitArrivalGate,
} from "../src/arrivals/arrival-retrofit.js";
import { initializeDb } from "../src/memory/db-init.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const apply = flag("apply");
const limitRaw = value("limit");
const limit = limitRaw ? Number(limitRaw) : undefined;
if (limitRaw && !Number.isFinite(limit)) {
  console.error(`--limit must be a number, got ${limitRaw}`);
  process.exit(2);
}

initializeDb();

const report = await retrofitArrivalGate({
  apply,
  limit,
  channel: value("channel"),
  useModelOnThin: flag("use-model-on-thin"),
});

if (flag("json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatRetrofitReport(report));
  if (!report.applied) {
    console.log(
      "\nNothing was written. Re-run with --apply to act on this plan.",
    );
  }
}
