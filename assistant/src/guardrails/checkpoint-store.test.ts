/**
 * Tests for the guardrail checkpoint registry: the migration (agents.model
 * column + guardrail_checkpoints table + default seed and its idempotency),
 * CRUD, and the honest enforced/declarative classification.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { migrateGuardrails } from "../memory/migrations/299-guardrails.js";
import {
  checkpointEnforcementVia,
  countCheckpoints,
  createCheckpoint,
  deleteCheckpoint,
  enforcedAutonomyClass,
  getCheckpoint,
  invalidateCheckpointCache,
  isCheckpointEnforced,
  listCheckpoints,
  listEnabledCheckpointsCached,
  updateCheckpoint,
} from "./checkpoint-store.js";

initializeDb();

/**
 * Re-run the migration body: withCrashRecovery is run-once per checkpoint
 * key, so clearing the key first exercises the DDL/seed idempotency the
 * migration must hold on a re-run (crash recovery, restored backups).
 */
function rerunMigration(): void {
  getDb().run(
    "DELETE FROM memory_checkpoints WHERE key = 'migration_guardrails_v1'",
  );
  migrateGuardrails(getDb());
}

beforeEach(() => {
  getDb().run("DELETE FROM guardrail_checkpoints");
  invalidateCheckpointCache();
});

describe("migration 299", () => {
  test("creates the guardrail_checkpoints table and the agents.model column", () => {
    const raw = getSqliteFrom(getDb());
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='guardrail_checkpoints'`,
      )
      .all() as Array<{ name: string }>;
    expect(table.map((r) => r.name)).toEqual(["guardrail_checkpoints"]);

    const agentColumns = raw.query(`PRAGMA table_info(agents)`).all() as Array<{
      name: string;
    }>;
    expect(agentColumns.some((c) => c.name === "model")).toBe(true);
  });

  test("seeds the four default checkpoints on an empty table", () => {
    rerunMigration();
    const checkpoints = listCheckpoints();
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.map((c) => c.template).sort()).toEqual([
      "delete",
      "publish",
      "send_message",
      "spend_over",
    ]);
    for (const c of checkpoints) {
      expect(c.enabled).toBe(1);
      expect(c.isDefault).toBe(1);
      expect(c.scope).toBe("everywhere");
    }
    const spend = checkpoints.find((c) => c.template === "spend_over")!;
    expect(spend.thresholdCents).toBe(1000);
  });

  test("re-running is idempotent and never resurrects a deleted default", () => {
    rerunMigration();
    expect(countCheckpoints()).toBe(4);

    // Re-run on a populated table: no duplicates.
    rerunMigration();
    expect(countCheckpoints()).toBe(4);

    // Delete one default, re-run: it stays deleted (seed is empty-table-only).
    deleteCheckpoint("default-publish");
    rerunMigration();
    expect(countCheckpoints()).toBe(3);
    expect(getCheckpoint("default-publish")).toBeUndefined();
  });
});

describe("checkpoint CRUD", () => {
  test("createCheckpoint compiles the pattern from the template", () => {
    const cp = createCheckpoint({
      template: "send_message",
      label: "Sending anything",
    });
    expect(cp.pattern).toBe("autonomy:send");
    expect(cp.enabled).toBe(1);
    expect(cp.isDefault).toBe(0);
    expect(getCheckpoint(cp.id)?.label).toBe("Sending anything");
  });

  test("custom template requires an explicit pattern", () => {
    expect(() =>
      createCheckpoint({ template: "custom", label: "My rule" }),
    ).toThrow(/pattern/);
    const cp = createCheckpoint({
      template: "custom",
      label: "My rule",
      pattern: "tool:my_tool_*",
    });
    expect(cp.pattern).toBe("tool:my_tool_*");
  });

  test("scope is validated on create and update", () => {
    expect(() =>
      createCheckpoint({
        template: "delete",
        label: "No deletes",
        scope: "bogus-scope",
      }),
    ).toThrow(/invalid scope/);

    const cp = createCheckpoint({
      template: "delete",
      label: "No deletes",
      scope: "agent:growth",
    });
    expect(cp.scope).toBe("agent:growth");
    expect(() => updateCheckpoint(cp.id, { scope: "nonsense" })).toThrow(
      /invalid scope/,
    );
    const updated = updateCheckpoint(cp.id, { scope: "mission:m1" });
    expect(updated?.scope).toBe("mission:m1");
  });

  test("updateCheckpoint patches only the provided fields", () => {
    const cp = createCheckpoint({
      template: "spend_over",
      label: "Over $10",
      thresholdCents: 1000,
    });
    const updated = updateCheckpoint(cp.id, {
      enabled: 0,
      thresholdCents: 2500,
    });
    expect(updated?.enabled).toBe(0);
    expect(updated?.thresholdCents).toBe(2500);
    expect(updated?.label).toBe("Over $10");
    expect(updated?.pattern).toBe("autonomy:money");
  });

  test("deleteCheckpoint hard-deletes", () => {
    const cp = createCheckpoint({ template: "publish", label: "Publishing" });
    deleteCheckpoint(cp.id);
    expect(getCheckpoint(cp.id)).toBeUndefined();
    expect(countCheckpoints()).toBe(0);
  });
});

describe("enforced vs declarative classification", () => {
  test("autonomy:<class> patterns are enforced; unknown forms are declarative", () => {
    expect(enforcedAutonomyClass("autonomy:send")).toBe("send");
    expect(enforcedAutonomyClass("autonomy:money")).toBe("money");
    expect(enforcedAutonomyClass("autonomy:delete")).toBe("delete");
    expect(enforcedAutonomyClass("autonomy:publish")).toBe("publish");
    expect(enforcedAutonomyClass("autonomy:contact")).toBe("contact");
    expect(enforcedAutonomyClass("autonomy:bogus")).toBeNull();
    expect(enforcedAutonomyClass("tool:my_tool_*")).toBeNull();

    expect(isCheckpointEnforced({ pattern: "autonomy:send" })).toBe(true);
    expect(isCheckpointEnforced({ pattern: "tool:my_tool_*" })).toBe(false);
    expect(checkpointEnforcementVia({ pattern: "autonomy:delete" })).toContain(
      "'delete'",
    );
    expect(checkpointEnforcementVia({ pattern: "tool:my_tool_*" })).toBeNull();
  });

  test("legacy compiled patterns alias to publish/contact (rows keep working)", () => {
    expect(enforcedAutonomyClass("tool:publish_*")).toBe("publish");
    expect(enforcedAutonomyClass("contact:*")).toBe("contact");
    expect(isCheckpointEnforced({ pattern: "tool:publish_*" })).toBe(true);
    expect(isCheckpointEnforced({ pattern: "contact:*" })).toBe(true);
  });

  test("publish/contact enforcedVia is honest about granularity", () => {
    const publishVia = checkpointEnforcementVia({
      pattern: "autonomy:publish",
    });
    expect(publishVia).toContain("publish/unpublish/deploy");
    // Legacy pattern gets the same honest text.
    expect(checkpointEnforcementVia({ pattern: "tool:publish_*" })).toBe(
      publishVia,
    );

    const contactVia = checkpointEnforcementVia({
      pattern: "autonomy:contact",
    });
    expect(contactVia).toContain("ALL message/email sends");
    expect(contactVia).toContain("NEW contacts");
    expect(checkpointEnforcementVia({ pattern: "contact:*" })).toBe(contactVia);
  });

  test("publish and contact templates compile to enforced autonomy patterns", () => {
    const publish = createCheckpoint({
      template: "publish",
      label: "Publishing anything",
    });
    expect(publish.pattern).toBe("autonomy:publish");
    expect(isCheckpointEnforced(publish)).toBe(true);

    const contact = createCheckpoint({
      template: "contact",
      label: "Contacting someone new",
    });
    expect(contact.pattern).toBe("autonomy:contact");
    expect(isCheckpointEnforced(contact)).toBe(true);
  });

  test("all four seeded defaults are enforced (publish via the legacy alias)", () => {
    rerunMigration();
    const byTemplate = new Map(listCheckpoints().map((c) => [c.template, c]));
    expect(isCheckpointEnforced(byTemplate.get("send_message")!)).toBe(true);
    expect(isCheckpointEnforced(byTemplate.get("spend_over")!)).toBe(true);
    expect(isCheckpointEnforced(byTemplate.get("delete")!)).toBe(true);
    // The 299 seed writes the legacy "tool:publish_*" pattern; the alias
    // makes the row enforced without a data migration.
    expect(byTemplate.get("publish")!.pattern).toBe("tool:publish_*");
    expect(isCheckpointEnforced(byTemplate.get("publish")!)).toBe(true);
    expect(enforcedAutonomyClass(byTemplate.get("publish")!.pattern)).toBe(
      "publish",
    );
  });
});

describe("enabled-checkpoint cache", () => {
  test("mutations invalidate the cache immediately", () => {
    const cp = createCheckpoint({ template: "send_message", label: "Send" });
    expect(listEnabledCheckpointsCached().map((c) => c.id)).toContain(cp.id);

    updateCheckpoint(cp.id, { enabled: 0 });
    expect(listEnabledCheckpointsCached().map((c) => c.id)).not.toContain(
      cp.id,
    );

    updateCheckpoint(cp.id, { enabled: 1 });
    expect(listEnabledCheckpointsCached().map((c) => c.id)).toContain(cp.id);

    deleteCheckpoint(cp.id);
    expect(listEnabledCheckpointsCached()).toHaveLength(0);
  });
});
