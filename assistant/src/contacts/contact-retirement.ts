/**
 * Retire the contacts the correspondence sweep should never have provisioned.
 *
 * The first provisioning pass ran with only a shape test in front of it —
 * `isBulkSenderAddress`, which reads the LOCAL PART. An address whose local
 * part is a brand name rather than `noreply` sailed straight through, so the
 * owner's People surface filled with banks, airlines and shopping sites. The
 * reader now also drops any sender whose mail the arrival gate has never once
 * surfaced ({@link isNeverSurfacedSender}); this module applies that same
 * judgement to the contacts the old rule already created.
 *
 * NOTHING IS DELETED. Retiring a contact revokes its provisioned `email`
 * channel and stamps {@link CORRESPONDENCE_RETIRED_REASON_PREFIX} on
 * `revoked_reason`. The contact row, its channel, its stats and its history
 * all survive verbatim; `dedupeContactsForDisplay` stops rendering it, and an
 * undo run puts the channel back exactly as it was. The status change is not
 * itself a permission change — a provisioned channel was `unverified`, which
 * the ingress ACL already denied.
 *
 * WHAT IS NEVER TOUCHED, and why the list is long: this cleanup is guessing on
 * the owner's behalf about the most personal table in the product, so every
 * ambiguity resolves toward leaving the row alone. Guardians, anything with a
 * second channel, anything verified or invited, anything renamed or annotated
 * by hand, anything Cue has remembered a fact about, and — the one that
 * matters most — anything whose address has no arrival rows at all. A contact
 * with no arrivals has not been judged, and an unjudged person is not a robot.
 *
 * PRIVACY: reports and manifests carry contact ids and counts, never addresses
 * or names. `--reveal` on the script is the owner's own opt-in for their own
 * terminal.
 */

import { eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { contactChannels, contactMemory } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import {
  humanizeAddress,
  isNeverSurfacedSender,
  type SenderArrivalJudgement,
  senderNamesFor,
  tallySenderArrivals,
} from "./contact-correspondence.js";
import { emitContactChange } from "./contact-events.js";
import { isDegenerateNotes } from "./contact-presentation.js";
import { CORRESPONDENCE_CHANNEL_TYPE } from "./contact-provisioning.js";
import { listContacts, updateChannelStatus } from "./contact-store.js";
import {
  type ChannelStatus,
  type ContactChannel,
  type ContactWithChannels,
  CORRESPONDENCE_RETIRED_REASON_PREFIX,
} from "./types.js";

const log = getLogger("contact-retirement");

/** The full `revoked_reason` a retired channel carries. */
export const CORRESPONDENCE_RETIRED_REASON = `${CORRESPONDENCE_RETIRED_REASON_PREFIX} every message from this sender was filed, never surfaced`;

/** Contacts scanned per pass unless the caller asks for more. */
const DEFAULT_SCAN_LIMIT = 5_000;

export interface RetirementCandidate {
  contactId: string;
  channelId: string;
  /** Arrivals seen from this address, all dispositions. */
  arrivalCount: number;
  /** How many of them the gate surfaced. Zero, or it would not be here. */
  surfacedCount: number;
  /** Present only when the caller asked to see it. */
  displayName?: string;
  address?: string;
}

/** A contact the cleanup considered and deliberately left alone. */
export interface RetirementSkip {
  contactId: string;
  /** Why, in the owner's words. */
  reason: string;
}

export interface RetirementReport {
  /** True when the pass wrote. */
  applied: boolean;
  /** Contacts examined. */
  scanned: number;
  /** Contacts shaped like a correspondence provisioning (the real universe). */
  provisioned: number;
  /** Contacts retired (or that would be, on a dry run). */
  retired: number;
  candidates: RetirementCandidate[];
  skipped: RetirementSkip[];
  /** Where the undo manifest landed, once an applied run has written it. */
  manifestPath?: string;
}

/** Everything an undo run needs to put a channel back byte for byte. */
export interface RetirementManifestEntry {
  contactId: string;
  channelId: string;
  previousStatus: string;
  previousRevokedReason: string | null;
  previousUpdatedAt: number | null;
}

export interface RetirementManifest {
  appliedAt: number;
  entries: RetirementManifestEntry[];
}

export interface RetirementOptions {
  /** Write. Off by default — a plan is the default output. */
  apply?: boolean;
  /** Stop after this many candidates. */
  limit?: number;
  /** Include the display name and address on each candidate. */
  reveal?: boolean;
}

/**
 * The channel a correspondence provisioning would have written, if this
 * contact is shaped like one at all.
 *
 * Shape, not provenance: there is no "created by" column on contacts, so the
 * test is that the row looks like nothing but a provisioning could have
 * produced it — one `email` channel, no auth principal. A contact with a Slack
 * channel, or a principal, is out of scope entirely and never appears in the
 * report.
 *
 * `user_file` is deliberately NOT part of this test: `upsertContact` mints a
 * persona-file slug for every contact it creates, so its presence says nothing
 * about whether a human was involved.
 */
function provisionedEmailChannel(
  contact: ContactWithChannels,
): ContactChannel | null {
  if (contact.role !== "contact") return null;
  if (contact.contactType !== "human") return null;
  if (contact.principalId !== null) return null;
  if (contact.channels.length !== 1) return null;
  const channel = contact.channels[0];
  if (channel.type !== CORRESPONDENCE_CHANNEL_TYPE) return null;
  return channel;
}

function hasRememberedFacts(contactId: string): boolean {
  const db = getDb();
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(contactMemory)
    .where(eq(contactMemory.contactId, contactId))
    .get();
  return (Number(row?.n) || 0) > 0;
}

/**
 * Why this contact must be left alone, or null when nothing objects.
 *
 * Every one of these is a trace of a human hand: an invite, a verification, a
 * rename, a note, a remembered fact. Provisioning wrote none of them, so any
 * one of them means the row stopped being ours the moment it appeared.
 */
function ownerTouchReason(
  contact: ContactWithChannels,
  channel: ContactChannel,
): string | null {
  if (channel.verifiedAt !== null || channel.verifiedVia !== null) {
    return "channel was verified — that provenance was never ours to judge";
  }
  if (channel.inviteId !== null) {
    return "channel came from an invite — that provenance was never ours to judge";
  }
  if (channel.status !== "unverified") {
    return `channel status is "${channel.status}", not the provisioned "unverified"`;
  }
  if (channel.policy !== "escalate") {
    return `channel policy is "${channel.policy}", not the provisioned "escalate"`;
  }
  if (channel.blockedReason !== null || channel.revokedReason !== null) {
    return "channel carries a revoke/block reason written by somebody else";
  }
  if (!isDegenerateNotes(contact.notes, contact)) {
    return "the owner wrote notes on this contact";
  }
  if (hasRememberedFacts(contact.id)) {
    return "Cue remembers facts about this person";
  }
  return null;
}

/**
 * True when the displayed name is one provisioning could not have written.
 *
 * Provisioning only ever writes a name a header carried, or the humanized
 * local part; anything else was typed by a person. Checked AFTER the arrivals
 * judgement, and only ever for an address that has arrivals — with no arrival
 * rows there are no header names to compare against, and every contact would
 * read as renamed for the wrong reason.
 */
function renamedByHand(
  contact: ContactWithChannels,
  channel: ContactChannel,
): boolean {
  const provisionable = new Set<string>([
    humanizeAddress(channel.address),
    ...senderNamesFor(channel.address),
  ]);
  return !provisionable.has(contact.displayName.trim());
}

/**
 * Plan (and optionally apply) the retirement of auto-provisioned contacts that
 * the never-surfaced rule rejects.
 *
 * Re-runnable: a retired channel no longer has the provisioned `unverified`
 * status, so a second pass skips it and an interrupted pass resumes cleanly.
 */
export function retireCorrespondenceContacts(opts: RetirementOptions = {}): {
  report: RetirementReport;
  manifest: RetirementManifest | null;
} {
  const apply = opts.apply === true;
  const limit = Math.max(1, opts.limit ?? DEFAULT_SCAN_LIMIT);

  const contacts = listContacts(DEFAULT_SCAN_LIMIT, undefined, undefined, {
    uncapped: true,
  });
  const judgements = tallySenderArrivals();

  const report: RetirementReport = {
    applied: apply,
    scanned: contacts.length,
    provisioned: 0,
    retired: 0,
    candidates: [],
    skipped: [],
  };
  const entries: RetirementManifestEntry[] = [];

  for (const contact of contacts) {
    if (report.candidates.length >= limit) break;

    const channel = provisionedEmailChannel(contact);
    if (!channel) continue;
    report.provisioned++;

    const touched = ownerTouchReason(contact, channel);
    if (touched) {
      report.skipped.push({ contactId: contact.id, reason: touched });
      continue;
    }

    const judgement: SenderArrivalJudgement | undefined = judgements.get(
      channel.address.trim().toLowerCase(),
    );
    if (!judgement || judgement.total <= 0) {
      // The safety case, and the reason it is REPORTED rather than silently
      // passed over: an address the gate has never seen has not been judged,
      // and absence of judgement is not a judgement.
      report.skipped.push({
        contactId: contact.id,
        reason: "no arrivals — the gate has never judged this sender",
      });
      continue;
    }
    if (!isNeverSurfacedSender(judgement)) continue;

    if (renamedByHand(contact, channel)) {
      report.skipped.push({
        contactId: contact.id,
        reason: "the display name was edited by hand",
      });
      continue;
    }

    const candidate: RetirementCandidate = {
      contactId: contact.id,
      channelId: channel.id,
      arrivalCount: judgement.total,
      surfacedCount: judgement.surfaced,
    };
    if (opts.reveal) {
      candidate.displayName = contact.displayName;
      candidate.address = channel.address;
    }
    report.candidates.push(candidate);

    if (!apply) continue;

    entries.push({
      contactId: contact.id,
      channelId: channel.id,
      previousStatus: channel.status,
      previousRevokedReason: channel.revokedReason,
      previousUpdatedAt: channel.updatedAt,
    });
    updateChannelStatus(channel.id, {
      status: "revoked",
      revokedReason: CORRESPONDENCE_RETIRED_REASON,
    });
    report.retired++;
  }

  if (!apply) report.retired = report.candidates.length;

  if (apply && report.retired > 0) {
    emitContactChange();
    log.info(
      { retired: report.retired, provisioned: report.provisioned },
      "retired auto-provisioned contacts the gate never surfaced",
    );
  }

  return {
    report,
    manifest: apply ? { appliedAt: Date.now(), entries } : null,
  };
}

export interface RevertReport {
  applied: boolean;
  restored: number;
  skipped: RetirementSkip[];
}

/**
 * Put back everything an applied run retired.
 *
 * A channel is restored only while it still carries this cleanup's marker —
 * so a channel the owner has since revoked, verified or re-provisioned by hand
 * is left exactly as they left it. The undo can only undo its own work.
 */
export function revertContactRetirement(
  manifest: RetirementManifest,
  opts: { apply?: boolean } = {},
): RevertReport {
  const db = getDb();
  const apply = opts.apply === true;
  const report: RevertReport = { applied: apply, restored: 0, skipped: [] };

  for (const entry of manifest.entries) {
    const row = db
      .select({
        status: contactChannels.status,
        revokedReason: contactChannels.revokedReason,
      })
      .from(contactChannels)
      .where(eq(contactChannels.id, entry.channelId))
      .get();

    if (!row) {
      report.skipped.push({
        contactId: entry.contactId,
        reason: "channel no longer exists",
      });
      continue;
    }
    if (
      row.status !== "revoked" ||
      row.revokedReason !== CORRESPONDENCE_RETIRED_REASON
    ) {
      report.skipped.push({
        contactId: entry.contactId,
        reason: "channel was changed since it was retired — left as found",
      });
      continue;
    }

    if (apply) {
      updateChannelStatus(entry.channelId, {
        status: entry.previousStatus as ChannelStatus,
        revokedReason: entry.previousRevokedReason,
      });
      // `updateChannelStatus` stamps `updated_at`; restoring it keeps the undo
      // a true undo rather than a second edit wearing the first one's clothes.
      if (entry.previousUpdatedAt !== null) {
        db.update(contactChannels)
          .set({ updatedAt: entry.previousUpdatedAt })
          .where(eq(contactChannels.id, entry.channelId))
          .run();
      }
    }
    report.restored++;
  }

  if (apply && report.restored > 0) emitContactChange();
  return report;
}

/** A report a human can read, with no address or name in it. */
export function formatRetirementReport(report: RetirementReport): string {
  const lines: string[] = [];
  lines.push(
    report.applied
      ? "Correspondence contact cleanup — APPLIED"
      : "Correspondence contact cleanup — DRY RUN (nothing written)",
  );
  const row = (label: string, n: number) => `  ${label.padEnd(28)}${n}`;
  lines.push(
    row("contacts scanned:", report.scanned),
    row("auto-provisioned in shape:", report.provisioned),
    row(report.applied ? "retired:" : "would retire:", report.retired),
    row("left alone:", report.skipped.length),
  );

  if (report.candidates.length > 0) {
    lines.push("", "Candidates (arrivals seen → surfaced):");
    for (const c of report.candidates) {
      const who =
        c.displayName !== undefined ? `  ${c.displayName} <${c.address}>` : "";
      lines.push(
        `  · ${c.contactId}  ${c.arrivalCount} → ${c.surfacedCount}${who}`,
      );
    }
  }

  if (report.skipped.length > 0) {
    lines.push("", "Left alone:");
    for (const s of report.skipped) {
      lines.push(`  · ${s.contactId}: ${s.reason}`);
    }
  }

  return lines.join("\n");
}
