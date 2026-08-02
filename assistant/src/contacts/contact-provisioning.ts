/**
 * Provision contacts from correspondence.
 *
 * People only accumulates if somebody puts people in it. Every existing
 * ingress path mints a contact as a side effect of an INTERACTIVE channel
 * (a Slack DM, an invite redemption, a guardian bootstrap); mail has no such
 * moment, so an owner with years of email had a People surface with two rows
 * in it and an extraction job with nobody to extract for.
 *
 * This closes that: each distinct human correspondent in `arrivals` becomes a
 * contact with an `email` channel at their address, which is exactly the shape
 * the rest of the system already expects — `arrival-gate.ts` looks up
 * `findContactByAddress("email", …)` for its known-sender floor and, until
 * now, that lookup could never hit.
 *
 * ACCESS: provisioned channels are `status: "unverified"` and
 * `policy: "escalate"`. Ingress ACL denies any channel whose status is not
 * `active`, so knowing who somebody is grants them nothing. Being in the
 * owner's contacts must never be the same act as being allowed to instruct
 * their assistant.
 *
 * NAMES: an address that already has a contact is never renamed. A curated
 * "Mom" outranks whatever a mail header last called her, and a provisioning
 * pass that overwrote it would be a data-loss bug that reruns on a cadence.
 */

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { contactChannels } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import {
  type Correspondent,
  listCorrespondents,
} from "./contact-correspondence.js";
import { emitContactChange } from "./contact-events.js";
import { findContactByAddress, upsertContact } from "./contact-store.js";

const log = getLogger("contact-provisioning");

/** The channel type every provisioned mail correspondent gets. */
export const CORRESPONDENCE_CHANNEL_TYPE = "email";

export interface ProvisionedContact {
  contactId: string;
  address: string;
  displayName: string;
  created: boolean;
  messageCount: number;
  lastSeenAt: number;
}

export interface ProvisionReport {
  /** Correspondents the arrivals table offered, post-exclusions. */
  candidates: number;
  /** Contacts newly minted this pass. */
  created: number;
  /** Contacts that already existed and had their correspondence stats folded in. */
  updated: number;
  /** Candidates that could not be written (an error, counted not swallowed). */
  failed: number;
  /** True when nothing was written because this was a dry run. */
  dryRun: boolean;
  /** Per-contact detail, for a report a human can read. */
  contacts: ProvisionedContact[];
}

export interface ProvisionOptions {
  /** Only correspondence at or after this epoch ms. */
  since?: number;
  /** Drop anyone with fewer than this many messages. Default 1. */
  minMessages?: number;
  /** Cap on correspondents considered this pass. */
  limit?: number;
  /** Plan only — resolve candidates and write nothing. Default false. */
  dryRun?: boolean;
}

/**
 * Fold observed correspondence into the interaction counters the relationship
 * score reads. These live on `contact_channels` — the contacts row derives
 * its totals from them.
 *
 * Monotonic on purpose: the gateway also writes interaction stats, so this
 * takes the max rather than clobbering a live counter with a number derived
 * from the arrivals table alone.
 */
function recordCorrespondenceStats(
  channelId: string,
  messageCount: number,
  lastSeenAt: number,
): void {
  const db = getDb();
  db.update(contactChannels)
    .set({
      interactionCount: sql`MAX(COALESCE(${contactChannels.interactionCount}, 0), ${messageCount})`,
      lastInteraction: sql`MAX(COALESCE(${contactChannels.lastInteraction}, 0), ${lastSeenAt})`,
      lastSeenAt: sql`MAX(COALESCE(${contactChannels.lastSeenAt}, 0), ${lastSeenAt})`,
    })
    .where(eq(contactChannels.id, channelId))
    .run();
}

function emailChannelId(contactId: string, address: string): string | null {
  const db = getDb();
  const row = db
    .select({ id: contactChannels.id })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.contactId, contactId),
        eq(contactChannels.type, CORRESPONDENCE_CHANNEL_TYPE),
        eq(contactChannels.address, address),
      ),
    )
    .get();
  return row?.id ?? null;
}

/** Provision one correspondent. Returns null when nothing could be written. */
function provisionOne(person: Correspondent): ProvisionedContact | null {
  const existing = findContactByAddress(
    CORRESPONDENCE_CHANNEL_TYPE,
    person.address,
  );

  if (existing) {
    const channelId = emailChannelId(existing.id, person.address);
    if (channelId) {
      recordCorrespondenceStats(
        channelId,
        person.messageCount,
        person.lastSeenAt,
      );
    }
    return {
      contactId: existing.id,
      address: person.address,
      // The stored name wins — never renamed from a mail header.
      displayName: existing.displayName,
      created: false,
      messageCount: person.messageCount,
      lastSeenAt: person.lastSeenAt,
    };
  }

  const contact = upsertContact({
    displayName: person.displayName,
    role: "contact",
    contactType: "human",
    channels: [
      {
        type: CORRESPONDENCE_CHANNEL_TYPE,
        address: person.address,
        externalUserId: person.address,
        // Knowing who somebody is is not permission to act for them.
        status: "unverified",
        policy: "escalate",
      },
    ],
  });

  const channelId = emailChannelId(contact.id, person.address);
  if (!channelId) return null;
  recordCorrespondenceStats(channelId, person.messageCount, person.lastSeenAt);

  return {
    contactId: contact.id,
    address: person.address,
    displayName: contact.displayName,
    created: contact.created,
    messageCount: person.messageCount,
    lastSeenAt: person.lastSeenAt,
  };
}

/**
 * Turn the correspondence history into contacts.
 *
 * Idempotent and re-runnable: an address that already has a contact is
 * updated in place, never duplicated and never renamed. Nothing is deleted.
 */
export function provisionContactsFromCorrespondence(
  opts: ProvisionOptions = {},
): ProvisionReport {
  const people = listCorrespondents({
    since: opts.since,
    minMessages: opts.minMessages,
    limit: opts.limit,
  });

  const report: ProvisionReport = {
    candidates: people.length,
    created: 0,
    updated: 0,
    failed: 0,
    dryRun: opts.dryRun === true,
    contacts: [],
  };

  for (const person of people) {
    if (report.dryRun) {
      const existing = findContactByAddress(
        CORRESPONDENCE_CHANNEL_TYPE,
        person.address,
      );
      if (existing) report.updated++;
      else report.created++;
      report.contacts.push({
        contactId: existing?.id ?? "(would create)",
        address: person.address,
        displayName: existing?.displayName ?? person.displayName,
        created: !existing,
        messageCount: person.messageCount,
        lastSeenAt: person.lastSeenAt,
      });
      continue;
    }

    try {
      const result = provisionOne(person);
      if (!result) {
        report.failed++;
        continue;
      }
      if (result.created) report.created++;
      else report.updated++;
      report.contacts.push(result);
    } catch (err) {
      // Counted, not swallowed — a provisioning pass that failed on every
      // candidate must not read as a pass that found nobody.
      report.failed++;
      log.warn(
        { err: String(err) },
        "provisioning one correspondent failed (counted)",
      );
    }
  }

  if (!report.dryRun && (report.created > 0 || report.updated > 0)) {
    emitContactChange();
  }

  return report;
}
