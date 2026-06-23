import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  listContacts,
  reconcileGuardianContacts,
} from "../contacts/contact-store.js";
import { getDb, getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { migrateReconcileDuplicateGuardians } from "../memory/migrations/283-reconcile-duplicate-guardians.js";

initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
  sqlite.run(
    "DELETE FROM memory_checkpoints WHERE key = 'migration_reconcile_duplicate_guardians_v1'",
  );
}

function insertContact(params: {
  id: string;
  displayName: string;
  role: string;
  principalId: string | null;
  createdAt: number;
}): void {
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT INTO contacts (id, display_name, role, contact_type, principal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      params.id,
      params.displayName,
      params.role,
      "human",
      params.principalId,
      params.createdAt,
      params.createdAt,
    ],
  );
}

function insertChannel(params: {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status?: string;
}): void {
  const sqlite = getSqlite();
  const now = Date.now();
  sqlite.run(
    "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 'allow', 0, ?, ?)",
    [
      params.id,
      params.contactId,
      params.type,
      params.address,
      params.status ?? "active",
      now,
      now,
    ],
  );
}

function guardianRows(): Array<{ id: string }> {
  const sqlite = getSqlite();
  return sqlite
    .query("SELECT id FROM contacts WHERE role = 'guardian' ORDER BY id")
    .all() as Array<{ id: string }>;
}

function channelTypesFor(contactId: string): string[] {
  const sqlite = getSqlite();
  return (
    sqlite
      .query(
        "SELECT type FROM contact_channels WHERE contact_id = ? ORDER BY type",
      )
      .all(contactId) as Array<{ type: string }>
  ).map((r) => r.type);
}

describe("reconcileGuardianContacts", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("no-op when zero or one guardian", () => {
    insertContact({
      id: "g1",
      displayName: "Manav",
      role: "guardian",
      principalId: "vellum-principal-1",
      createdAt: Date.now(),
    });
    insertChannel({
      id: "ch1",
      contactId: "g1",
      type: "vellum",
      address: "vellum-principal-1",
    });

    expect(reconcileGuardianContacts()).toBe(0);
    expect(guardianRows()).toHaveLength(1);
  });

  test("merges a Slack-bound duplicate guardian into the vellum guardian", () => {
    const now = Date.now();
    // Canonical owner: vellum-bound guardian.
    insertContact({
      id: "g-vellum",
      displayName: "Manav",
      role: "guardian",
      principalId: "vellum-principal-new",
      createdAt: now - 1000,
    });
    insertChannel({
      id: "ch-vellum",
      contactId: "g-vellum",
      type: "vellum",
      address: "vellum-principal-new",
    });
    // Stranded Slack guardian on the OLD (migrated) principal.
    insertContact({
      id: "g-slack",
      displayName: "Manav",
      role: "guardian",
      principalId: "vellum-principal-old",
      createdAt: now,
    });
    insertChannel({
      id: "ch-slack",
      contactId: "g-slack",
      type: "slack",
      address: "u01hkm43vrb",
    });

    const merged = reconcileGuardianContacts();
    expect(merged).toBe(1);

    // Exactly one guardian remains, and it is the vellum-bound canonical one.
    const guardians = guardianRows();
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.id).toBe("g-vellum");

    // Both channel bindings now live under the single guardian.
    expect(channelTypesFor("g-vellum")).toEqual(["slack", "vellum"]);
  });

  test("picks the vellum-bound guardian even when it is the newer row", () => {
    const now = Date.now();
    insertContact({
      id: "g-slack",
      displayName: "Manav",
      role: "guardian",
      principalId: "p-old",
      createdAt: now - 5000,
    });
    insertChannel({
      id: "ch-slack",
      contactId: "g-slack",
      type: "slack",
      address: "uslack",
    });
    insertContact({
      id: "g-vellum",
      displayName: "Manav",
      role: "guardian",
      principalId: "p-new",
      createdAt: now,
    });
    insertChannel({
      id: "ch-vellum",
      contactId: "g-vellum",
      type: "vellum",
      address: "p-new",
    });

    reconcileGuardianContacts();

    const guardians = guardianRows();
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.id).toBe("g-vellum");
  });

  test("is idempotent", () => {
    const now = Date.now();
    insertContact({
      id: "g1",
      displayName: "Manav",
      role: "guardian",
      principalId: "p1",
      createdAt: now - 1,
    });
    insertChannel({ id: "c1", contactId: "g1", type: "vellum", address: "p1" });
    insertContact({
      id: "g2",
      displayName: "Manav",
      role: "guardian",
      principalId: "p2",
      createdAt: now,
    });
    insertChannel({
      id: "c2",
      contactId: "g2",
      type: "telegram",
      address: "tg",
    });

    expect(reconcileGuardianContacts()).toBe(1);
    expect(reconcileGuardianContacts()).toBe(0);
    expect(guardianRows()).toHaveLength(1);
  });

  test("listContacts returns the owner exactly once after reconcile", () => {
    const now = Date.now();
    insertContact({
      id: "g1",
      displayName: "Manav",
      role: "guardian",
      principalId: "p1",
      createdAt: now - 1,
    });
    insertChannel({ id: "c1", contactId: "g1", type: "vellum", address: "p1" });
    insertContact({
      id: "g2",
      displayName: "Manav",
      role: "guardian",
      principalId: "p2",
      createdAt: now,
    });
    insertChannel({
      id: "c2",
      contactId: "g2",
      type: "slack",
      address: "uslack",
    });

    reconcileGuardianContacts();

    const all = listContacts(50);
    const guardians = all.filter((c) => c.role === "guardian");
    expect(guardians).toHaveLength(1);
  });
});

describe("migrateReconcileDuplicateGuardians", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("collapses duplicate guardians via the migration path", () => {
    const now = Date.now();
    insertContact({
      id: "g-vellum",
      displayName: "Manav",
      role: "guardian",
      principalId: "vellum-principal-new",
      createdAt: now - 1000,
    });
    insertChannel({
      id: "ch-vellum",
      contactId: "g-vellum",
      type: "vellum",
      address: "vellum-principal-new",
    });
    insertContact({
      id: "g-slack",
      displayName: "Manav",
      role: "guardian",
      principalId: "vellum-principal-old",
      createdAt: now,
    });
    insertChannel({
      id: "ch-slack",
      contactId: "g-slack",
      type: "slack",
      address: "u01hkm43vrb",
    });

    migrateReconcileDuplicateGuardians(getDb());

    const guardians = guardianRows();
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.id).toBe("g-vellum");
    expect(channelTypesFor("g-vellum")).toEqual(["slack", "vellum"]);
  });

  test("moves multiple distinct donor channels onto the survivor", () => {
    const now = Date.now();
    insertContact({
      id: "g1",
      displayName: "Manav",
      role: "guardian",
      principalId: "p1",
      createdAt: now - 1,
    });
    insertChannel({ id: "c1", contactId: "g1", type: "vellum", address: "p1" });
    insertContact({
      id: "g2",
      displayName: "Manav",
      role: "guardian",
      principalId: "p2",
      createdAt: now,
    });
    insertChannel({
      id: "c2",
      contactId: "g2",
      type: "slack",
      address: "uslack",
    });
    insertChannel({
      id: "c3",
      contactId: "g2",
      type: "telegram",
      address: "tg123",
    });

    migrateReconcileDuplicateGuardians(getDb());

    const guardians = guardianRows();
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.id).toBe("g1");
    // All three channel bindings now live under the single guardian.
    expect(channelTypesFor("g1")).toEqual(["slack", "telegram", "vellum"]);
  });

  test("migration is idempotent", () => {
    const now = Date.now();
    insertContact({
      id: "g1",
      displayName: "Manav",
      role: "guardian",
      principalId: "p1",
      createdAt: now - 1,
    });
    insertChannel({ id: "c1", contactId: "g1", type: "vellum", address: "p1" });
    insertContact({
      id: "g2",
      displayName: "Manav",
      role: "guardian",
      principalId: "p2",
      createdAt: now,
    });
    insertChannel({
      id: "c2",
      contactId: "g2",
      type: "slack",
      address: "uslack",
    });

    migrateReconcileDuplicateGuardians(getDb());
    // Clear the checkpoint so the second call actually re-executes the body.
    getSqlite().run(
      "DELETE FROM memory_checkpoints WHERE key = 'migration_reconcile_duplicate_guardians_v1'",
    );
    migrateReconcileDuplicateGuardians(getDb());

    expect(guardianRows()).toHaveLength(1);
  });
});
