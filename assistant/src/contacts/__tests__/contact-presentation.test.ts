/**
 * Tests for the contact presentation layer (Memory "People" rail cleanup):
 *   - duplicate person rows (same normalized display name) collapse into one
 *     card with channels / notes / interaction stats merged,
 *   - degenerate note bodies (body === role, one-word bodies) are stripped,
 *   - stored data shapes are untouched (pure, order-preserving, no mutation).
 *
 * Mirrors the prod bug: a "Manav" guardian row whose notes were literally
 * "guardian" plus a second bare "Manav" contact row → two degenerate cards.
 */
import { describe, expect, test } from "bun:test";

import {
  dedupeContactsForDisplay,
  isDegenerateNotes,
  normalizeDisplayName,
} from "../contact-presentation.js";
import type { ContactChannel, ContactWithChannels } from "../types.js";

let nextId = 0;

function makeChannel(overrides: Partial<ContactChannel> = {}): ContactChannel {
  nextId += 1;
  return {
    id: `ch-${nextId}`,
    contactId: "c-1",
    type: "slack",
    address: `U${nextId}`,
    isPrimary: false,
    externalUserId: null,
    externalChatId: null,
    status: "active",
    policy: "allow",
    verifiedAt: null,
    verifiedVia: null,
    inviteId: null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    interactionCount: 0,
    lastInteraction: null,
    updatedAt: null,
    createdAt: 1000,
    ...overrides,
  };
}

function makeContact(
  overrides: Partial<ContactWithChannels> = {},
): ContactWithChannels {
  nextId += 1;
  return {
    id: `c-${nextId}`,
    displayName: "Ada Lovelace",
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    role: "contact",
    contactType: "human",
    principalId: null,
    userFile: null,
    channels: [],
    ...overrides,
  };
}

// ── normalizeDisplayName ─────────────────────────────────────────────────

describe("normalizeDisplayName", () => {
  test("is case-insensitive and whitespace-insensitive", () => {
    expect(normalizeDisplayName("  Manav ")).toBe("manav");
    expect(normalizeDisplayName("Ada   Lovelace")).toBe("ada lovelace");
    expect(normalizeDisplayName("ADA\tLovelace")).toBe("ada lovelace");
  });

  test("empty and whitespace-only names normalize to empty", () => {
    expect(normalizeDisplayName("")).toBe("");
    expect(normalizeDisplayName("   ")).toBe("");
  });
});

// ── isDegenerateNotes ────────────────────────────────────────────────────

describe("isDegenerateNotes", () => {
  const guardian = { role: "guardian", contactType: "human" } as const;

  test("null / empty / whitespace notes are degenerate", () => {
    expect(isDegenerateNotes(null, guardian)).toBe(true);
    expect(isDegenerateNotes(undefined, guardian)).toBe(true);
    expect(isDegenerateNotes("", guardian)).toBe(true);
    expect(isDegenerateNotes("   ", guardian)).toBe(true);
  });

  test("body equal to the role is degenerate (the prod 'guardian' card)", () => {
    expect(isDegenerateNotes("guardian", guardian)).toBe(true);
    expect(isDegenerateNotes("  Guardian  ", guardian)).toBe(true);
  });

  test("body equal to the contact type is degenerate", () => {
    expect(isDegenerateNotes("human", guardian)).toBe(true);
    expect(
      isDegenerateNotes("assistant", {
        role: "contact",
        contactType: "assistant",
      }),
    ).toBe(true);
  });

  test("any single-word body is degenerate", () => {
    expect(isDegenerateNotes("ceo", guardian)).toBe(true);
    expect(isDegenerateNotes("colleague", guardian)).toBe(true);
  });

  test("real sentences are not degenerate", () => {
    expect(
      isDegenerateNotes("Prefers async updates over calls", guardian),
    ).toBe(false);
    expect(isDegenerateNotes("CEO at Brinc", guardian)).toBe(false);
  });
});

// ── dedupeContactsForDisplay ─────────────────────────────────────────────

describe("dedupeContactsForDisplay", () => {
  test("collapses the prod duplicate: guardian 'Manav' + bare 'Manav' → one card", () => {
    const guardianChannels = [
      makeChannel({ type: "vellum", address: "vellum-principal-x" }),
      makeChannel({
        type: "slack",
        address: "U01HKM43VRB",
        interactionCount: 1,
        lastInteraction: 1781961091425,
      }),
    ];
    const guardian = makeContact({
      id: "dd5a393f",
      displayName: "Manav",
      role: "guardian",
      notes: "guardian", // the degenerate body seen in prod
      principalId: "vellum-principal-x",
      createdAt: 1781399644381,
      updatedAt: 1782135653849,
      interactionCount: 1,
      lastInteraction: 1781961091425,
      channels: guardianChannels,
    });
    const duplicate = makeContact({
      id: "67a91a8d",
      displayName: "Manav",
      role: "contact",
      notes: null,
      createdAt: 1781961006878,
      updatedAt: 1781961006878,
      channels: [],
    });

    const result = dedupeContactsForDisplay([guardian, duplicate]);

    expect(result).toHaveLength(1);
    const merged = result[0];
    expect(merged.id).toBe("dd5a393f"); // guardian row is canonical
    expect(merged.role).toBe("guardian");
    expect(merged.displayName).toBe("Manav");
    expect(merged.notes).toBeNull(); // "guardian" body stripped
    expect(merged.channels).toHaveLength(2);
    expect(merged.interactionCount).toBe(1);
    expect(merged.lastInteraction).toBe(1781961091425);
  });

  test("merges facts (notes) from duplicates, dropping degenerate ones", () => {
    const a = makeContact({
      displayName: "Ada Lovelace",
      notes: "guardian", // degenerate, dropped
      role: "guardian",
    });
    const b = makeContact({
      displayName: "ada lovelace",
      notes: "Prefers async updates over calls",
    });
    const c = makeContact({
      displayName: "  Ada   Lovelace ",
      notes: "Works on the analytical engine",
    });

    const result = dedupeContactsForDisplay([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0].notes).toBe(
      "Prefers async updates over calls\nWorks on the analytical engine",
    );
    expect(result[0].role).toBe("guardian");
  });

  test("dedupes merged notes that repeat across duplicates", () => {
    const a = makeContact({
      displayName: "Grace",
      notes: "Invented the compiler idea",
    });
    const b = makeContact({
      displayName: "grace",
      notes: "Invented the compiler idea",
    });
    const result = dedupeContactsForDisplay([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].notes).toBe("Invented the compiler idea");
  });

  test("canonical row without a guardian: prefers most channels, then oldest", () => {
    const rich = makeContact({
      id: "rich",
      displayName: "Sam",
      createdAt: 2000,
      channels: [makeChannel(), makeChannel()],
    });
    const poor = makeContact({
      id: "poor",
      displayName: "Sam",
      createdAt: 1000,
      channels: [makeChannel()],
    });
    expect(dedupeContactsForDisplay([poor, rich])[0].id).toBe("rich");

    const old = makeContact({ id: "old", displayName: "Kim", createdAt: 500 });
    const young = makeContact({
      id: "young",
      displayName: "Kim",
      createdAt: 900,
    });
    expect(dedupeContactsForDisplay([young, old])[0].id).toBe("old");
  });

  test("merged channels are unique by id and interaction stats recomputed", () => {
    const shared = makeChannel({
      id: "shared-ch",
      interactionCount: 3,
      lastInteraction: 5000,
    });
    const a = makeContact({
      displayName: "Lin",
      channels: [
        shared,
        makeChannel({ interactionCount: 2, lastInteraction: 7000 }),
      ],
    });
    const b = makeContact({
      displayName: "Lin",
      channels: [
        shared,
        makeChannel({ interactionCount: 4, lastInteraction: 1000 }),
      ],
    });

    const [merged] = dedupeContactsForDisplay([a, b]);
    expect(merged.channels).toHaveLength(3);
    expect(merged.interactionCount).toBe(9);
    expect(merged.lastInteraction).toBe(7000);
  });

  test("distinct people are untouched and order is preserved", () => {
    const a = makeContact({ id: "a", displayName: "Ada" });
    const b = makeContact({ id: "b", displayName: "Grace" });
    const a2 = makeContact({ id: "a2", displayName: "ada" });
    const c = makeContact({ id: "c", displayName: "Margaret" });

    const result = dedupeContactsForDisplay([a, b, a2, c]);
    expect(result.map((r) => r.displayName)).toEqual([
      "Ada",
      "Grace",
      "Margaret",
    ]);
  });

  test("strips degenerate notes on singletons too", () => {
    const solo = makeContact({ displayName: "Ravi", notes: "colleague" });
    const [cleaned] = dedupeContactsForDisplay([solo]);
    expect(cleaned.notes).toBeNull();

    const real = makeContact({
      displayName: "Ravi2",
      notes: "Runs the Fly infra for Cue",
    });
    expect(dedupeContactsForDisplay([real])[0].notes).toBe(
      "Runs the Fly infra for Cue",
    );
  });

  test("nameless rows pass through without merging with each other", () => {
    const a = makeContact({ id: "n1", displayName: "" });
    const b = makeContact({ id: "n2", displayName: "  " });
    const result = dedupeContactsForDisplay([a, b]);
    expect(result.map((r) => r.id)).toEqual(["n1", "n2"]);
  });

  test("does not mutate its inputs (presentation only)", () => {
    const guardian = makeContact({
      displayName: "Manav",
      role: "guardian",
      notes: "guardian",
      channels: [makeChannel()],
    });
    const dupe = makeContact({ displayName: "Manav" });
    const snapshotNotes = guardian.notes;
    const snapshotChannels = guardian.channels.length;

    dedupeContactsForDisplay([guardian, dupe]);

    expect(guardian.notes).toBe(snapshotNotes as string);
    expect(guardian.channels).toHaveLength(snapshotChannels);
    expect(dupe.notes).toBeNull();
  });
});
