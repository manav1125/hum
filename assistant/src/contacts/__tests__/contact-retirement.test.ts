/**
 * The cleanup for the 74 contacts the first correspondence sweep created.
 *
 * Every assertion here is about rows in `contacts`, `contact_channels` and
 * `arrivals` after the REAL cleanup ran against a state built by the REAL
 * provisioning path — a contact is minted from mail that was surfaced, the
 * gate's verdicts are then what production's were (all filed), and the cleanup
 * is asked what it would do. A report is never the assertion.
 *
 * Two properties are load-bearing and have a test each:
 *   · a contact whose address has NO arrival rows is never retired — absence
 *     of judgement is not a judgement; and
 *   · nothing is deleted and everything is reversible.
 *
 * Fixtures use example.com addresses and invented names.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { dedupeContactsForDisplay } from "../contact-presentation.js";
import { provisionContactsFromCorrespondence } from "../contact-provisioning.js";
import {
  CORRESPONDENCE_RETIRED_REASON,
  formatRetirementReport,
  retireCorrespondenceContacts,
  revertContactRetirement,
} from "../contact-retirement.js";
import {
  findContactByAddress,
  listContacts,
  updateChannelStatus,
} from "../contact-store.js";

initializeDb();

function seedArrival(opts: {
  address: string;
  senderName?: string | null;
  title: string;
  disposition?: "surfaced" | "filed";
}): void {
  const now = Date.now();
  getSqliteFrom(getDb())
    .prepare(
      `INSERT INTO arrivals
         (id, channel, external_id, title, sender_address, sender_name,
          disposition, decided_by, created_at, updated_at)
       VALUES (?, 'watcher:gmail', ?, ?, ?, ?, ?, 'rule', ?, ?)`,
    )
    .run(
      randomUUID(),
      randomUUID(),
      opts.title,
      opts.address.toLowerCase(),
      opts.senderName ?? null,
      opts.disposition ?? "surfaced",
      now,
      now,
    );
}

/**
 * Reproduce production: a contact the OLD rule provisioned, whose mail the
 * gate had in fact filed every time. Built through the real provisioning path
 * (which is why the arrivals start surfaced) and then given the dispositions
 * the gate actually recorded.
 */
function provisionedUnderTheOldRule(opts: {
  address: string;
  senderName?: string;
  messages?: number;
}): string {
  for (let i = 0; i < (opts.messages ?? 3); i++) {
    seedArrival({
      address: opts.address,
      senderName: opts.senderName ?? null,
      title: `Message ${i}`,
    });
  }
  provisionContactsFromCorrespondence();
  getDb().run(
    `UPDATE arrivals SET disposition = 'filed' WHERE sender_address = '${opts.address.toLowerCase()}'`,
  );
  const contact = findContactByAddress("email", opts.address.toLowerCase());
  if (!contact) throw new Error("fixture did not provision a contact");
  return contact.id;
}

function tableCount(table: string): number {
  const row = getSqliteFrom(getDb())
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .get() as { n: number };
  return Number(row.n);
}

function channelOf(contactId: string): {
  id: string;
  status: string;
  revokedReason: string | null;
  updatedAt: number | null;
} {
  return getSqliteFrom(getDb())
    .prepare(
      `SELECT id, status, revoked_reason AS revokedReason, updated_at AS updatedAt
         FROM contact_channels WHERE contact_id = ?`,
    )
    .get(contactId) as {
    id: string;
    status: string;
    revokedReason: string | null;
    updatedAt: number | null;
  };
}

beforeEach(() => {
  getDb().run("DELETE FROM contact_memory");
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
  getDb().run("DELETE FROM arrivals");
});

const BANK = "examplebank@example.com";

describe("retiring the senders the gate never surfaced", () => {
  test("a dry run plans the retirement and writes nothing", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });

    const { report, manifest } = retireCorrespondenceContacts();
    expect(report.applied).toBe(false);
    expect(report.retired).toBe(1);
    expect(report.candidates[0].contactId).toBe(contactId);
    expect(report.candidates[0].arrivalCount).toBe(3);
    expect(report.candidates[0].surfacedCount).toBe(0);
    expect(manifest).toBeNull();

    expect(channelOf(contactId).status).toBe("unverified");
  });

  test("a dry-run report names nobody unless the owner asks", () => {
    provisionedUnderTheOldRule({ address: BANK, senderName: "Example Bank" });

    const quiet = formatRetirementReport(retireCorrespondenceContacts().report);
    expect(quiet).not.toContain("Example Bank");
    expect(quiet).not.toContain(BANK);

    const revealed = formatRetirementReport(
      retireCorrespondenceContacts({ reveal: true }).report,
    );
    expect(revealed).toContain("Example Bank");
  });

  test("--apply revokes the provisioned channel and deletes nothing", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    const before = {
      contacts: tableCount("contacts"),
      channels: tableCount("contact_channels"),
      arrivals: tableCount("arrivals"),
    };

    const { report, manifest } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(1);
    expect(manifest?.entries).toHaveLength(1);

    const channel = channelOf(contactId);
    expect(channel.status).toBe("revoked");
    expect(channel.revokedReason).toBe(CORRESPONDENCE_RETIRED_REASON);

    // The assertion that matters: the row and its history are still here.
    expect(tableCount("contacts")).toBe(before.contacts);
    expect(tableCount("contact_channels")).toBe(before.channels);
    expect(tableCount("arrivals")).toBe(before.arrivals);
  });

  test("a retired contact stops rendering, and only this cleanup's marker hides one", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(1);

    retireCorrespondenceContacts({ apply: true });
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(0);

    // A channel the OWNER revoked is a person they know, and still renders.
    updateChannelStatus(channelOf(contactId).id, {
      status: "revoked",
      revokedReason: "blocked them myself",
    });
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(1);
  });

  test("re-running finds nothing left to do", () => {
    provisionedUnderTheOldRule({ address: BANK, senderName: "Example Bank" });
    retireCorrespondenceContacts({ apply: true });

    const second = retireCorrespondenceContacts({ apply: true });
    expect(second.report.retired).toBe(0);
    expect(second.report.candidates).toHaveLength(0);
  });

  test("the next provisioning sweep does not resurrect them", () => {
    provisionedUnderTheOldRule({ address: BANK, senderName: "Example Bank" });
    retireCorrespondenceContacts({ apply: true });

    seedArrival({
      address: BANK,
      senderName: "Example Bank",
      title: "Another statement",
      disposition: "filed",
    });
    const report = provisionContactsFromCorrespondence();
    expect(report.created).toBe(0);
    expect(report.updated).toBe(0);
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(0);
  });

  test("but a sender who finally gets surfaced comes back", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    retireCorrespondenceContacts({ apply: true });

    // A human at the same address writes, and the gate surfaces it. The
    // verdict has been overtaken by evidence.
    seedArrival({
      address: BANK,
      senderName: "Example Bank",
      title: "About your appointment",
      disposition: "surfaced",
    });
    provisionContactsFromCorrespondence();

    expect(channelOf(contactId).status).toBe("unverified");
    expect(channelOf(contactId).revokedReason).toBeNull();
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(1);
  });
});

describe("who the cleanup refuses to touch", () => {
  test("a sender with at least one surfaced arrival is not a candidate", () => {
    provisionedUnderTheOldRule({ address: BANK, senderName: "Example Bank" });
    getDb().run(
      `UPDATE arrivals SET disposition = 'surfaced' WHERE title = 'Message 1'`,
    );

    const { report } = retireCorrespondenceContacts();
    expect(report.provisioned).toBe(1);
    expect(report.retired).toBe(0);
  });

  test("a contact with NO arrival rows is never retired", () => {
    // The direction this can go wrong in. The gate has never judged this
    // sender — a channel that predates it, an import, a pruned history — and
    // an unjudged person is not a robot.
    // No sender name, so the stored name is the humanized local part — which
    // survives the arrivals being gone. Nothing but the absence guard is left
    // standing between this contact and retirement.
    const contactId = provisionedUnderTheOldRule({
      address: "ada@example.com",
    });
    getDb().run("DELETE FROM arrivals");

    const { report } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(0);
    expect(report.skipped).toContainEqual({
      contactId,
      reason: "no arrivals — the gate has never judged this sender",
    });
    expect(channelOf(contactId).status).toBe("unverified");
  });

  test("a contact the owner renamed is left alone", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    getDb().run(
      `UPDATE contacts SET display_name = 'My bank (Ada set this up)' WHERE id = '${contactId}'`,
    );

    const { report } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(0);
    expect(report.skipped[0].reason).toContain("display name");
    expect(channelOf(contactId).status).toBe("unverified");
  });

  test("a contact the owner wrote notes on is left alone", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    getDb().run(
      `UPDATE contacts SET notes = 'Ask them about the mortgage rate' WHERE id = '${contactId}'`,
    );

    const { report } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(0);
    expect(report.skipped[0].reason).toContain("notes");
  });

  test("a contact Cue remembers a fact about is left alone", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    getSqliteFrom(getDb())
      .prepare(
        `INSERT INTO contact_memory
           (id, contact_id, statement, kind, source, confidence, created_at, last_seen_at)
         VALUES (?, ?, 'Handles the joint account', 'fact', 'told', 1.0, ?, ?)`,
      )
      .run(randomUUID(), contactId, Date.now(), Date.now());

    const { report } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(0);
    expect(report.skipped[0].reason).toContain("remembers");
  });

  test("a verified or invited channel is never ours to judge", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    getDb().run(
      `UPDATE contact_channels SET verified_at = 1, verified_via = 'challenge'
         WHERE contact_id = '${contactId}'`,
    );

    const { report } = retireCorrespondenceContacts({ apply: true });
    expect(report.retired).toBe(0);
    expect(report.skipped[0].reason).toContain("verified");
    expect(channelOf(contactId).status).toBe("unverified");
  });

  test("guardians and multi-channel people are out of scope entirely", () => {
    provisionedUnderTheOldRule({ address: BANK, senderName: "Example Bank" });

    getDb().run(
      `INSERT INTO contacts (id, display_name, created_at, updated_at, role, contact_type)
       VALUES ('owner-1', 'Owner', 1, 1, 'guardian', 'human')`,
    );
    getDb().run(
      `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at)
       VALUES ('och-1', 'owner-1', 'email', 'owner@example.com', 1, 'active', 'allow', 0, 1)`,
    );
    getDb().run(
      `INSERT INTO contacts (id, display_name, created_at, updated_at, role, contact_type)
       VALUES ('slack-1', 'Grace Hopper', 1, 1, 'contact', 'human')`,
    );
    getDb().run(
      `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at)
       VALUES ('sch-1', 'slack-1', 'slack', 'U123', 1, 'active', 'allow', 0, 1)`,
    );

    const { report } = retireCorrespondenceContacts();
    // Only the provisioned mail contact is even considered.
    expect(report.provisioned).toBe(1);
    expect(report.skipped.map((s) => s.contactId)).not.toContain("owner-1");
    expect(report.skipped.map((s) => s.contactId)).not.toContain("slack-1");
  });
});

describe("the undo", () => {
  test("--revert restores the channel exactly as it was", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    const before = channelOf(contactId);

    const { manifest } = retireCorrespondenceContacts({ apply: true });
    expect(channelOf(contactId).status).toBe("revoked");

    const dry = revertContactRetirement(manifest!);
    expect(dry.restored).toBe(1);
    expect(channelOf(contactId).status).toBe("revoked");

    const applied = revertContactRetirement(manifest!, { apply: true });
    expect(applied.restored).toBe(1);

    const after = channelOf(contactId);
    expect(after.status).toBe(before.status);
    expect(after.revokedReason).toBe(before.revokedReason);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(dedupeContactsForDisplay(listContacts(100))).toHaveLength(1);
  });

  test("the undo can only undo its own work", () => {
    const contactId = provisionedUnderTheOldRule({
      address: BANK,
      senderName: "Example Bank",
    });
    const { manifest } = retireCorrespondenceContacts({ apply: true });

    // The owner revokes it themselves after the fact, for their own reason.
    updateChannelStatus(channelOf(contactId).id, {
      status: "revoked",
      revokedReason: "blocked them myself",
    });

    const report = revertContactRetirement(manifest!, { apply: true });
    expect(report.restored).toBe(0);
    expect(report.skipped[0].reason).toContain("changed since");
    expect(channelOf(contactId).revokedReason).toBe("blocked them myself");
  });
});
