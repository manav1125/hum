/**
 * Tests for guardrail checkpoint enforcement — the permission-checker hook
 * that tightens the per-category autonomy mode:
 *   - an enabled autonomy:<class> checkpoint turns "auto" into "ask"
 *   - "ask"/"never" are never loosened (or touched)
 *   - disabled checkpoints don't fire
 *   - agent-/mission-scoped checkpoints fire only for the matching
 *     background run conversation (work_items.last_run_conversation_id →
 *     assignee → agents registry / project → mission)
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";
import {
  _clearRunIdentityCacheForTesting,
  applyCheckpointAutonomyOverride,
  checkpointClassMatches,
} from "./checkpoint-enforcement.js";
import {
  createCheckpoint,
  invalidateCheckpointCache,
  updateCheckpoint,
} from "./checkpoint-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM guardrail_checkpoints");
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM agents");
  invalidateCheckpointCache();
  _clearRunIdentityCacheForTesting();
});

function seedAgent(id: string, name: string): void {
  const now = Date.now();
  getSqliteFrom(getDb())
    .prepare(
      `INSERT INTO agents (id, name, tier, paused, created_at, updated_at)
       VALUES (?, ?, '2', 0, ?, ?)`,
    )
    .run(id, name, now, now);
}

describe("everywhere-scoped checkpoints", () => {
  test("an enabled send checkpoint tightens auto → ask", () => {
    const cp = createCheckpoint({
      template: "send_message",
      label: "Sending any email or message",
    });
    const result = applyCheckpointAutonomyOverride({
      autonomyClass: "send",
      mode: "auto",
    });
    expect(result.mode).toBe("ask");
    expect(result.firedCheckpoint?.id).toBe(cp.id);
    expect(result.firedCheckpoint?.label).toBe("Sending any email or message");
  });

  test("only the matching autonomy class is tightened", () => {
    createCheckpoint({ template: "delete", label: "Deleting anything" });
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "auto" })
        .mode,
    ).toBe("auto");
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "delete",
        mode: "auto",
      }).mode,
    ).toBe("ask");
  });

  test("ask and never are left untouched (tighten-only)", () => {
    createCheckpoint({ template: "send_message", label: "Send" });
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "ask" })
        .mode,
    ).toBe("ask");
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "never" })
        .mode,
    ).toBe("never");
  });

  test("a disabled checkpoint does not fire (and never loosens)", () => {
    const cp = createCheckpoint({ template: "send_message", label: "Send" });
    updateCheckpoint(cp.id, { enabled: 0 });
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "auto" })
        .mode,
    ).toBe("auto");
  });

  test("truly declarative patterns (custom non-autonomy) do not enforce", () => {
    createCheckpoint({
      template: "custom",
      label: "My rule",
      pattern: "tool:my_tool_*",
    });
    for (const cls of [
      "send",
      "money",
      "delete",
      "publish",
      "contact",
      "other",
    ] as const) {
      expect(
        applyCheckpointAutonomyOverride({ autonomyClass: cls, mode: "auto" })
          .mode,
      ).toBe("auto");
    }
  });

  test("a publish checkpoint tightens the publish class only", () => {
    const cp = createCheckpoint({
      template: "publish",
      label: "Posting or publishing publicly",
    });
    const publish = applyCheckpointAutonomyOverride({
      autonomyClass: "publish",
      mode: "auto",
    });
    expect(publish.mode).toBe("ask");
    expect(publish.firedCheckpoint?.id).toBe(cp.id);
    // publish stays out of unrelated classes.
    for (const cls of ["send", "money", "delete", "research"] as const) {
      expect(
        applyCheckpointAutonomyOverride({ autonomyClass: cls, mode: "auto" })
          .mode,
      ).toBe("auto");
    }
    // Tighten-only preserved.
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "publish", mode: "ask" })
        .mode,
    ).toBe("ask");
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "publish",
        mode: "never",
      }).mode,
    ).toBe("never");
  });

  test("a legacy 'tool:publish_*' row enforces the publish class via the alias", () => {
    const cp = createCheckpoint({
      template: "publish",
      label: "Legacy publish rule",
      pattern: "tool:publish_*",
    });
    const result = applyCheckpointAutonomyOverride({
      autonomyClass: "publish",
      mode: "auto",
    });
    expect(result.mode).toBe("ask");
    expect(result.firedCheckpoint?.id).toBe(cp.id);
  });

  test("a contact checkpoint tightens contact AND send (coarse outbound-contact match)", () => {
    const cp = createCheckpoint({
      template: "contact",
      label: "Contacting someone new",
    });
    // Call initiation (contact class) asks.
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "contact",
        mode: "auto",
      }),
    ).toMatchObject({ mode: "ask", firedCheckpoint: { id: cp.id } });
    // Message/email sends (send class) ask too — recipient-level "new
    // contact" filtering is unknowable pre-execution, so ANY outbound
    // contact asks.
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "auto" }),
    ).toMatchObject({ mode: "ask", firedCheckpoint: { id: cp.id } });
    // But it never bleeds into non-contact classes.
    for (const cls of ["money", "delete", "publish", "research"] as const) {
      expect(
        applyCheckpointAutonomyOverride({ autonomyClass: cls, mode: "auto" })
          .mode,
      ).toBe("auto");
    }
    // Tighten-only preserved.
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "never" })
        .mode,
    ).toBe("never");
  });

  test("a legacy 'contact:*' row enforces via the alias", () => {
    createCheckpoint({
      template: "contact",
      label: "Legacy contact rule",
      pattern: "contact:*",
    });
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "contact",
        mode: "auto",
      }).mode,
    ).toBe("ask");
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "auto" })
        .mode,
    ).toBe("ask");
  });

  test("checkpointClassMatches: equality plus contact ⊇ send only", () => {
    expect(checkpointClassMatches("publish", "publish")).toBe(true);
    expect(checkpointClassMatches("contact", "contact")).toBe(true);
    expect(checkpointClassMatches("contact", "send")).toBe(true);
    // send does NOT cover contact (a send checkpoint is about messages).
    expect(checkpointClassMatches("send", "contact")).toBe(false);
    expect(checkpointClassMatches("publish", "send")).toBe(false);
    expect(checkpointClassMatches("contact", "money")).toBe(false);
  });
});

describe("agent-scoped checkpoints", () => {
  test("fires only for the scoped agent's run conversation", () => {
    seedAgent("growth", "Growth");
    seedAgent("ops", "Ops");
    createCheckpoint({
      template: "send_message",
      label: "Growth asks before sending",
      scope: "agent:growth",
    });

    const task = createTask({ title: "t", template: "do" });
    const growthItem = createWorkItem({
      taskId: task.id,
      title: "growth work",
    });
    // Assignee matching is case-insensitive on the agent name.
    updateWorkItem(growthItem.id, {
      assignee: "growth",
      lastRunConversationId: "conv-growth",
    });
    const opsItem = createWorkItem({ taskId: task.id, title: "ops work" });
    updateWorkItem(opsItem.id, {
      assignee: "Ops",
      lastRunConversationId: "conv-ops",
    });

    // The scoped agent's run: tightened.
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "send",
        mode: "auto",
        conversationId: "conv-growth",
      }).mode,
    ).toBe("ask");
    // Another agent's run: untouched.
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "send",
        mode: "auto",
        conversationId: "conv-ops",
      }).mode,
    ).toBe("auto");
    // Interactive chat (no run identity): untouched.
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "send",
        mode: "auto",
        conversationId: "conv-interactive",
      }).mode,
    ).toBe("auto");
    // No conversation id at all: untouched.
    expect(
      applyCheckpointAutonomyOverride({ autonomyClass: "send", mode: "auto" })
        .mode,
    ).toBe("auto");
  });
});

describe("mission-scoped checkpoints", () => {
  test("fires only for runs inside the scoped mission", () => {
    createCheckpoint({
      template: "delete",
      label: "Mission never deletes",
      scope: "mission:m1",
    });

    const now = Date.now();
    getSqliteFrom(getDb())
      .prepare(
        `INSERT INTO projects (id, title, mission_id, created_at, updated_at)
         VALUES ('p1', 'Project One', 'm1', ?, ?)`,
      )
      .run(now, now);

    const task = createTask({ title: "t", template: "do" });
    const inMission = createWorkItem({ taskId: task.id, title: "in" });
    updateWorkItem(inMission.id, {
      projectId: "p1",
      lastRunConversationId: "conv-in-mission",
    });
    const outside = createWorkItem({ taskId: task.id, title: "out" });
    updateWorkItem(outside.id, {
      lastRunConversationId: "conv-outside",
    });

    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "delete",
        mode: "auto",
        conversationId: "conv-in-mission",
      }).mode,
    ).toBe("ask");
    expect(
      applyCheckpointAutonomyOverride({
        autonomyClass: "delete",
        mode: "auto",
        conversationId: "conv-outside",
      }).mode,
    ).toBe("auto");
  });
});
