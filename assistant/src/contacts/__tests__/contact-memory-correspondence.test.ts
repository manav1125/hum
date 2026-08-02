/**
 * The bug this file exists for: contact-memory extraction completed 697 times
 * in production and wrote ZERO rows. Every existing test asserted the pass
 * behaved correctly for a Slack-bound conversation — which it did — and no
 * test asserted that anything was ever WRITTEN for the substrate the owner
 * actually has, which is mail.
 *
 * So every assertion here is about rows in `contacts`, `contact_channels` and
 * `contact_memory` after the REAL job handler ran, reached through the real
 * worker dispatch (`enqueueMemoryJob` → `runMemoryJobsOnce`) rather than by
 * calling an extracted helper. A completed job is never the assertion.
 *
 * Fixtures use example.com addresses and invented names.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Deterministic flash output. Tests set `mockSidechainText` before invoking.
// Every factory below spreads the real module and overrides only the seam it
// drives — see assistant/AGENTS.md on exhaustive mock.module factories.
let mockSidechainText = "[]";
let sidechainCalls = 0;

const realProviderSend =
  await import("../../providers/provider-send-message.js");
mock.module("../../providers/provider-send-message.js", () => ({
  ...realProviderSend,
  getConfiguredProvider: async () => ({}),
}));

const realResolver = await import("../../config/llm-resolver.js");
mock.module("../../config/llm-resolver.js", () => ({
  ...realResolver,
  resolveCallSiteConfig: () => ({ provider: "mock", maxTokens: 256 }),
}));

const realSidechain = await import("../../runtime/btw-sidechain.js");
mock.module("../../runtime/btw-sidechain.js", () => ({
  ...realSidechain,
  runBtwSidechain: async () => {
    sidechainCalls++;
    return { text: mockSidechainText, hadTextDeltas: true, response: {} };
  },
}));

import { randomUUID } from "node:crypto";

import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { runMemoryJobsOnce } from "../../memory/jobs-worker.js";
import { listCorrespondents } from "../contact-correspondence.js";
import {
  getContactMemoryHealth,
  resetContactMemoryHealth,
  runContactMemorySweep,
  UNPRODUCTIVE_SWEEP_WARN_AT,
} from "../contact-memory-extract-job.js";
import { provisionContactsFromCorrespondence } from "../contact-provisioning.js";
import { findContactByAddress } from "../contact-store.js";

initializeDb();

/** Seed one arrival exactly as the watcher intake writes them. */
function seedArrival(opts: {
  address: string;
  senderName?: string | null;
  title: string;
  snippet?: string | null;
  createdAt?: number;
}): void {
  const now = opts.createdAt ?? Date.now();
  getSqliteFrom(getDb())
    .prepare(
      `INSERT INTO arrivals
         (id, channel, external_id, title, sender_address, sender_name, snippet,
          disposition, decided_by, created_at, updated_at)
       VALUES (?, 'watcher:gmail', ?, ?, ?, ?, ?, 'surfaced', 'rule', ?, ?)`,
    )
    .run(
      randomUUID(),
      randomUUID(),
      opts.title,
      opts.address.toLowerCase(),
      opts.senderName ?? null,
      opts.snippet ?? null,
      now,
      now,
    );
}

function contactMemoryRows(): Array<{ statement: string; source_ref: string }> {
  return getDb().all(
    "SELECT statement, source_ref FROM contact_memory",
  ) as Array<{ statement: string; source_ref: string }>;
}

beforeEach(() => {
  mockSidechainText = "[]";
  sidechainCalls = 0;
  delete process.env.CUE_DISABLE_CONTACT_MEMORY;
  resetContactMemoryHealth();
  getDb().run("DELETE FROM contact_memory");
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
  getDb().run("DELETE FROM arrivals");
  getDb().run("DELETE FROM memory_jobs");
  getDb().run(
    "DELETE FROM memory_checkpoints WHERE key LIKE 'contact_memory%'",
  );
});

// ── Reading the substrate ──────────────────────────────────────────────────

describe("listCorrespondents", () => {
  test("aggregates real senders and excludes structural bulk addresses", () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Re: the Tuesday session",
    });
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "One more thing",
    });
    seedArrival({
      address: "noreply@example.com",
      senderName: "Example Updates",
      title: "Your weekly digest",
    });

    const people = listCorrespondents();
    expect(people).toHaveLength(1);
    expect(people[0].address).toBe("ada@example.com");
    expect(people[0].displayName).toBe("Ada Byron");
    expect(people[0].messageCount).toBe(2);
  });

  test("falls back to a humanized local part when no name was ever sent", () => {
    seedArrival({ address: "grace.hopper@example.com", title: "Hello" });
    const people = listCorrespondents();
    expect(people[0].displayName).toBe("Grace Hopper");
  });

  test("never offers the owner's own address as a correspondent", () => {
    getDb().run(
      `INSERT INTO contacts (id, display_name, created_at, updated_at, role, contact_type)
       VALUES ('owner-1', 'Owner', 1, 1, 'guardian', 'human')`,
    );
    getDb().run(
      `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at)
       VALUES ('och-1', 'owner-1', 'email', 'owner@example.com', 1, 'active', 'allow', 0, 1)`,
    );
    seedArrival({ address: "owner@example.com", title: "Note to self" });
    seedArrival({ address: "ada@example.com", title: "Hello" });

    const addresses = listCorrespondents().map((p) => p.address);
    expect(addresses).toEqual(["ada@example.com"]);
  });
});

// ── Provisioning writes people ─────────────────────────────────────────────

describe("provisionContactsFromCorrespondence", () => {
  test("writes a contact and an email channel per correspondent", () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Hello",
    });

    const report = provisionContactsFromCorrespondence();
    expect(report.created).toBe(1);

    const contact = findContactByAddress("email", "ada@example.com");
    expect(contact).not.toBeNull();
    expect(contact?.displayName).toBe("Ada Byron");
    const channel = contact?.channels.find((c) => c.type === "email");
    expect(channel?.address).toBe("ada@example.com");
    // Knowing who somebody is must not be the same act as letting them in.
    expect(channel?.status).toBe("unverified");
    expect(channel?.policy).toBe("escalate");
  });

  test("a dry run writes nothing", () => {
    seedArrival({ address: "ada@example.com", title: "Hello" });
    const report = provisionContactsFromCorrespondence({ dryRun: true });
    expect(report.created).toBe(1);
    expect(getDb().all("SELECT id FROM contacts")).toHaveLength(0);
  });

  test("re-running does not duplicate or rename an existing person", () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Hello",
    });
    provisionContactsFromCorrespondence();

    // The owner curates the name, then more mail arrives with the old one.
    const contact = findContactByAddress("email", "ada@example.com")!;
    getSqliteFrom(getDb())
      .prepare("UPDATE contacts SET display_name = ? WHERE id = ?")
      .run("Ada (climbing)", contact.id);
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Another",
    });

    const second = provisionContactsFromCorrespondence();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(getDb().all("SELECT id FROM contacts")).toHaveLength(1);
    expect(findContactByAddress("email", "ada@example.com")?.displayName).toBe(
      "Ada (climbing)",
    );
  });
});

// ── The whole chain, through the real worker ───────────────────────────────

describe("contact_memory_sweep, driven through the job worker", () => {
  test("enqueue → dispatch → handler WRITES contact memory", async () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Re: the Tuesday session",
      snippet: "I run the analytical-engine reading group every Tuesday.",
    });
    mockSidechainText = JSON.stringify([
      {
        statement: "Runs a reading group on Tuesdays",
        kind: "context",
        confidence: 0.9,
      },
    ]);

    enqueueMemoryJob("contact_memory_sweep", {});
    await runMemoryJobsOnce();

    // The assertion that would have caught the bug: rows, not a status.
    const rows = contactMemoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].statement).toBe("Runs a reading group on Tuesdays");

    const contact = findContactByAddress("email", "ada@example.com");
    expect(rows[0].source_ref).toBe(`correspondence:${contact?.id}`);
    expect(getContactMemoryHealth().factsWritten).toBe(1);
  });

  test("a second sweep does not re-read mail that has not changed", async () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Hello",
      snippet: "Something durable.",
    });
    mockSidechainText = JSON.stringify([
      { statement: "Lives in Turin", kind: "context", confidence: 0.9 },
    ]);

    await runContactMemorySweep();
    expect(sidechainCalls).toBe(1);

    const second = await runContactMemorySweep();
    expect(sidechainCalls).toBe(1);
    expect(second.alreadyRead).toBe(1);
    expect(contactMemoryRows()).toHaveLength(1);
  });

  test("new mail from the same person is read again", async () => {
    const t0 = Date.now() - 10_000;
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Hello",
      createdAt: t0,
    });
    mockSidechainText = JSON.stringify([
      { statement: "Lives in Turin", kind: "context", confidence: 0.9 },
    ]);
    await runContactMemorySweep();

    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Moved",
      createdAt: Date.now(),
    });
    mockSidechainText = JSON.stringify([
      { statement: "Moved to Naples", kind: "context", confidence: 0.9 },
    ]);
    await runContactMemorySweep();

    expect(contactMemoryRows()).toHaveLength(2);
  });

  test("a fact is bound to the sender it came from, never to somebody else", async () => {
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Hello",
    });
    seedArrival({
      address: "grace@example.com",
      senderName: "Grace Hopper",
      title: "Hi",
    });
    mockSidechainText = JSON.stringify([
      { statement: "A durable fact", kind: "context", confidence: 0.9 },
    ]);

    await runContactMemorySweep();

    const ada = findContactByAddress("email", "ada@example.com")!;
    const grace = findContactByAddress("email", "grace@example.com")!;
    const rows = getDb().all("SELECT contact_id FROM contact_memory") as Array<{
      contact_id: string;
    }>;
    const owners = new Set(rows.map((r) => r.contact_id));
    expect(owners).toEqual(new Set([ada.id, grace.id]));
  });

  test("the kill-switch stops the sweep writing anything", async () => {
    seedArrival({ address: "ada@example.com", title: "Hello" });
    process.env.CUE_DISABLE_CONTACT_MEMORY = "1";
    mockSidechainText = JSON.stringify([
      { statement: "Should never be written", kind: "fact", confidence: 1 },
    ]);

    const result = await runContactMemorySweep();
    expect(result.outcome).toBe("disabled");
    expect(sidechainCalls).toBe(0);
    expect(contactMemoryRows()).toHaveLength(0);
    expect(getDb().all("SELECT id FROM contacts")).toHaveLength(0);
  });
});

// ── The no-op can no longer report itself as success ───────────────────────

describe("observable health", () => {
  /** New mail each round, so every sweep genuinely reaches the extractor. */
  async function barrenSweeps(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      seedArrival({
        address: "ada@example.com",
        senderName: "Ada Byron",
        title: `Message ${i}`,
        createdAt: Date.now() + i * 1_000,
      });
      await runContactMemorySweep({ maxContacts: 1 });
    }
  }

  test("sweeps that read mail and write nothing go degraded and say why", async () => {
    // The model answers, honestly, that there is nothing durable here.
    mockSidechainText = "[]";
    await barrenSweeps(UNPRODUCTIVE_SWEEP_WARN_AT);

    const health = getContactMemoryHealth();
    expect(contactMemoryRows()).toHaveLength(0);
    expect(health.consecutiveUnproductiveSweeps).toBe(
      UNPRODUCTIVE_SWEEP_WARN_AT,
    );
    expect(health.degraded).toBe(true);
    expect(health.degradedReason).toContain("remembered nothing");
  });

  test("a productive sweep clears the degraded state", async () => {
    mockSidechainText = "[]";
    await barrenSweeps(UNPRODUCTIVE_SWEEP_WARN_AT);
    expect(getContactMemoryHealth().degraded).toBe(true);

    mockSidechainText = JSON.stringify([
      { statement: "Lives in Turin", kind: "context", confidence: 0.9 },
    ]);
    seedArrival({
      address: "ada@example.com",
      senderName: "Ada Byron",
      title: "Moved",
      createdAt: Date.now() + 60_000,
    });
    await runContactMemorySweep({ maxContacts: 1 });

    expect(contactMemoryRows()).toHaveLength(1);
    expect(getContactMemoryHealth().degraded).toBe(false);
    expect(getContactMemoryHealth().degradedReason).toBeNull();
  });
});
