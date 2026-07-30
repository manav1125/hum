/**
 * B5: the HQ hero "Approve" button never approved.
 *
 * The daemon attaches `endpoint: "/v1/confirm"` to the approve/decline actions,
 * but `POST /v1/confirm` requires `{ requestId, decision }`
 * (assistant/src/runtime/routes/approval-routes.ts). Both HQ surfaces fired the
 * endpoint with NO body, so every click 400'd with "requestId is required" —
 * and with no error branch the failure was invisible while the blocked work
 * stayed blocked.
 *
 * Two shape details the fix has to get right, both verified against the daemon:
 *   · the requestId arrives as `int:<requestId>` in `move.itemId`
 *     (gatherApprovalCandidates in assistant/src/runtime/next-move.ts)
 *   · the wire vocabulary is allow/deny, not approve/decline
 *     (canonicalizeConfirmDecision)
 */
import { describe, expect, test } from "bun:test";

import {
  buildActionBody,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";

const action = (kind: NextMoveAction["kind"]): NextMoveAction => ({
  id: kind,
  label: kind,
  kind,
  endpoint: "/v1/confirm",
  method: "POST",
});

describe("buildActionBody", () => {
  test("approve sends the un-prefixed requestId and decision=allow", () => {
    expect(
      buildActionBody(action("approve"), { itemId: "int:req-abc" }),
    ).toEqual({ body: { requestId: "req-abc", decision: "allow" } });
  });

  test("decline maps to decision=deny", () => {
    expect(
      buildActionBody(action("decline"), { itemId: "int:req-abc" }),
    ).toEqual({ body: { requestId: "req-abc", decision: "deny" } });
  });

  test("the int: prefix is stripped, not passed through", () => {
    const built = buildActionBody(action("approve"), { itemId: "int:req-abc" });
    // Passing `int:req-abc` through would 404 as an unknown requestId.
    expect(built?.body.requestId).not.toContain("int:");
  });

  test("non-approval actions send no body", () => {
    // `run` targets /v1/work-items/<id>/run, which takes none — attaching an
    // approval body there would be wrong.
    expect(buildActionBody(action("run"), { itemId: "wi:1" })).toBeNull();
    expect(
      buildActionBody(action("open_thread"), { itemId: "int:x" }),
    ).toBeNull();
    expect(buildActionBody(action("snooze"), { itemId: "int:x" })).toBeNull();
  });

  test("an approval whose itemId lacks the prefix yields no body", () => {
    // Better to send nothing (a visible 400) than to invent a requestId.
    expect(buildActionBody(action("approve"), { itemId: "wi:42" })).toBeNull();
    expect(buildActionBody(action("approve"), { itemId: null })).toBeNull();
  });
});
