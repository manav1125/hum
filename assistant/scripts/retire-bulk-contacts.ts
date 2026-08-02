#!/usr/bin/env bun
/**
 * Retire the contacts the first correspondence sweep should never have made.
 *
 * That sweep ran with only an address-shape test in front of it, so senders
 * whose local part is a brand name rather than `noreply` became people. The
 * correspondence reader now also drops any sender whose mail the arrival gate
 * has never once surfaced; this applies that judgement retroactively.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless `--apply` is passed, and even
 * then nothing is deleted: the provisioned `email` channel is revoked with a
 * marker, an undo manifest naming every channel and the status it had is
 * written, and `--revert <manifest>` puts them all back.
 *
 * Contacts the owner has touched — verified, invited, renamed, annotated, or
 * with a remembered fact — are never retired, and neither is a contact whose
 * address has no arrival rows at all: the gate never judged that sender, and
 * absence of judgement is not a judgement.
 *
 *   bun run scripts/retire-bulk-contacts.ts                     # dry run, human report
 *   bun run scripts/retire-bulk-contacts.ts --json              # dry run, machine output
 *   bun run scripts/retire-bulk-contacts.ts --limit 20          # dry run over 20
 *   bun run scripts/retire-bulk-contacts.ts --apply             # write + manifest
 *   bun run scripts/retire-bulk-contacts.ts --revert <path>     # dry-run the undo
 *   bun run scripts/retire-bulk-contacts.ts --revert <path> --apply
 *
 * Flags:
 *   --apply             Write. Off by default.
 *   --limit <n>         Stop after n candidates.
 *   --json              Emit the full report as JSON.
 *   --manifest <path>   Where to write the undo manifest (default: the
 *                       workspace dir, or the working directory).
 *   --revert <path>     Restore everything an earlier applied run retired.
 *   --reveal            Print each candidate's name and address. OFF by
 *                       default: the report identifies people by contact id so
 *                       that piping it, pasting it or checking it into a
 *                       terminal log does not spill the owner's address book.
 *
 * Re-runnable: a retired channel is no longer a candidate, so a second run
 * finds nothing and an interrupted run resumes cleanly.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatRetirementReport,
  retireCorrespondenceContacts,
  type RetirementManifest,
  revertContactRetirement,
} from "../src/contacts/contact-retirement.js";
import { initializeDb } from "../src/memory/db-init.js";

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
  const manifest = (await Bun.file(revertPath).json()) as RetirementManifest;
  const report = revertContactRetirement(manifest, { apply });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      apply
        ? `Restored ${report.restored} channel(s) from ${revertPath}`
        : `DRY RUN — would restore ${report.restored} channel(s) from ${revertPath}`,
    );
    for (const s of report.skipped) {
      console.log(`  · skipped ${s.contactId}: ${s.reason}`);
    }
    if (!apply) {
      console.log("\nNothing was written. Re-run with --apply to restore.");
    }
  }
  process.exit(0);
}

// ── Sweep ───────────────────────────────────────────────────────────────────

const { report, manifest } = retireCorrespondenceContacts({
  apply,
  reveal: flag("reveal"),
  ...(limit !== undefined ? { limit } : {}),
});

if (manifest) {
  // The undo file is the only reason an applied run is safe, so it is written
  // before anything is printed and its path is echoed in the report.
  const path =
    value("manifest") ??
    join(
      process.env.VELLUM_WORKSPACE_DIR ?? ".",
      `contact-retirement-${manifest.appliedAt}.json`,
    );
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  report.manifestPath = path;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatRetirementReport(report));
  if (report.manifestPath) {
    console.log(`\nUndo manifest: ${report.manifestPath}`);
  }
  if (!report.applied) {
    console.log(
      "\nNothing was written. Re-run with --apply to act on this plan.",
    );
  }
}
