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
import { recordUnattendedPermissionBlock } from "../unattended-permission-block.js";
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
    expect(item?.notes).toContain("no");
    expect(item?.notes).toContain("trust rule");
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
