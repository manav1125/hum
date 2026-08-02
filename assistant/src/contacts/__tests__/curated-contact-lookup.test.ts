/**
 * The arrival gate's `known_contact` floor must not count a contact the gate
 * itself caused to exist.
 *
 * The loop this closes, which had already fired once on the owner's instance:
 * inbound mail mints a contact → the contact satisfies the `known_contact`
 * floor → the floor surfaces that sender's mail → the surfacing is then read
 * back as evidence the sender is a person, which justifies keeping the contact.
 * Every turn makes the next turn easier. Self-reinforcing evidence is not
 * evidence, and a guard that can be satisfied by its own output is not a guard.
 *
 * The distinction that breaks it: a HARVESTED channel is `unverified`; a channel
 * the owner invited, verified or added by hand is not. That is the whole
 * difference between "I know this person" and "this address has written to me".
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  findContactByAddress,
  findCuratedContactByAddress,
} from "../contact-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
});

/** Mint a contact carrying one email channel in the given state. */
function contactWith(address: string, status: string): string {
  const id = randomUUID();
  const now = Date.now();
  getDb().run(
    `INSERT INTO contacts (id, display_name, created_at, updated_at, role, contact_type)
     VALUES ('${id}', 'A Person', ${now}, ${now}, '', 'person')`,
  );
  getDb().run(
    `INSERT INTO contact_channels
       (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at)
     VALUES ('${randomUUID()}', '${id}', 'email', '${address}', 1, '${status}', 'escalate', 0, ${now})`,
  );
  return id;
}

describe("findCuratedContactByAddress", () => {
  test("a harvested (unverified) channel is NOT curated", () => {
    // This is the loop. Correspondence provisioning mints exactly this shape,
    // and it must not read back as "the owner knows this person".
    contactWith("harvested@example.com", "unverified");

    expect(
      findContactByAddress("email", "harvested@example.com"),
    ).not.toBeNull();
    expect(
      findCuratedContactByAddress("email", "harvested@example.com"),
    ).toBeNull();
  });

  test("an active channel IS curated — somebody stood behind it", () => {
    contactWith("invited@example.com", "active");
    expect(
      findCuratedContactByAddress("email", "invited@example.com"),
    ).not.toBeNull();
  });

  test("a pending invite counts — the owner initiated it", () => {
    contactWith("pending@example.com", "pending");
    expect(
      findCuratedContactByAddress("email", "pending@example.com"),
    ).not.toBeNull();
  });

  test("a revoked channel does not count", () => {
    // A channel the owner turned off is not a person they want surfaced by it.
    contactWith("revoked@example.com", "revoked");
    expect(
      findCuratedContactByAddress("email", "revoked@example.com"),
    ).toBeNull();
  });

  test("a blocked channel does not count", () => {
    contactWith("blocked@example.com", "blocked");
    expect(
      findCuratedContactByAddress("email", "blocked@example.com"),
    ).toBeNull();
  });

  test("an unknown address is null, not a throw", () => {
    expect(
      findCuratedContactByAddress("email", "nobody@example.com"),
    ).toBeNull();
  });

  test("the plain lookup still finds everything — People must show harvested rows", () => {
    // The two functions exist precisely because the answers differ. Browsing
    // who writes to you is the whole point of People; it is only the FLOOR
    // that may not treat harvesting as knowing.
    contactWith("harvested@example.com", "unverified");
    expect(
      findContactByAddress("email", "harvested@example.com"),
    ).not.toBeNull();
  });
});
