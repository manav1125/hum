/**
 * The bind/restore contract that decides whether an approval reaches anyone.
 *
 * `Conversation.sendToClient` is conversation-level mutable state: born a
 * no-op, bound to the SSE hub for an interactive turn, restored after. The
 * `PermissionPrompter` reads THAT sender rather than the turn's own `onEvent`,
 * so a confirmation raised by a turn that never bound it is emitted into the
 * no-op, reaches no client, and hangs until the 300s permission timeout
 * auto-denies.
 *
 * That is what happened to every approval-gated tool in a DRAINED turn. A
 * message arriving mid-turn is queued and drained later, and only
 * `processMessage` bound the sender — the drain bypassed it and inherited the
 * no-op the previous turn's cleanup left behind. It is a strong candidate for
 * the dropped-approval incident that survived three repair passes, because
 * those fire on state transitions and this never emitted at all.
 *
 * These pin the helper's contract directly. The interesting cases are the two
 * restores that are NOT a reset to no-op — both exist so that fixing the drain
 * did not break producers that legitimately own the sender.
 */

import { describe, expect, mock, test } from "bun:test";

const broadcastMessage = mock(() => {});
const actualHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...actualHub,
  broadcastMessage,
}));

const updateParentSender = mock(() => {});
const actualSubagent = await import("../subagent/index.js");
mock.module("../subagent/index.js", () => ({
  ...actualSubagent,
  getSubagentManager: () => ({ updateParentSender }),
}));

const { bindInteractiveTurnSender } =
  await import("./interactive-turn-sender.js");

/** Minimal stand-in for the conversation's sender state. */
function makeConversation(
  initialSender: unknown = () => {},
  hasNoClient = true,
) {
  let sender: unknown = initialSender;
  return {
    conversationId: "conv-1",
    hasNoClient,
    getCurrentSender: () => sender,
    updateClient(next: unknown, noClient: boolean) {
      sender = next;
      this.hasNoClient = noClient;
    },
  };
}

describe("bindInteractiveTurnSender", () => {
  test("binds the conversation sender to the hub", () => {
    // The whole point: after this, a confirmation_request reaches a client.
    const conv = makeConversation();
    bindInteractiveTurnSender(conv as never);
    expect(conv.getCurrentSender()).toBe(broadcastMessage);
    expect(conv.hasNoClient).toBe(false);
  });

  test("binds the subagent parent sender too", () => {
    // A subagent's approval surfaces through the parent's sender.
    updateParentSender.mockClear();
    const conv = makeConversation();
    bindInteractiveTurnSender(conv as never);
    expect(updateParentSender).toHaveBeenCalledWith("conv-1", broadcastMessage);
  });

  test("restore puts back the no-op the previous turn left", () => {
    // The ordinary interactive flow: the snapshot IS the no-op, so restoring
    // it is identical to the reset this contract has always performed.
    const noop = () => {};
    const conv = makeConversation(noop, true);
    const restore = bindInteractiveTurnSender(conv as never);
    restore();
    expect(conv.getCurrentSender()).toBe(noop);
    expect(conv.hasNoClient).toBe(true);
  });

  test("a live binding that predated the turn SURVIVES it", () => {
    // Restore is a snapshot, not an unconditional reset. The send route can
    // install a sender while a non-interactive turn runs, and out-of-turn
    // producers (call transcripts, completion notifiers) keep reading it —
    // resetting to no-op here would silently cut them off.
    const preExisting = () => {};
    const conv = makeConversation(preExisting, false);
    const restore = bindInteractiveTurnSender(conv as never);
    expect(conv.getCurrentSender()).toBe(broadcastMessage);
    restore();
    expect(conv.getCurrentSender()).toBe(preExisting);
    expect(conv.hasNoClient).toBe(false);
  });

  test("restore is identity-guarded: it never clobbers someone else's sender", () => {
    // If another subsystem rebound the sender mid-turn, this turn's cleanup
    // must leave it alone — restoring would undo a binding it does not own.
    const conv = makeConversation();
    const restore = bindInteractiveTurnSender(conv as never);
    const otherSubsystemSender = () => {};
    conv.updateClient(otherSubsystemSender, false);

    restore();

    expect(conv.getCurrentSender()).toBe(otherSubsystemSender);
  });

  test("nested binds restore in order without stranding the hub binding", () => {
    // Defensive: two binds and two restores must land back where they began,
    // or a turn leaves the conversation permanently pointed at the hub.
    const noop = () => {};
    const conv = makeConversation(noop, true);
    const outer = bindInteractiveTurnSender(conv as never);
    const inner = bindInteractiveTurnSender(conv as never);
    inner();
    outer();
    expect(conv.getCurrentSender()).toBe(noop);
  });
});

describe("every interactive-turn path binds the sender", () => {
  /**
   * A guard on the invariant the module header states: EVERY path that runs
   * an interactive agent turn must bind before the loop and restore after.
   *
   * Asserted against the source because that is where the invariant can
   * actually be broken. The bug was not a wrong implementation — the helper
   * worked — it was a second path that never called it, and the only way to
   * catch a missing call is to look for it. A unit test on the helper passes
   * happily while the drain bypasses it entirely, which is exactly what
   * happened.
   */
  const PATHS = [
    // The canonical interactive turn.
    "src/daemon/process-message.ts",
    // The queue drain — the path that lacked this, so a message arriving
    // mid-turn ran its turn with the previous turn's no-op sender.
    "src/daemon/conversation-process.ts",
  ];

  test.each(PATHS)("%s binds the interactive turn sender", async (path) => {
    const source = await Bun.file(path).text();
    // Import lines are stripped first. Searching the whole file for the
    // identifier would match the import alone, so the guard would still pass
    // with the call deleted — a guard that cannot fail is worse than none.
    const body = source
      .split("\n")
      .filter((line) => !/^\s*(import|\s+)?.*from ".*";\s*$/.test(line))
      .join("\n");
    expect(body).toMatch(/bindInteractiveTurnSender\s*\(/);
    // Bound without a restore leaves the conversation pointed at the hub.
    expect(body).toMatch(/restoreSender|restore\s*\(\)/);
  });
});
