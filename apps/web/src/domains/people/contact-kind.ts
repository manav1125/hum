/**
 * People, and everything else that writes to you — `People` triage.
 *
 * Once Cue reads a whole mailbox, "everyone Cue has learnt about" is mostly
 * not people: it is receipts, newsletters, alerts, `no-reply@` senders and
 * support desks. Those belong in the list — they are real correspondents and
 * hiding them would make the page lie about what Cue knows — but they must not
 * be the first thing you see when you came looking for a person.
 *
 * **Nothing is filtered away.** This sorts into two labelled groups whose
 * counts are both on screen. That distinction matters: a judgement about
 * content may organise what you see, but the moment it *removes* something the
 * page stops being a record of what Cue knows and becomes an opinion about it.
 *
 * The judgement is deliberately made from the address rather than from a
 * model. An address is a fact this device already holds, it is the same answer
 * every time, and when it is wrong it is wrong in a way you can see and
 * explain — none of which is true of asking a model to guess at a name.
 */

/** Just the channels this needs, so tests need not build a whole contact. */
export interface ContactKindInput {
  displayName?: string;
  channels?: Array<{ type?: string; address?: string }>;
}

export type ContactKind = "person" | "service";

/**
 * Local-parts that are never a person, whatever follows them.
 *
 * A suffix is allowed here — `noreply-marketing@`, `notifications+cue@` — because
 * no arrangement of these words is somebody's name.
 */
const NEVER_A_PERSON =
  /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|alerts?|mailer|mailer-daemon|bounces?|postmaster|abuse|automated|autoresponder|daemon|digest|webmaster|unsubscribe|listserv)([-.+_].*)?$/i;

/**
 * Role addresses — a service only when the role is the WHOLE local-part.
 *
 * No suffix allowed, and that restriction is the point. `sales@example.com` is a
 * desk; `sales_rodriguez@example.com` is a person in sales whose surname happens
 * to follow. The first version of this let any separator through and filed
 * them together, which is a person you stop seeing — the one failure this
 * split may not have.
 */
const ROLE_ADDRESS =
  /^(support|helpdesk|help|info|hello|hi|contact|enquiries|inquiries|admin|billing|invoices?|receipts?|accounts|payments?|orders?|sales|marketing|promotions?|promo|offers|deals|social|system|robot|bot|news|newsletters?|team|careers|jobs|recruiting|security|privacy|legal|feedback|survey|service|services|customercare|customerservice|press|media|partners|hr|finance|office|mail|email)$/i;

/**
 * Sending subdomains bulk-mail platforms use.
 *
 * A person is at the bare domain; a campaign is at a sending subdomain of it.
 * Matching the *first* label only, so `mail.<domain>` is caught and the domain
 * itself is not.
 */
const BULK_SUBDOMAIN =
  /^(e|em|mail|email|mailer|news|newsletter|mktg|marketing|send|sender|smtp|notify|notifications?|alerts?|reply|replies|bounce|bounces|t|link|links|click|clicks|go|cmail|campaign|campaigns|info|updates?)\./i;

/** Which side of the split a contact falls on. */
export function classifyContact(contact: ContactKindInput): ContactKind {
  for (const channel of contact.channels ?? []) {
    const address = channel.address?.trim().toLowerCase();
    if (!address) continue;
    const at = address.lastIndexOf("@");
    // Not an email — a phone number, a Slack id, a Telegram chat. Those reach
    // an actual person by construction, so they say nothing against one.
    if (at <= 0) continue;
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    if (NEVER_A_PERSON.test(local) || ROLE_ADDRESS.test(local)) return "service";
    if (BULK_SUBDOMAIN.test(domain)) return "service";
  }
  return "person";
}

/**
 * Split a list in one pass, order preserved within each side.
 *
 * Returns both halves rather than the chosen one, because the counts are part
 * of the promise: a tab that says "Services 214" is what makes it obvious that
 * nothing was thrown away.
 */
export function splitContacts<T extends ContactKindInput>(
  contacts: T[],
): { people: T[]; services: T[] } {
  const people: T[] = [];
  const services: T[] = [];
  for (const contact of contacts) {
    (classifyContact(contact) === "service" ? services : people).push(contact);
  }
  return { people, services };
}
