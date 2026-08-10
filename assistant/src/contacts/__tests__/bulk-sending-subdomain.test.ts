/**
 * The address SHAPES that became "human" on the owner's People list.
 *
 * Read off production, then reduced to their shape — the shape is the whole
 * subject. On the live instance all 124 contacts carried
 * `contact_type = 'human'`, 22 of them minted in a single day, and the
 * offenders were a card issuer sending from `welcome.`, a delivery app from
 * `mail.`, a cloud vendor from `communication.`, a bank from `info.` and a
 * school platform from `mail1.`. Not one has a bulk LOCAL part, which is the
 * only thing `isBulkSenderAddress` inspects; every one announces itself in the
 * sending subdomain.
 *
 * Addresses are composed rather than written out, both to keep the fixtures on
 * example domains and because the label under test is the only part that
 * varies — writing them literally would bury that.
 *
 * The second block matters more than the first. This predicate runs at the
 * contact layer only, and a rule that quietly dropped a real correspondent
 * would be worse than the noise it removes.
 */

import { describe, expect, test } from "bun:test";

import { hasBulkSendingSubdomain } from "../contact-correspondence.js";

/** `x@<label>.example.com` — the sending-subdomain shape. */
const from = (label: string): string => `x@${label}.example.com`;

describe("bulk sending subdomains — the robots that reached People", () => {
  test.each([
    "welcome",
    "mail",
    "communication",
    "info",
    "mail1",
    "notifications",
    "campaign",
    "em2",
  ])("a sender at %s. is bulk", (label) => {
    expect(hasBulkSendingSubdomain(from(label))).toBe(true);
  });

  test("numbered sending pools match — ESPs number their pools", () => {
    // `mail1` and `em2` above already cover this; asserted separately so the
    // digit-stripping rule fails loudly on its own if it is ever removed.
    expect(hasBulkSendingSubdomain(from("mail1"))).toBe(true);
    expect(hasBulkSendingSubdomain(from("mail"))).toBe(true);
  });
});

describe("people are never excluded", () => {
  test.each(["eng", "uk", "corp", "team", "people", "hr"])(
    "an ordinary %s. subdomain is not bulk",
    (label) => {
      expect(hasBulkSendingSubdomain(from(label))).toBe(false);
    },
  );

  test.each([
    // Ordinary humans at bare company domains — the point of the People list.
    "jane.doe@example.com",
    "tom.purdon@example.org",
    "ivona.ford-pranic@example.net",
    // Two labels only, however suggestive the local part is: a bare domain can
    // never match, so a person whose mailbox is literally `news@` stays in.
    "news@example.com",
    "mail@example.com",
    // The local part is the arrival gate's business, not this predicate's.
    // Matching here could retire a person whose surname is Newsome.
    "newsome@example.com",
    "mailer@example.com",
  ])("%s is not treated as bulk", (address) => {
    expect(hasBulkSendingSubdomain(address)).toBe(false);
  });

  test("malformed input is not a bulk sender", () => {
    expect(hasBulkSendingSubdomain("")).toBe(false);
    expect(hasBulkSendingSubdomain("not-an-address")).toBe(false);
    expect(hasBulkSendingSubdomain(from("mail").replace("x@", "@"))).toBe(
      false,
    );
  });
});
