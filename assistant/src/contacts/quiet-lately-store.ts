/**
 * Feeds {@link assessQuiet} from the arrivals table.
 *
 * The rhythm is computed from ARRIVALS rather than the contact row, because
 * `contacts.interactionCount` / `lastInteraction` are running totals — they can
 * tell you when someone last wrote, and nothing at all about how often they
 * usually do. A median needs the individual timestamps, and arrivals is the
 * only place they exist. There is already an index on
 * `(sender_address, occurred_at)`, which is exactly this query's shape.
 *
 * Candidates are drawn from CONTACTS, not from distinct arrival senders. That
 * is deliberate: People has already had to be cleared of robots once, and the
 * contact list is where the human/bulk judgement lives. Re-deriving it here
 * would give this surface its own opinion about who is a person, and the two
 * would drift.
 */

import { and, gte, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { arrivals } from "../memory/schema/index.js";
import { getLogger } from "../util/logger.js";
import { listContacts } from "./contact-store.js";
import {
  assessAllQuiet,
  BASELINE_WINDOW_DAYS,
  countEligible,
  type QuietCandidate,
  type QuietVerdict,
} from "./quiet-lately.js";

const log = getLogger("quiet-lately");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many contacts to consider. Bounded because this walks every candidate's
 * arrival history; the surface shows a short list and nobody scrolls a
 * thousand rows of "quiet".
 */
const MAX_CANDIDATES = 500;

export interface QuietLatelyRow extends QuietVerdict {
  contactId: string;
  name: string | null;
  address: string;
}

export interface QuietLatelyResult {
  rows: QuietLatelyRow[];
  /**
   * Contacts with enough history to be judged. Drives the difference between
   * the surface's two empty states — "everyone's talking at their usual pace"
   * (eligible, none quiet) and "Cue needs a rhythm first" (none eligible).
   * They are different facts and must never share a sentence.
   */
  eligible: number;
  /** Contacts looked at, whether or not they had a baseline. */
  considered: number;
}

/**
 * Everyone currently quiet relative to their own rhythm.
 *
 * Throws rather than returning an empty result on a read failure. The caller
 * renders a "couldn't check" state, and that distinction is the whole point:
 * an empty list means Cue looked and found nobody, which is a claim about the
 * owner's relationships. A swallowed error would make a database problem look
 * like good news.
 */
export function getQuietLately(now = Date.now()): QuietLatelyResult {
  const db = getDb();
  const contactList = listContacts(MAX_CANDIDATES, undefined, undefined, {
    uncapped: true,
  });

  // Map every known email address back to its contact. A person with three
  // addresses is one candidate, not three — otherwise each address carries a
  // third of the history and none of them clears the eligibility bar.
  const addressToContact = new Map<string, (typeof contactList)[number]>();
  for (const c of contactList) {
    for (const ch of c.channels ?? []) {
      const addr = ch.address?.trim().toLowerCase();
      if (addr) addressToContact.set(addr, c);
    }
  }
  if (addressToContact.size === 0) {
    return { rows: [], eligible: 0, considered: contactList.length };
  }

  const cutoff = now - BASELINE_WINDOW_DAYS * DAY_MS;
  const rows = db
    .select({
      sender: arrivals.senderAddress,
      at: arrivals.occurredAt,
    })
    .from(arrivals)
    .where(
      and(
        isNotNull(arrivals.senderAddress),
        isNotNull(arrivals.occurredAt),
        gte(arrivals.occurredAt, cutoff),
        inArray(arrivals.senderAddress, [...addressToContact.keys()]),
      ),
    )
    .all();

  const byContact = new Map<string, number[]>();
  for (const r of rows) {
    const contact = addressToContact.get((r.sender ?? "").trim().toLowerCase());
    if (!contact || r.at == null) continue;
    const list = byContact.get(contact.id);
    if (list) list.push(r.at);
    else byContact.set(contact.id, [r.at]);
  }

  const candidates: QuietCandidate[] = [...byContact.entries()].map(
    ([key, timestamps]) => ({ key, timestamps }),
  );

  const verdicts = assessAllQuiet(candidates, now);
  const eligible = countEligible(candidates, now);

  const byId = new Map(contactList.map((c) => [c.id, c]));
  const out: QuietLatelyRow[] = [];
  for (const v of verdicts) {
    const c = byId.get(v.key);
    if (!c) continue;
    const primary =
      (c.channels ?? []).find((ch) => ch.isPrimary) ?? (c.channels ?? [])[0];
    out.push({
      ...v,
      contactId: c.id,
      name: c.displayName ?? null,
      address: primary?.address ?? "",
    });
  }

  log.debug(
    { considered: candidates.length, eligible, quiet: out.length },
    "quiet-lately computed",
  );

  return { rows: out, eligible, considered: candidates.length };
}
