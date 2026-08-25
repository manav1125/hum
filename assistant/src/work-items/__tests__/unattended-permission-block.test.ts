/**
 * An unattended run that is denied has to leave a trace the owner can act on.
 *
 * The permission checker denies immediately when nothing is connected to
 * approve — correct, since a background run must not hang — and then tells the
 * model to "add a trust rule", which is an action only the owner can take.
 * Until this existed, the owner was never told it had been asked for: this
 * instance's heartbeat could not run its own circuit-breaker script from
 * 2026-08-01, wrote itself a manual fallback, recorded the denial in its
 * journal as "expected, consistent, documented", and ran degraded for
 * twenty-four days.
 *
 * The second property matters as much as the first. A heartbeat repeats, so an
 * item filed per occurrence turns one blocked script into hundreds of rows —
 * which is its own kind of silence.
 */

import { describe, expect, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import { listTasks } from "../../tasks/task-store.js";
import {
  recordApprovalTimeoutBlock,
  recordUnattendedPermissionBlock,
} from "../unattended-permission-block.js";
import { listWorkItems } from "../work-item-store.js";

initializeDb();

const block = (command: string) => ({
  toolName: "bash",
  input: { command },
  conversationId: undefined,
  riskLevel: "medium",
  riskReason: "Unknown command",
});

describe("unattended permission block", () => {
  test("a blocked run becomes a work item naming what it tried", () => {
    const id = recordUnattendedPermissionBlock(
      block("/workspace/bin/heartbeat-circuit-breaker.sh check"),
    );

    expect(id).not.toBeNull();
    const item = listWorkItems().find((i) => i.id === id);
    expect(item?.title).toContain(
      "/workspace/bin/heartbeat-circuit-breaker.sh",
    );
    // The note must name something the owner can actually do. It used to say
    // "add a trust rule via permission settings", which has no surface for an
    // unattended denial — the rule editor only opens from an approval card,
    // and an unattended run never raises one.
    expect(item?.notes).toContain("Run this item to retry it");
    expect(item?.notes).not.toContain("permission settings");
  });

  // The heartbeat fires hourly. One blocked script must stay one item.
  test("the same blocked command does not file twice", () => {
    const first = recordUnattendedPermissionBlock(
      block("/workspace/bin/dedup-me.sh run"),
    );
    const second = recordUnattendedPermissionBlock(
      block("/workspace/bin/dedup-me.sh run"),
    );

    expect(second).toBe(first);
    const matching = listWorkItems().filter((i) =>
      i.title.includes("/workspace/bin/dedup-me.sh"),
    );
    expect(matching).toHaveLength(1);
  });

  test("a genuinely different command files separately", () => {
    const a = recordUnattendedPermissionBlock(
      block("/workspace/bin/alpha.sh run"),
    );
    const b = recordUnattendedPermissionBlock(
      block("/workspace/bin/beta.sh run"),
    );

    expect(b).not.toBe(a);
  });

  // Arguments past the first carry timestamps and paths that differ every run;
  // including them would defeat the dedup they are meant to serve.
  test("trailing arguments do not split the dedup", () => {
    const a = recordUnattendedPermissionBlock(
      block("/workspace/bin/gamma.sh check --at 2026-08-01T00:00:00Z"),
    );
    const b = recordUnattendedPermissionBlock(
      block("/workspace/bin/gamma.sh check --at 2026-08-25T11:00:00Z"),
    );

    expect(b).toBe(a);
  });

  // The item reports a permission problem. An item that ran itself to fix one
  // would be the bug it is reporting.
  test("the item never auto-runs", () => {
    const id = recordUnattendedPermissionBlock(
      block("/workspace/bin/parked.sh go"),
    );
    const item = listWorkItems().find((i) => i.id === id);

    expect(item?.autoRunEligibility).toBe("parked");
  });

  // An expired request is a different thing to answer than a blocked one: one
  // says nobody could be asked, the other says you were asked and it lapsed.
  test("an expired approval reads as expired, not as blocked", () => {
    const id = recordApprovalTimeoutBlock(
      block("/workspace/bin/expired.sh go"),
    );
    const item = listWorkItems().find((i) => i.id === id);

    expect(item?.title).toContain("expired");
    expect(item?.notes).toContain("not a refusal");
  });

  test("the two causes do not collapse into one item", () => {
    const cmd = "/workspace/bin/both-causes.sh go";
    const blocked = recordUnattendedPermissionBlock(block(cmd));
    const expired = recordApprovalTimeoutBlock(block(cmd));

    expect(expired).not.toBe(blocked);
    const matching = listWorkItems().filter((i) =>
      i.title.includes("/workspace/bin/both-causes.sh"),
    );
    expect(matching).toHaveLength(2);
  });

  // Running a work item starts a fresh agent turn — which is the re-ask path.
  // For that to mean anything, the task the item carries has to instruct a
  // retry, not restate the problem.
  test("the item carries an instruction to retry, not a description", () => {
    const cmd = "/workspace/bin/retry-me.sh check --verbose";
    const id = recordUnattendedPermissionBlock(block(cmd));
    const item = listWorkItems().find((i) => i.id === id);
    const task = listTasks().find((t) => t.id === item?.taskId);

    expect(task?.template).toContain("Re-run this exact command");
    // The full command, not the two-word label the card shows.
    expect(task?.template).toContain(cmd);
    // And it must not tell the agent to route around the gate it hit.
    expect(task?.template).toContain("let the");
    expect(task?.template).toContain("do not work around them");
  });

  // The card a person reads carries the label; only the agent's instruction
  // carries the whole command line.
  test("the human-facing card does not carry the full command", () => {
    const cmd = "/workspace/bin/secretish.sh --token abc123 --more args";
    const id = recordUnattendedPermissionBlock(block(cmd));
    const item = listWorkItems().find((i) => i.id === id);

    expect(item?.title).not.toContain("abc123");
    expect(item?.notes).not.toContain("abc123");
  });

  // The deny already happened; nothing here may change it or throw into it.
  test("a malformed call is swallowed rather than thrown", () => {
    expect(() =>
      recordUnattendedPermissionBlock({
        toolName: "bash",
        input: {},
        riskLevel: "medium",
      }),
    ).not.toThrow();
  });
});
