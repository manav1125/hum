/**
 * Sender-shape tests, shared by the live gate and the retro run.
 *
 * These read the ADDRESS and the SUBJECT rather than the message body, which is
 * why they are usable in two places that see very different amounts of data:
 * the live boundary has full headers, the retro run has almost nothing, and an
 * address survives in both.
 */

/**
 * Local-parts that only ever belong to a machine sending to a crowd.
 *
 * This is a claim about the ADDRESS, not about the content — which is the only
 * reason it is allowed on a thin row. `noreply@` is not a judgement that the
 * message is unimportant; it is an observation that the sender has structurally
 * refused a reply, and a correspondent who cannot be answered is not
 * correspondence. That property survived in the stored `from`, so it can be
 * read retroactively without inventing anything.
 *
 * Deliberately NOT included: `support@`, `hello@`, `team@`, `billing@`,
 * `admin@`, `accounts@`. Every one of those is routinely a human, or a robot
 * whose message needs an answer — an approval request, an expiring token, an
 * invoice. Those are exactly the items the owner needs surfaced, and the eight
 * identical promos this rule exists to clear are not worth one missed invoice.
 */
const BULK_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "newsletters",
  "news",
  "promotions",
  "promo",
  "campaigns",
  "campaign",
  "marketing",
  "mailer",
  "mailing",
  "notification",
  "notifications",
  "buzz",
  "digest",
  "updates",
  "bounce",
] as const;

/**
 * True when the address is structurally a bulk sender.
 *
 * Matches the local part exactly, or as a `-`/`.`/`_`-delimited token within
 * it, so `news-noreply@` and `en_flight_noreply@` both hit while `newsome@`
 * (a surname) does not. Substring matching would
 * catch the surname, and filing a person's mail because their name contains
 * "news" is precisely the failure this whole system is built to avoid.
 */
export function isBulkSenderAddress(address: string | null): boolean {
  if (!address) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at).toLowerCase();
  const tokens = local.split(/[-._+]/).filter(Boolean);
  return BULK_LOCAL_PARTS.some((p) => local === p || tokens.includes(p));
}

/**
 * The retro-only sender-shape rule.
 *
 * Retro-only on purpose: at the live boundary the real headers are present, and
 * `List-Unsubscribe` / `Precedence` / `Auto-Submitted` are strictly better
 * evidence than an address pattern. This exists because those headers were
 * never captured for mail that arrived before the gate, and the alternative for
 * the owner is reading eight identical promos by hand.
 */
/**
 * Subjects that mean "a robot is telling you something you must act on".
 *
 * This exists because the sender-shape rule was wrong on real data. A dry run
 * over the owner's backlog would have filed "New request AR-5258 awaits your
 * approval", "Transaction failed", "You've received HKD 10,000.00" and "Your
 * personal access token has expired" — every one from a `no-reply@` or
 * `notification@` address, and every one of them mattering.
 *
 * The lesson, and it is the same one the whole gate is built around: the
 * address tells you the SENDER is a machine. It says nothing about whether the
 * MESSAGE is worth reading. Approvals, payment failures, expiring credentials
 * and security notices are precisely the mail that arrives from an address that
 * cannot be replied to.
 *
 * So this is a rescue list, never a filing list. It can only move an item from
 * filed to kept.
 */
const TRANSACTIONAL_SUBJECT = new RegExp(
  [
    "approv", // "awaits your approval", "approval required"
    "expir", // tokens, cards, subscriptions
    "declin",
    "fail", // "Transaction failed", "payment failed"
    "overdue",
    "past due",
    "suspend",
    "revoked",
    "unauthori[sz]ed",
    "security alert",
    "verify|verification",
    "confirm your",
    "action required|action needed",
    "reset your",
    "sign-in|sign in|login|log in",
    "invoice",
    "receipt",
    "refund",
    "chargeback",
    "you'?ve received",
    "has been (sent|received|blocked|unblocked|cancelled|canceled)",
    "final (notice|reminder)",
    "deadline|due (on|by|date)",
    // Money moving, or a record of it. A bank writing from a no-reply address
    // is the norm, not the exception, so without these the sender rule files
    // statements and payment advices.
    "payment|payout|direct debit",
    "statement",
    "transaction",
    "transfer",
    "subscription",
  ].join("|"),
  "i",
);

/**
 * True when a subject line names something the owner has to do or know about.
 * Deliberately generous: a false positive here costs one kept promo, a false
 * negative costs a missed approval or an expired credential.
 */
export function looksTransactional(subject: string | null): boolean {
  if (!subject) return false;
  return TRANSACTIONAL_SUBJECT.test(subject);
}
