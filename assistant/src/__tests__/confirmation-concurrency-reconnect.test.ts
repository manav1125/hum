/**
 * Regression tests for the confirmation / pending-interaction lifecycle under
 * concurrent sub-agent confirmations and SSE reconnect.
 *
 * Failure being guarded against: when Cue spawns parallel sub-agents that each
 * raise a "Confirmation required" approval, clicking "Allow" failed with
 * "No pending interaction found for this requestId" because the pending
 * confirmation was lost (or never re-synced) before the click.
 *
 * Two invariants are covered:
 *
 *   1. Concurrent confirmations are independent — resolving or auto-denying
 *      one sub-agent's confirmation never removes another's pending
 *      interaction. (Each sub-agent owns a distinct conversationId, and
 *      `removeByConversation` is scoped to the exact conversationId.)
 *
 *   2. The reconcile path (`GET /v1/pending-interactions?conversationId=<parent>`)
 *      surfaces still-live sub-agent confirmations — which are registered under
 *      the sub-agent's conversationId but surfaced to the parent's client — so a
 *      client reconnecting to the parent re-syncs every live requestId.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// Replace the event hub with a thin recorder so the tracker's
// `interaction_resolved` broadcasts don't require a live hub.
const publishedMessages: ServerMessage[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => {
    publishedMessages.push(msg);
  },
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => ({ dispose: () => {}, active: true }),
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Stub the conversation-key store: the reconcile endpoint only uses it when a
// conversationKey (not conversationId) is supplied, which these tests don't.
mock.module("../memory/conversation-key-store.js", () => ({
  getConversationByKey: () => undefined,
}));

// Stub findConversation — unused by the GET reconcile handler under test.
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: () => undefined,
}));

// Controllable sub-agent manager: maps a parent conversationId to the
// conversationIds of its live children.
let childConversationIdsByParent = new Map<string, string[]>();
mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({
    getChildConversationIds: (parentId: string) =>
      childConversationIdsByParent.get(parentId) ?? [],
  }),
}));

const pendingInteractions = await import("../runtime/pending-interactions.js");
const approvalRoutes = await import("../runtime/routes/approval-routes.js");

// Pull the reconcile handler out of the ROUTES array by operationId.
const reconcileRoute = approvalRoutes.ROUTES.find(
  (r) => r.operationId === "pending_interactions",
);
if (!reconcileRoute) throw new Error("pending_interactions route not found");
const handleReconcile = reconcileRoute.handler;

function registerConfirmation(requestId: string, conversationId: string): void {
  pendingInteractions.register(requestId, {
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName: "bash",
      input: {},
      riskLevel: "medium",
      reversibility: "reversible" as const,
      allowlistOptions: [],
      scopeOptions: [],
    },
  });
}

beforeEach(() => {
  publishedMessages.length = 0;
  childConversationIdsByParent = new Map();
  pendingInteractions.clear();
});

afterEach(() => {
  pendingInteractions.clear();
});

describe("concurrent sub-agent confirmations stay independent", () => {
  test("resolving one sub-agent's confirmation leaves siblings intact", () => {
    registerConfirmation("req-A", "subagent-A");
    registerConfirmation("req-B", "subagent-B");
    registerConfirmation("req-C", "subagent-C");

    // User allows sub-agent A's confirmation.
    pendingInteractions.resolve("req-A", "approved");

    expect(pendingInteractions.get("req-A")).toBeUndefined();
    // Siblings must remain live so their Allow buttons still map to a
    // registered requestId.
    expect(pendingInteractions.get("req-B")).toBeDefined();
    expect(pendingInteractions.get("req-C")).toBeDefined();
  });

  test("auto-deny of one conversation does not wipe sibling sub-agents", () => {
    registerConfirmation("req-A", "subagent-A");
    registerConfirmation("req-B", "subagent-B");

    // A new user message in sub-agent A's conversation auto-denies only A's
    // pending confirmation.
    pendingInteractions.removeByConversation("subagent-A");

    expect(pendingInteractions.get("req-A")).toBeUndefined();
    expect(pendingInteractions.get("req-B")).toBeDefined();

    // Exactly one resolution event was emitted, for req-A only.
    const resolved = publishedMessages.filter(
      (m) => m.type === "interaction_resolved",
    ) as Extract<ServerMessage, { type: "interaction_resolved" }>[];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.requestId).toBe("req-A");
  });
});

describe("reconnect reconcile surfaces live sub-agent confirmations", () => {
  test("parent reconcile includes confirmations from its live sub-agents", () => {
    // Parent has its own confirmation plus two concurrent sub-agents, each
    // with a live confirmation registered under the sub-agent's own id.
    registerConfirmation("req-parent", "parent-conv");
    registerConfirmation("req-sub-1", "subagent-1");
    registerConfirmation("req-sub-2", "subagent-2");
    childConversationIdsByParent.set("parent-conv", [
      "subagent-1",
      "subagent-2",
    ]);

    const result = handleReconcile({
      queryParams: { conversationId: "parent-conv" },
    } as Parameters<typeof handleReconcile>[0]) as {
      pendingConfirmation: { requestId: string } | null;
      confirmations: Array<{ requestId: string; conversationId: string }>;
    };

    const ids = new Set(result.confirmations.map((c) => c.requestId));
    expect(ids).toEqual(new Set(["req-parent", "req-sub-1", "req-sub-2"]));
    // Legacy single-entry field stays populated for older clients.
    expect(result.pendingConfirmation).not.toBeNull();
  });

  test("reconcile omits sub-agents that are no longer live", () => {
    registerConfirmation("req-parent", "parent-conv");
    // Sub-agent registered a confirmation but the manager reports no live
    // children (terminal / disposed) — its requestId must not be surfaced.
    registerConfirmation("req-stale-sub", "subagent-dead");
    childConversationIdsByParent.set("parent-conv", []);

    const result = handleReconcile({
      queryParams: { conversationId: "parent-conv" },
    } as Parameters<typeof handleReconcile>[0]) as {
      confirmations: Array<{ requestId: string }>;
    };

    const ids = new Set(result.confirmations.map((c) => c.requestId));
    expect(ids).toEqual(new Set(["req-parent"]));
  });

  test("a resolved sub-agent confirmation drops out of the reconcile set", () => {
    registerConfirmation("req-parent", "parent-conv");
    registerConfirmation("req-sub-1", "subagent-1");
    childConversationIdsByParent.set("parent-conv", ["subagent-1"]);

    // Sub-agent 1's confirmation is allowed, then a reconnect reconciles.
    pendingInteractions.resolve("req-sub-1", "approved");

    const result = handleReconcile({
      queryParams: { conversationId: "parent-conv" },
    } as Parameters<typeof handleReconcile>[0]) as {
      confirmations: Array<{ requestId: string }>;
    };

    const ids = new Set(result.confirmations.map((c) => c.requestId));
    expect(ids).toEqual(new Set(["req-parent"]));
  });
});
