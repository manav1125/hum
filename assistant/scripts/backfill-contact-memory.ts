#!/usr/bin/env bun
/**
 * Turn the correspondence already on disk into People.
 *
 * The contact-memory extraction pass can only act on a person Cue already
 * knows, and until recently the only way to become known was an interactive
 * channel binding. An owner whose real correspondence is email therefore had
 * a People surface with almost nobody in it, and an extraction job that
 * reported completion several hundred times while writing nothing. The live
 * fix provisions contacts from `arrivals` on a cadence; this applies the same
 * treatment to the history that predates it.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless `--apply` is passed, and even
 * then nothing is deleted or renamed: an address that already has a contact
 * keeps its stored name and gains only correspondence stats. Re-runnable —
 * a second run skips people it already provisioned and, with --extract,
 * skips anyone whose mail has not changed since the last pass.
 *
 *   bun run scripts/backfill-contact-memory.ts                  # dry run
 *   bun run scripts/backfill-contact-memory.ts --json           # dry run, machine output
 *   bun run scripts/backfill-contact-memory.ts --min-messages 2 # only repeat correspondents
 *   bun run scripts/backfill-contact-memory.ts --apply          # provision contacts
 *   bun run scripts/backfill-contact-memory.ts --apply --extract --limit 25
 *
 * Flags:
 *   --apply            Write. Off by default.
 *   --extract          Also run the flash memory pass over each provisioned
 *                      contact's mail. Costs one LLM call per person, so it is
 *                      off by default and bounded by --limit. Requires --apply.
 *   --limit <n>        Cap correspondents considered (busiest first).
 *   --min-messages <n> Ignore addresses with fewer than n messages. Default 1.
 *   --since-days <n>   Only consider mail from the last n days.
 *   --force            Re-read mail the scheduled sweep has already been
 *                      through, instead of skipping it. Only useful after a
 *                      prompt change; costs a full LLM call per person again.
 *   --json             Emit the report as JSON.
 *
 * PRIVACY: this tool reads the owner's private correspondence. It prints
 * COUNTS and, for the per-person table, the contact's display name and message
 * count only — never a subject line, a snippet, or an extracted fact. Read the
 * People surface for those.
 */

import { runContactCorrespondenceExtraction } from "../src/contacts/contact-memory-extract-job.js";
import { provisionContactsFromCorrespondence } from "../src/contacts/contact-provisioning.js";
import { initializeDb } from "../src/memory/db-init.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function numberFlag(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`--${name} must be a number, got ${raw}`);
    process.exit(2);
  }
  return parsed;
}

const apply = flag("apply");
const extract = flag("extract");
const limit = numberFlag("limit");
const minMessages = numberFlag("min-messages");
const sinceDays = numberFlag("since-days");
const since =
  sinceDays === undefined
    ? undefined
    : Date.now() - sinceDays * 24 * 60 * 60 * 1000;

if (extract && !apply) {
  console.error(
    "--extract writes contact memory, so it requires --apply. Run the dry run first.",
  );
  process.exit(2);
}

initializeDb();

const provision = provisionContactsFromCorrespondence({
  since,
  minMessages,
  limit,
  dryRun: !apply,
});

interface ExtractionLine {
  displayName: string;
  outcome: string;
  saved: number;
}

const extractions: ExtractionLine[] = [];
let factsWritten = 0;

if (extract) {
  // Busiest correspondents first — the people whose absence the owner would
  // notice. Bounded by --limit so a first run is a decision, not a bill.
  const targets = [...provision.contacts].sort(
    (a, b) => b.messageCount - a.messageCount,
  );
  for (const target of targets) {
    const outcome = await runContactCorrespondenceExtraction(target.contactId, {
      force: flag("force"),
    });
    const saved = outcome.kind === "extracted" ? outcome.savedCount : 0;
    factsWritten += saved;
    extractions.push({
      displayName: target.displayName,
      outcome: outcome.kind,
      saved,
    });
  }
}

const report = {
  applied: apply,
  extracted: extract,
  candidates: provision.candidates,
  contactsCreated: provision.created,
  contactsUpdated: provision.updated,
  failed: provision.failed,
  peopleRead: extractions.length,
  factsWritten,
  // Names and counts only. No subject lines, no snippets, no facts.
  people: provision.contacts.map((c) => ({
    displayName: c.displayName,
    messageCount: c.messageCount,
    created: c.created,
  })),
  extractions,
};

if (flag("json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const verb = apply ? "Provisioned" : "Would provision";
  console.log(`\nCorrespondents found: ${report.candidates}`);
  console.log(
    `${verb}: ${report.contactsCreated} new, ${report.contactsUpdated} existing`,
  );
  if (report.failed > 0) console.log(`Failed: ${report.failed}`);
  if (extract) {
    console.log(
      `Read the mail of ${report.peopleRead} people; wrote ${report.factsWritten} facts.`,
    );
    const barren = extractions.filter(
      (e) => e.outcome === "extracted" && e.saved === 0,
    ).length;
    const skipped = extractions.filter(
      (e) => e.outcome === "already_read",
    ).length;
    if (barren > 0)
      console.log(`  ${barren} had mail but nothing durable to remember.`);
    if (skipped > 0)
      console.log(`  ${skipped} were skipped — their mail has not changed.`);
  }
  const top = report.people.slice(0, 20);
  if (top.length > 0) {
    console.log("\nBusiest correspondents:");
    for (const p of top) {
      console.log(
        `  ${p.created ? "+" : " "} ${p.displayName} — ${p.messageCount} messages`,
      );
    }
    if (report.people.length > top.length) {
      console.log(`  … and ${report.people.length - top.length} more`);
    }
  }
  if (!apply) {
    console.log(
      "\nNothing was written. Re-run with --apply to act on this plan.",
    );
  } else if (!extract) {
    console.log(
      "\nContacts exist now, but no memory was extracted. Add --extract to run the flash pass, or let the scheduled sweep pick them up.",
    );
  }
}
