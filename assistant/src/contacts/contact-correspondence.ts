/**
 * Correspondence → People: the substrate the contact layer had no reader for.
 *
 * `contact_memory` is fed by an extraction pass that can only act on a person
 * Cue already knows. Until this module existed the ONLY way a person became
 * known was a channel binding minted by an interactive channel (a Slack DM, a
 * Telegram chat, an invite redemption) — so an owner whose real correspondence
 * is email had two contacts and Cue learned nothing about anybody, while the
 * extraction job reported success several hundred times.
 *
 * The `arrivals` table already holds the answer: every message the watchers
 * saw, with a lowercased `sender_address`, the sender's display name, the
 * subject, and a bounded snippet. This module reads that table (never writes
 * it) and turns it into two things the contacts layer can use:
 *
 *   1. {@link listCorrespondents} — who the owner actually corresponds with,
 *      aggregated per address, so provisioning has candidates; and
 *   2. {@link listCorrespondenceFor} — one person's recent mail, so the
 *      extraction pass has something to read.
 *
 * WHO IS EXCLUDED, and why it is a claim about the address rather than the
 * person: bulk senders (`noreply@`, `newsletter@` …) are dropped via the same
 * {@link isBulkSenderAddress} test the arrival gate uses — an address that has
 * structurally refused a reply is not a correspondent. The owner's own
 * addresses (any channel on a guardian contact) are dropped too: Cue must not
 * mint a contact for its own owner and then remember facts about them here.
 * And a sender whose every last message the arrival gate FILED is dropped by
 * {@link isNeverSurfacedSender} — see below. Nothing else is filtered.
 * `support@`, `hello@` and `team@` are routinely human, and a person who
 * emailed once is still a person.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { isBulkSenderAddress } from "../arrivals/arrival-sender-shape.js";
import { getDb } from "../memory/db-connection.js";
import { arrivals, contactChannels, contacts } from "../memory/schema/index.js";

/** One person the owner exchanges mail with, aggregated across arrivals. */
export interface Correspondent {
  /** Lowercased address — the identity key, and the `email` channel address. */
  address: string;
  /** Best available human name; falls back to a humanized local part. */
  displayName: string;
  /** The arrival channel their mail came in on, e.g. `watcher:gmail`. */
  channel: string;
  /** How many arrivals carry this address as the sender. */
  messageCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** One piece of a correspondent's mail, as much as `arrivals` retained. */
export interface CorrespondenceItem {
  title: string;
  snippet: string | null;
  senderName: string | null;
  createdAt: number;
}

export interface ListCorrespondentsOptions {
  /** Only arrivals at or after this epoch ms. */
  since?: number;
  /** Drop anyone with fewer than this many messages. Default 1. */
  minMessages?: number;
  /** Cap the number of correspondents returned (busiest first). Default 500. */
  limit?: number;
}

const DEFAULT_CORRESPONDENT_LIMIT = 500;

/**
 * Loose structural check that an address could be a mailbox. Deliberately not
 * a validator — a stricter test would silently drop real people, which is the
 * failure this whole module exists to undo.
 */
export function looksLikeEmailAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1);
  return domain.includes(".") && !/\s/.test(address);
}

/**
 * Sending subdomains that only ever front a bulk mailer.
 *
 * Deliberately the LEFTMOST label only, and deliberately not shared with
 * `isBulkSenderAddress`: that predicate is the arrival gate's FILING rule, and
 * widening it would start filing a real person's mail — the one direction this
 * codebase must never move in. This list is used at the contact layer alone,
 * where the cost of a wrong call is a missing row on People rather than a
 * missed message.
 */
const BULK_SENDING_SUBDOMAINS = new Set([
  "mail",
  "email",
  "mailer",
  "mailing",
  "welcome",
  "communication",
  "communications",
  "news",
  "newsletter",
  "notify",
  "notification",
  "notifications",
  "reply",
  "replies",
  "info",
  "marketing",
  "campaign",
  "campaigns",
  "em",
]);

/**
 * True when the address is sent from a dedicated bulk-mail subdomain.
 *
 * `isBulkSenderAddress` reads only the LOCAL part against a 21-name list, so
 * every shape below slipped through and became a "human" on People — a card
 * issuer at `welcome.`, a delivery app at `mail.`, a cloud vendor at
 * `communication.`, a bank at `info.`, a school platform at `mail1.`. Not one
 * has a bulk local part; every one announces itself in the domain.
 *
 * Trailing digits are stripped so `mail1.` and `em2.` match — ESPs number
 * their sending pools. A bare two-label domain never matches, and neither does
 * a person at one; the cost of the rule is a human who genuinely sends from a
 * `mail.` subdomain, which is rare enough to accept here and whose mail still
 * reaches the owner normally, since filing is untouched.
 */
export function hasBulkSendingSubdomain(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const labels = address
    .slice(at + 1)
    .toLowerCase()
    .split(".");
  // Needs a subdomain: `mail.example.com` has 3 labels, `example.com` has 2.
  if (labels.length < 3) return false;
  const first = labels[0]?.replace(/\d+$/, "") ?? "";
  return BULK_SENDING_SUBDOMAINS.has(first);
}

/**
 * Turn `jane.doe` into `Jane Doe` for an address whose mail never carried a
 * display name. Better than showing a raw address on a person card, and never
 * invents a surname that was not in the address.
 */
export function humanizeAddress(address: string): string {
  const local = address.slice(0, Math.max(0, address.lastIndexOf("@")));
  const words = local
    .split(/[._\-+]+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w));
  if (words.length === 0) return address;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

/**
 * What the arrival gate decided about one sender address, over all history.
 *
 * `surfaced` counts reversals too: reversing a filing rewrites the row's
 * disposition to `surfaced`, so an item the owner personally rescued reads
 * here as exactly what it is — a message that reached them.
 */
export interface SenderArrivalJudgement {
  /** Arrivals from this address, whatever the gate decided about them. */
  total: number;
  /** How many of those the gate put in front of the owner. */
  surfaced: number;
  /** How many it explicitly filed. */
  filed: number;
}

/**
 * The gate's dispositions, tallied per sender address.
 *
 * Deliberately NOT bounded by the caller's `since` window. "Never once
 * surfaced" is a claim about a correspondent's whole history; scoping it to a
 * window would let a quiet month demote somebody the owner has been reading
 * for a year.
 */
export function tallySenderArrivals(): Map<string, SenderArrivalJudgement> {
  const db = getDb();
  const rows = db
    .select({
      address: arrivals.senderAddress,
      total: sql<number>`count(*)`,
      surfaced: sql<number>`sum(case when ${arrivals.disposition} = 'surfaced' then 1 else 0 end)`,
      filed: sql<number>`sum(case when ${arrivals.disposition} = 'filed' then 1 else 0 end)`,
    })
    .from(arrivals)
    .where(
      and(
        isNotNull(arrivals.senderAddress),
        sql`trim(${arrivals.senderAddress}) <> ''`,
      ),
    )
    .groupBy(arrivals.senderAddress)
    .all();

  const out = new Map<string, SenderArrivalJudgement>();
  for (const row of rows) {
    const address = (row.address ?? "").trim().toLowerCase();
    if (!address) continue;
    out.set(address, {
      total: Number(row.total) || 0,
      surfaced: Number(row.surfaced) || 0,
      filed: Number(row.filed) || 0,
    });
  }
  return out;
}

/**
 * True when the gate has judged this sender and filed EVERY message they sent.
 *
 * The rule this encodes: a correspondent whose mail has never once been
 * surfaced is a sender, not a person. It reuses a decision Cue already made
 * and stored, rather than inventing a second classifier that can disagree with
 * the first — which is why it catches `HSBC@…`, whose local part is nothing
 * like `noreply@` but whose every message the gate filed.
 *
 * THE DIRECTION MATTERS, and it is the whole safety of this test. Excluding
 * requires a judgement to exist AND to be unanimous: `total > 0` and every
 * one of those rows explicitly `filed`. An address with no arrival rows at all
 * — a channel that predates the gate, an import, a sender whose history was
 * pruned — is NOT excluded. Absence of judgement is not a judgement, and
 * reading it as one would silently drop real people, which is the exact
 * failure the correspondence reader exists to undo.
 *
 * Counting `filed` rather than negating `surfaced` is the same caution one
 * level down: a row carrying any other disposition has not been filed, so it
 * cannot contribute to a claim that everything was.
 */
export function isNeverSurfacedSender(
  judgement: SenderArrivalJudgement | undefined | null,
): boolean {
  if (!judgement) return false;
  if (judgement.total <= 0) return false;
  return judgement.filed === judgement.total;
}

/** Every address reachable on a guardian contact — the owner's own mail. */
function guardianAddresses(): Set<string> {
  const db = getDb();
  const rows = db
    .select({ address: contactChannels.address })
    .from(contactChannels)
    .innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
    .where(eq(contacts.role, "guardian"))
    .all();
  return new Set(rows.map((r) => r.address.toLowerCase()));
}

/**
 * Who the owner corresponds with, busiest first.
 *
 * Aggregated in SQL so a long history stays one query; the bulk-sender,
 * guardian and never-surfaced exclusions run in TypeScript because all three
 * are shared judgements that must read identically here and at the arrival
 * boundary.
 */
export function listCorrespondents(
  opts: ListCorrespondentsOptions = {},
): Correspondent[] {
  const db = getDb();
  const minMessages = Math.max(1, opts.minMessages ?? 1);
  const limit = Math.max(1, opts.limit ?? DEFAULT_CORRESPONDENT_LIMIT);

  const conditions = [
    isNotNull(arrivals.senderAddress),
    sql`trim(${arrivals.senderAddress}) <> ''`,
    ...(opts.since !== undefined ? [gte(arrivals.createdAt, opts.since)] : []),
  ];

  const counts = db
    .select({
      address: arrivals.senderAddress,
      messageCount: sql<number>`count(*)`,
      firstSeenAt: sql<number>`min(${arrivals.createdAt})`,
      lastSeenAt: sql<number>`max(${arrivals.createdAt})`,
    })
    .from(arrivals)
    .where(and(...conditions))
    .groupBy(arrivals.senderAddress)
    .having(sql`count(*) >= ${minMessages}`)
    .orderBy(sql`count(*) DESC`)
    .all();

  // The name and channel from each sender's MOST RECENT message: a rename
  // should win, and somebody who moved should read as where they are now.
  // Exactly one aggregate (`max`) so SQLite's bare-column rule is the
  // well-defined one — the bare columns come from the row that produced the
  // max. Two aggregates in the same select would make which row undefined,
  // which is how one sender ends up wearing another sender's name.
  const latestChannel = db
    .select({
      address: arrivals.senderAddress,
      at: sql<number>`max(${arrivals.createdAt})`,
      channel: arrivals.channel,
    })
    .from(arrivals)
    .where(and(...conditions))
    .groupBy(arrivals.senderAddress)
    .all();
  const channelByAddress = new Map(
    latestChannel.map((r) => [(r.address ?? "").toLowerCase(), r.channel]),
  );

  // Named messages only, so a person whose latest mail carried no display
  // name keeps the name their earlier mail did carry.
  const latestName = db
    .select({
      address: arrivals.senderAddress,
      at: sql<number>`max(${arrivals.createdAt})`,
      senderName: arrivals.senderName,
    })
    .from(arrivals)
    .where(
      and(
        ...conditions,
        isNotNull(arrivals.senderName),
        sql`trim(${arrivals.senderName}) <> ''`,
      ),
    )
    .groupBy(arrivals.senderAddress)
    .all();
  const nameByAddress = new Map(
    latestName.map((r) => [(r.address ?? "").toLowerCase(), r.senderName]),
  );

  const guardians = guardianAddresses();
  const judgements = tallySenderArrivals();
  const out: Correspondent[] = [];
  for (const row of counts) {
    const address = (row.address ?? "").trim().toLowerCase();
    if (!address || !looksLikeEmailAddress(address)) continue;
    if (isBulkSenderAddress(address)) continue;
    // The gate's local-part rule is not enough on its own: `direct_human`
    // SURFACES these senders, so `isNeverSurfacedSender` below can never
    // retire them either — a sender the safety floor surfaces is by
    // definition not "never surfaced". Without this line the People list
    // filled with card issuers, delivery apps, cloud vendors and banks — 22
    // of them in one day, every row labelled `human`.
    if (hasBulkSendingSubdomain(address)) continue;
    if (guardians.has(address)) continue;
    if (isNeverSurfacedSender(judgements.get(address))) continue;
    const name = nameByAddress.get(address)?.trim();
    out.push({
      address,
      displayName: name && name.length > 0 ? name : humanizeAddress(address),
      channel: channelByAddress.get(address) ?? "unknown",
      messageCount: Number(row.messageCount) || 0,
      firstSeenAt: Number(row.firstSeenAt) || 0,
      lastSeenAt: Number(row.lastSeenAt) || 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Every display name this address has ever signed its mail with.
 *
 * Used to tell a provisioned name apart from one the owner typed: provisioning
 * can only ever have written a name that appeared in a header, or the
 * humanized local part. A name that is neither came from a human hand.
 */
export function senderNamesFor(address: string): string[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ senderName: arrivals.senderName })
    .from(arrivals)
    .where(
      and(
        eq(arrivals.senderAddress, address.trim().toLowerCase()),
        isNotNull(arrivals.senderName),
        sql`trim(${arrivals.senderName}) <> ''`,
      ),
    )
    .all();
  return rows
    .map((r) => (r.senderName ?? "").trim())
    .filter((n) => n.length > 0);
}

/** One correspondent's most recent mail, newest first. */
export function listCorrespondenceFor(
  address: string,
  limit = 25,
): CorrespondenceItem[] {
  const db = getDb();
  return db
    .select({
      title: arrivals.title,
      snippet: arrivals.snippet,
      senderName: arrivals.senderName,
      createdAt: arrivals.createdAt,
    })
    .from(arrivals)
    .where(eq(arrivals.senderAddress, address.trim().toLowerCase()))
    .orderBy(desc(arrivals.createdAt))
    .limit(Math.max(1, limit))
    .all();
}

/**
 * Render a correspondent's mail as the same speaker-prefixed transcript the
 * conversation path produces, so ONE prompt, ONE parser and ONE dedupe serve
 * both sources. Everything on a line was written by them; the owner's replies
 * are not in `arrivals` and are deliberately not invented.
 */
export function renderCorrespondenceTranscript(
  items: CorrespondenceItem[],
  displayName: string,
): string {
  const lines: string[] = [];
  for (const item of items) {
    const subject = item.title.replace(/\s+/g, " ").trim();
    const body = item.snippet?.replace(/\s+/g, " ").trim() ?? "";
    const text = body ? `${subject} — ${body}` : subject;
    if (!text) continue;
    lines.push(`${displayName}: ${text}`);
  }
  return lines.join("\n");
}
