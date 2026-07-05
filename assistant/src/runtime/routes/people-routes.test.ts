/**
 * Tests for the People "relationship memory" backend:
 *   - migration 294 created contact_memory + contact_relationship,
 *   - memory CRUD (add / list / correct / forget) via the routes,
 *   - dossier assembly with a real relationship score + tier, reachability
 *     derived from channels, and an interactions timeline stitched from bound
 *     conversations,
 *   - honest empty states (unknown facts, no interactions, score 0/tier weak).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { upsertContact } from "../../contacts/contact-store.js";
import { computeRelationshipScore } from "../../contacts/contact-relationship-store.js";
import { extractContactMemoryFromConversation } from "../../contacts/contact-memory-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { ROUTES } from "./people-routes.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM contact_memory");
  getDb().run("DELETE FROM contact_relationship");
  getDb().run("DELETE FROM external_conversation_bindings");
  getDb().run("DELETE FROM assistant_inbox_conversation_state");
  getDb().run("DELETE FROM call_sessions");
  getDb().run("DELETE FROM conversations");
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
});

function route(endpoint: string, method: string) {
  const found = ROUTES.find(
    (r) => r.endpoint === endpoint && r.method === method,
  );
  if (!found) throw new Error(`route not found: ${method} ${endpoint}`);
  return found;
}

function makeContact(overrides?: {
  displayName?: string;
  channels?: Parameters<typeof upsertContact>[0]["channels"];
}) {
  return upsertContact({
    displayName: overrides?.displayName ?? "Ada Lovelace",
    channels: overrides?.channels,
  });
}

// ── Migration ────────────────────────────────────────────────────────────

describe("migration 294", () => {
  test("created contact_memory and contact_relationship tables", () => {
    const rows = getDb()
      .all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact_memory','contact_relationship')`,
      ) as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["contact_memory", "contact_relationship"]);
  });
});

// ── Memory CRUD ──────────────────────────────────────────────────────────

describe("contact memory CRUD", () => {
  test("add → list → correct → forget round-trips real data", () => {
    const contact = makeContact();

    const added = route("contacts/:id/memory", "POST").handler({
      pathParams: { id: contact.id },
      body: { statement: "Prefers async updates", kind: "preference" },
      headers: {},
    }) as { ok: boolean; memory: { id: string; source: string; kind: string } };
    expect(added.ok).toBe(true);
    expect(added.memory.source).toBe("told");
    expect(added.memory.kind).toBe("preference");

    const listed = route("contacts/:id/memory", "GET").handler({
      pathParams: { id: contact.id },
      headers: {},
    }) as { memory: Array<{ id: string; statement: string }> };
    expect(listed.memory).toHaveLength(1);
    expect(listed.memory[0].statement).toBe("Prefers async updates");

    const corrected = route("contacts/:id/memory/:mid", "PATCH").handler({
      pathParams: { id: contact.id, mid: added.memory.id },
      body: { statement: "Prefers async written updates" },
      headers: {},
    }) as { memory: { statement: string } };
    expect(corrected.memory.statement).toBe("Prefers async written updates");

    const forgotten = route("contacts/:id/memory/:mid", "DELETE").handler({
      pathParams: { id: contact.id, mid: added.memory.id },
      headers: {},
    }) as { ok: boolean };
    expect(forgotten.ok).toBe(true);

    const afterForget = route("contacts/:id/memory", "GET").handler({
      pathParams: { id: contact.id },
      headers: {},
    }) as { memory: unknown[] };
    expect(afterForget.memory).toHaveLength(0);
  });

  test("rejects empty statement and unknown contact", () => {
    const contact = makeContact();
    expect(() =>
      route("contacts/:id/memory", "POST").handler({
        pathParams: { id: contact.id },
        body: { statement: "   " },
        headers: {},
      }),
    ).toThrow();
    expect(() =>
      route("contacts/:id/memory", "GET").handler({
        pathParams: { id: "does-not-exist" },
        headers: {},
      }),
    ).toThrow();
  });

  test("adding the same fact twice de-dupes (no duplicate rows)", () => {
    const contact = makeContact();
    const body = { statement: "Based in Berlin" };
    route("contacts/:id/memory", "POST").handler({
      pathParams: { id: contact.id },
      body,
      headers: {},
    });
    route("contacts/:id/memory", "POST").handler({
      pathParams: { id: contact.id },
      body,
      headers: {},
    });
    const listed = route("contacts/:id/memory", "GET").handler({
      pathParams: { id: contact.id },
      headers: {},
    }) as { memory: unknown[] };
    expect(listed.memory).toHaveLength(1);
  });
});

// ── Score derivation ─────────────────────────────────────────────────────

describe("relationship score derivation", () => {
  test("no interactions, no verified channel → 0 / weak", () => {
    expect(
      computeRelationshipScore({
        interactionCount: 0,
        lastInteractionAt: null,
        bestStatus: null,
      }),
    ).toBe(0);
  });

  test("recent + high volume + active channel → strong", () => {
    const now = Date.now();
    const score = computeRelationshipScore(
      {
        interactionCount: 60,
        lastInteractionAt: now, // interacted just now
        bestStatus: "active",
      },
      now,
    );
    // 45 (recency) + ~35 (volume saturated) + 20 (active) ≈ 100
    expect(score).toBeGreaterThanOrEqual(90);
  });

  test("stale interaction decays recency toward 0", () => {
    const now = Date.now();
    const ninetyDaysAgo = now - 91 * 24 * 60 * 60 * 1000;
    const score = computeRelationshipScore(
      {
        interactionCount: 3,
        lastInteractionAt: ninetyDaysAgo,
        bestStatus: "unverified",
      },
      now,
    );
    // recency = 0, trust = 0, only a little volume
    expect(score).toBeLessThan(20);
  });
});

// ── Dossier assembly ─────────────────────────────────────────────────────

describe("dossier assembly", () => {
  test("assembles relationship + reachability + interactions from real data", () => {
    const now = Date.now();
    const contact = makeContact({
      channels: [
        {
          type: "slack",
          address: "U123",
          externalUserId: "U123",
          externalChatId: "C-DM-1",
          status: "active",
          isPrimary: true,
        },
      ],
    });

    // Give the channel interaction stats so the score is non-trivial.
    getDb().run(
      `UPDATE contact_channels SET interaction_count = 12, last_interaction = ${now}, last_seen_at = ${now} WHERE contact_id = '${contact.id}'`,
    );

    // A bound conversation (interaction timeline source).
    getDb().run(
      `INSERT INTO conversations (id, title, created_at, updated_at, last_message_at) VALUES ('conv-1', 'Slack thread', ${now - 1000}, ${now}, ${now})`,
    );
    getDb().run(
      `INSERT INTO external_conversation_bindings (conversation_id, source_channel, external_chat_id, created_at, updated_at, last_inbound_at) VALUES ('conv-1', 'slack', 'C-DM-1', ${now - 1000}, ${now}, ${now})`,
    );

    // A remembered fact.
    route("contacts/:id/memory", "POST").handler({
      pathParams: { id: contact.id },
      body: { statement: "Leads the platform team" },
      headers: {},
    });

    const result = route("contacts/:id/dossier", "GET").handler({
      pathParams: { id: contact.id },
      headers: {},
    }) as {
      dossier: {
        relationship: { score: number; tier: string; interactionCount: number };
        memory: unknown[];
        reachability: Array<{ type: string; reachable: boolean }>;
        interactions: Array<{ conversationId: string; channel: string }>;
      };
    };

    expect(result.dossier.relationship.score).toBeGreaterThan(0);
    expect(result.dossier.relationship.interactionCount).toBe(12);
    expect(result.dossier.memory).toHaveLength(1);
    expect(result.dossier.reachability).toHaveLength(1);
    expect(result.dossier.reachability[0]).toMatchObject({
      type: "slack",
      reachable: true,
    });
    expect(result.dossier.interactions).toHaveLength(1);
    expect(result.dossier.interactions[0]).toMatchObject({
      conversationId: "conv-1",
      channel: "slack",
    });
  });

  test("honest empty state: brand-new contact with no data", () => {
    const contact = makeContact({ displayName: "Stranger" });
    const result = route("contacts/:id/dossier", "GET").handler({
      pathParams: { id: contact.id },
      headers: {},
    }) as {
      dossier: {
        relationship: { score: number; tier: string };
        memory: unknown[];
        reachability: unknown[];
        interactions: unknown[];
      };
    };
    expect(result.dossier.relationship.score).toBe(0);
    expect(result.dossier.relationship.tier).toBe("weak");
    expect(result.dossier.memory).toEqual([]);
    expect(result.dossier.reachability).toEqual([]);
    expect(result.dossier.interactions).toEqual([]);
  });

  test("404 for unknown contact", () => {
    expect(() =>
      route("contacts/:id/dossier", "GET").handler({
        pathParams: { id: "nope" },
        headers: {},
      }),
    ).toThrow();
  });
});

// ── Auto-extraction stub ─────────────────────────────────────────────────

describe("conversation extraction (stubbed)", () => {
  test("no-op by default (never fabricates facts)", () => {
    const contact = makeContact();
    const out = extractContactMemoryFromConversation({
      contactId: contact.id,
      conversationId: "conv-x",
    });
    expect(out).toEqual([]);
  });

  test("persists facts when handed pre-extracted ones (ready-to-wire path)", () => {
    const contact = makeContact();
    const out = extractContactMemoryFromConversation({
      contactId: contact.id,
      conversationId: "conv-x",
      facts: [{ statement: "Mentioned moving to NYC", kind: "context" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("from_conversation");
    expect(out[0].sourceRef).toBe("conv-x");
  });
});
