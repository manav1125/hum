/**
 * The agent-facing playbook tools (`playbook_create` / `_list` / `_update` /
 * `_delete`).
 *
 * These used to write to `memory_graph_nodes` under a `playbook:<id>` source
 * marker — a store whose only reader was `compilePlaybooks()`, which had no
 * production callers. So asking Cue in chat for a playbook returned "Playbook
 * created successfully" and produced a row nothing evaluated and no surface
 * displayed. The tools now speak to the same `playbooks` table the runtime
 * fires from and the Automations board renders, and the last describe block
 * here is the regression guard for exactly that: a tool-created rule must be
 * visible to `listMatchablePlaybooks`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const actualJobsStore = await import("../memory/jobs-store.js");
mock.module("../memory/jobs-store.js", () => ({
  ...actualJobsStore,
  enqueueMemoryJob: () => {},
}));

import type { Database } from "bun:sqlite";

import { executePlaybookCreate } from "../config/bundled-skills/playbooks/tools/playbook-create.js";
import { executePlaybookDelete } from "../config/bundled-skills/playbooks/tools/playbook-delete.js";
import { executePlaybookList } from "../config/bundled-skills/playbooks/tools/playbook-list.js";
import { executePlaybookUpdate } from "../config/bundled-skills/playbooks/tools/playbook-update.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { updateCompanyProfile } from "../missions/mission-store.js";
import {
  getPlaybook,
  listMatchablePlaybooks,
} from "../playbooks/playbook-store.js";
import type { ToolContext } from "../tools/types.js";

initializeDb();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

function clearPlaybooks(): void {
  getRawDb().run("DELETE FROM playbooks");
  // The dial caps the reported autonomy; pin it wide open so these tests
  // assert on what the tool stored rather than on the workspace posture.
  updateCompanyProfile({ workspaceMode: "autonomous" });
}

function extractPlaybookId(content: string): string {
  const match = content.match(/ID: (\S+)/);
  expect(match).not.toBeNull();
  return match![1];
}

// ── playbook_create ─────────────────────────────────────────────────

describe("playbook_create tool", () => {
  beforeEach(clearPlaybooks);

  test("creates a playbook with required fields", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "meeting request",
        action: "check calendar, propose 3 times",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook created successfully");
    expect(result.content).toContain("meeting request");
    expect(result.content).toContain("check calendar, propose 3 times");
    expect(result.content).toContain("Autonomy: draft for review"); // default
    expect(result.content).toContain("Channel: all channels"); // default
    expect(result.content).toContain("Priority: 0"); // default
  });

  test("names the rule after the trigger when no name is given", async () => {
    const result = await executePlaybookCreate(
      { trigger: "invoice", action: "file it" },
      ctx,
    );
    const stored = getPlaybook(extractPlaybookId(result.content));
    expect(stored?.name).toBe("invoice");
  });

  test("creates a playbook with all optional fields", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "from:ceo@*",
        action: "prioritize and draft response",
        name: "CEO mail",
        channel: "gmail",
        autonomy_level: "auto",
        priority: 10,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("from:ceo@*");
    expect(result.content).toContain("Name: CEO mail");
    expect(result.content).toContain("Channel: gmail");
    expect(result.content).toContain("Autonomy: execute automatically");
    expect(result.content).toContain("Priority: 10");
  });

  test("stores a friendly channel in the form the matcher compares against", async () => {
    // "email" reads fine and can never fire — watcher events arrive on
    // `watcher:gmail`. The tool normalises rather than storing it verbatim.
    const result = await executePlaybookCreate(
      { trigger: "receipt", action: "file it", channel: "email" },
      ctx,
    );
    const stored = getPlaybook(extractPlaybookId(result.content));
    expect(stored?.channel).toBe("watcher:gmail");
  });

  test("creates with notify autonomy level", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "newsletter",
        action: "archive",
        autonomy_level: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: notify only");
  });

  test("reports the capped autonomy, not the requested one", async () => {
    updateCompanyProfile({ workspaceMode: "observe" });

    const result = await executePlaybookCreate(
      { trigger: "anything", action: "act on it", autonomy_level: "auto" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: notify only");
    expect(result.content).toContain("global trust dial (observe)");
    // The stored value keeps what was asked for; only the report is clamped.
    expect(getPlaybook(extractPlaybookId(result.content))?.autonomyLevel).toBe(
      "auto",
    );
  });

  test("defaults an invalid autonomy_level to draft", async () => {
    const result = await executePlaybookCreate(
      { trigger: "test", action: "test", autonomy_level: "invalid_level" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: draft for review");
  });

  test("rejects duplicate playbook", async () => {
    await executePlaybookCreate(
      {
        trigger: "unique trigger",
        action: "unique action",
      },
      ctx,
    );

    const result = await executePlaybookCreate(
      {
        trigger: "unique trigger",
        action: "unique action",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("already exists");
  });

  test("rejects missing trigger", async () => {
    const result = await executePlaybookCreate(
      {
        action: "do something",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("trigger is required");
  });

  test("rejects missing action", async () => {
    const result = await executePlaybookCreate(
      {
        trigger: "test trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("action is required");
  });
});

// ── playbook_list ───────────────────────────────────────────────────

describe("playbook_list tool", () => {
  beforeEach(clearPlaybooks);

  test("empty state says what happens without a playbook", async () => {
    const result = await executePlaybookList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No playbooks found");
    // "nothing here" must not read as "nothing happens" — hits still land.
    expect(result.content).toContain("Came In");
  });

  test("lists all playbooks", async () => {
    await executePlaybookCreate(
      {
        trigger: "meeting request",
        action: "check calendar",
      },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "newsletter",
        action: "archive it",
      },
      ctx,
    );

    const result = await executePlaybookList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Found 2 playbook(s)");
    expect(result.content).toContain("meeting request");
    expect(result.content).toContain("newsletter");
  });

  test("filters by channel", async () => {
    await executePlaybookCreate(
      {
        trigger: "email trigger",
        action: "handle email",
        channel: "gmail",
      },
      ctx,
    );
    await executePlaybookCreate(
      {
        trigger: "github trigger",
        action: "handle github",
        channel: "github",
      },
      ctx,
    );

    const result = await executePlaybookList({ channel: "gmail" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("email trigger");
    expect(result.content).not.toContain("github trigger");
  });

  test("includes wildcard channel playbooks in channel filter", async () => {
    await executePlaybookCreate(
      {
        trigger: "wildcard trigger",
        action: "handle anything",
        channel: "*",
      },
      ctx,
    );

    const result = await executePlaybookList({ channel: "gmail" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("wildcard trigger");
  });

  test("names the filter when nothing matches it", async () => {
    await executePlaybookCreate(
      { trigger: "only gmail", action: "handle", channel: "gmail" },
      ctx,
    );

    const result = await executePlaybookList({ channel: "github" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No playbooks found matching");
    expect(result.content).toContain("github");
  });

  test("sorts by priority descending", async () => {
    await executePlaybookCreate(
      { trigger: "low", action: "act", priority: 1 },
      ctx,
    );
    await executePlaybookCreate(
      { trigger: "high", action: "act", priority: 10 },
      ctx,
    );

    const result = await executePlaybookList({}, ctx);
    const lines = result.content
      .split("\n")
      .filter((l: string) => l.startsWith("- **"));
    expect(lines[0]).toContain("high");
    expect(lines[1]).toContain("low");
  });
});

// ── playbook_update ─────────────────────────────────────────────────

describe("playbook_update tool", () => {
  beforeEach(clearPlaybooks);

  test("updates the trigger", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "old trigger",
        action: "do something",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate(
      {
        playbook_id: id,
        trigger: "new trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook updated successfully");
    expect(result.content).toContain("new trigger");
  });

  test("updates multiple fields at once", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "test",
        action: "old action",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate(
      {
        playbook_id: id,
        action: "new action",
        channel: "github",
        autonomy_level: "auto",
        priority: 5,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("new action");
    expect(result.content).toContain("Channel: github");
    expect(result.content).toContain("Autonomy: execute automatically");
    expect(result.content).toContain("Priority: 5");
  });

  test("can disable a rule without deleting it", async () => {
    const createResult = await executePlaybookCreate(
      { trigger: "pause me", action: "act" },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    await executePlaybookUpdate({ playbook_id: id, enabled: false }, ctx);

    expect(getPlaybook(id)?.enabled).toBe(false);
    // Disabled rules stay listed but drop out of the matcher.
    expect(listMatchablePlaybooks({ channel: "watcher:gmail" })).toHaveLength(
      0,
    );
    expect((await executePlaybookList({}, ctx)).content).toContain("disabled");
  });

  test("keeps the current autonomy when given an invalid level", async () => {
    const createResult = await executePlaybookCreate(
      { trigger: "test", action: "test", autonomy_level: "auto" },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate(
      { playbook_id: id, autonomy_level: "bogus" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Autonomy: execute automatically");
  });

  test("with no changes still succeeds", async () => {
    const createResult = await executePlaybookCreate(
      { trigger: "unchanged", action: "same" },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookUpdate({ playbook_id: id }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook updated successfully");
    expect(result.content).toContain("unchanged");
  });

  test("detects collision with another playbook", async () => {
    await executePlaybookCreate(
      { trigger: "trigger A", action: "action A" },
      ctx,
    );
    const r2 = await executePlaybookCreate(
      { trigger: "trigger B", action: "action B" },
      ctx,
    );
    const idB = extractPlaybookId(r2.content);

    const result = await executePlaybookUpdate(
      { playbook_id: idB, trigger: "trigger A", action: "action A" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
  });

  test("rejects missing playbook_id", async () => {
    const result = await executePlaybookUpdate(
      {
        trigger: "new trigger",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("playbook_id is required");
  });

  test("returns error for nonexistent playbook_id", async () => {
    const result = await executePlaybookUpdate(
      {
        playbook_id: "nonexistent",
        trigger: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ── playbook_delete ─────────────────────────────────────────────────

describe("playbook_delete tool", () => {
  beforeEach(clearPlaybooks);

  test("deletes a playbook", async () => {
    const createResult = await executePlaybookCreate(
      {
        trigger: "delete me",
        action: "to be deleted",
      },
      ctx,
    );
    const id = extractPlaybookId(createResult.content);

    const result = await executePlaybookDelete({ playbook_id: id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Playbook deleted");
    expect(result.content).toContain("delete me");

    // Verify it no longer appears in list
    const listResult = await executePlaybookList({}, ctx);
    expect(listResult.content).toContain("No playbooks found");
  });

  test("rejects missing playbook_id", async () => {
    const result = await executePlaybookDelete({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("playbook_id is required");
  });

  test("returns error for nonexistent playbook_id", async () => {
    const result = await executePlaybookDelete(
      { playbook_id: "nonexistent" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ── the regression this rewrite exists for ──────────────────────────

describe("a chat-created playbook reaches the runtime", () => {
  beforeEach(clearPlaybooks);

  test("playbook_create lands where listMatchablePlaybooks can see it", async () => {
    await executePlaybookCreate(
      {
        trigger: "review requested",
        action: "summarise the diff",
        channel: "github",
        priority: 3,
      },
      ctx,
    );

    // `watcher:github` is what `watcherChannel()` stamps on a GitHub event.
    const matchable = listMatchablePlaybooks({ channel: "watcher:github" });
    expect(matchable).toHaveLength(1);
    expect(matchable[0].triggerText).toBe("review requested");
    expect(matchable[0].action).toBe("summarise the diff");

    // …and is scoped to that source, not fired on every channel.
    expect(listMatchablePlaybooks({ channel: "watcher:gmail" })).toHaveLength(
      0,
    );
  });

  test("a wildcard playbook matches every watcher channel", async () => {
    await executePlaybookCreate(
      { trigger: "*", action: "surface it", channel: "*" },
      ctx,
    );

    expect(listMatchablePlaybooks({ channel: "watcher:gmail" })).toHaveLength(
      1,
    );
    expect(
      listMatchablePlaybooks({ channel: "watcher:google-calendar" }),
    ).toHaveLength(1);
  });

  test("playbook_delete removes it from the runtime's view too", async () => {
    const created = await executePlaybookCreate(
      { trigger: "temporary", action: "act", channel: "gmail" },
      ctx,
    );
    await executePlaybookDelete(
      { playbook_id: extractPlaybookId(created.content) },
      ctx,
    );

    expect(listMatchablePlaybooks({ channel: "watcher:gmail" })).toHaveLength(
      0,
    );
  });
});
