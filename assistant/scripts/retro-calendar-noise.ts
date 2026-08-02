#!/usr/bin/env bun
/**
 * Retire the work items the calendar watcher should never have minted.
 *
 * A meeting is something you attend, not something in your queue — the day
 * rail already shows the calendar by reading the API directly. The calendar
 * watcher was nevertheless provisioned with the same intake mode as Gmail, so
 * every event it saw became a row in the lane. This sweeps those rows.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless `--apply` is passed, and even
 * then nothing is deleted: items are archived, an undo manifest is written
 * naming every one of them and the status it had, and `--revert <manifest>`
 * puts them all back.
 *
 * Items the owner has touched — filed into a project, dated, labelled,
 * assigned, run, or with edited notes — are never archived. The report lists
 * each one and the signal that saved it.
 *
 *   bun run scripts/retro-calendar-noise.ts                     # dry run, human report
 *   bun run scripts/retro-calendar-noise.ts --json              # dry run, machine output
 *   bun run scripts/retro-calendar-noise.ts --limit 20          # dry run over 20
 *   bun run scripts/retro-calendar-noise.ts --apply             # write + manifest
 *   bun run scripts/retro-calendar-noise.ts --revert <path>     # dry-run the undo
 *   bun run scripts/retro-calendar-noise.ts --revert <path> --apply
 *
 * Flags:
 *   --apply             Write. Off by default.
 *   --channel <c>       One work-item sourceType to sweep. Defaults to both
 *                       calendar channels.
 *   --limit <n>         Stop after n candidates.
 *   --json              Emit the full report as JSON.
 *   --manifest <path>   Where to write the undo manifest (default: the
 *                       workspace dir, or the working directory).
 *   --revert <path>     Restore everything an earlier applied run archived.
 *
 * Re-runnable: an archived item is no longer a candidate, so a second run
 * finds nothing and an interrupted run resumes cleanly.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { initializeDb } from "../src/memory/db-init.js";
import {
  CALENDAR_CHANNELS,
  cleanupCalendarWorkItems,
  type CleanupManifest,
  formatCleanupReport,
  revertCalendarCleanup,
} from "../src/watcher/calendar-work-item-cleanup.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const apply = flag("apply");
const asJson = flag("json");
const limitRaw = value("limit");
const limit = limitRaw ? Number(limitRaw) : undefined;
if (limitRaw && !Number.isFinite(limit)) {
  console.error(`--limit must be a number, got ${limitRaw}`);
  process.exit(2);
}

initializeDb();

// ── Undo ────────────────────────────────────────────────────────────────────

const revertPath = value("revert");
if (revertPath !== undefined) {
  const manifest = (await Bun.file(revertPath).json()) as CleanupManifest;
  const report = revertCalendarCleanup(manifest, { apply });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      apply
        ? `Restored ${report.restored} item(s) from ${revertPath}`
        : `DRY RUN — would restore ${report.restored} item(s) from ${revertPath}`,
    );
    for (const s of report.skipped) {
      console.log(`  · skipped ${s.workItemId}: ${s.reason}`);
    }
    if (!apply) {
      console.log("\nNothing was written. Re-run with --apply to restore.");
    }
  }
  process.exit(0);
}

// ── Sweep ───────────────────────────────────────────────────────────────────

const channel = value("channel");
const { report, manifest } = cleanupCalendarWorkItems({
  apply,
  ...(limit !== undefined ? { limit } : {}),
  ...(channel ? { channels: [channel] } : { channels: CALENDAR_CHANNELS }),
});

if (manifest) {
  // The undo file is the only reason an applied run is safe, so it is written
  // before anything is printed and its path is echoed in the report.
  const path =
    value("manifest") ??
    join(
      process.env.VELLUM_WORKSPACE_DIR ?? ".",
      `calendar-cleanup-${manifest.appliedAt}.json`,
    );
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  report.manifestPath = path;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCleanupReport(report));
  if (!report.applied) {
    console.log(
      "\nNothing was written. Re-run with --apply to act on this plan.",
    );
  }
}
