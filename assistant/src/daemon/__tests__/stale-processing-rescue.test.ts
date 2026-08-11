/**
 * Stale-processing rescue tests.
 *
 * The server-authoritative per-conversation `processing` flag is what web
 * clients render as the "run in progress" indicator (ghost avatar/spinner)
 * and what `enqueueMessage` uses to divert composer sends into the
 * in-memory queue. These tests pin the two recovery layers added after a
 * prod wedge (phantom in-progress indicator surviving page reloads for ~12
 * minutes, swallowing every send) traced to teardown paths that could skip
 * `setProcessing(false)`:
 *
 *   1. `rescueLeakedProcessing` — the run-settle rescue invoked from
 *      `Conversation.runAgentLoop` and the voice bridge teardown.
 *   2. The `ConversationEvictor` phase-0 sweep (covered in
 *      `conversation-evictor.test.ts`) which calls
 *      `forceClearStaleProcessing` as the TTL backstop.
 */

import { describe, expect, test } from "bun:test";

import { rescueLeakedProcessing } from "../conversation-lifecycle.js";
import {
  enqueueMessage,
  type MessagingConversationContext,
} from "../conversation-messaging.js";
import type { MessageQueue } from "../conversation-queue-manager.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeQueueItem {
  content: string;
  requestId: string;
}

function makeFakeCtx(options?: { processing?: boolean; requestId?: string }) {
  const queued: FakeQueueItem[] = [];
  const drainedBatches: FakeQueueItem[][] = [];
  const activityEmits: Array<{ phase: string; reason: string }> = [];
  let processing = options?.processing ?? false;

  const queue = {
    push(item: FakeQueueItem) {
      queued.push(item);
      return true;
    },
    get isEmpty() {
      return queued.length === 0;
    },
    get length() {
      return queued.length;
    },
  } as unknown as MessageQueue;

  const ctx = {
    conversationId: "conv-rescue-test",
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: new AbortController(),
    currentRequestId: options?.requestId,
    queue,
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {
      // Mirrors the real drain: queued messages are picked up and run once
      // the processing lock releases.
      drainedBatches.push(queued.splice(0, queued.length));
    },
    emitActivityState: (phase: "idle", reason: "error_terminal") => {
      activityEmits.push({ phase, reason });
    },
  };

  return { ctx, queued, drainedBatches, activityEmits };
}

/** Let fire-and-forget drain promises settle. */
const microtasks = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// rescueLeakedProcessing
// ---------------------------------------------------------------------------

describe("rescueLeakedProcessing", () => {
  test("clears a leaked flag, resets turn state, announces idle, drains the queue", async () => {
    const { ctx, activityEmits, drainedBatches } = makeFakeCtx({
      processing: true,
      requestId: "req-1",
    });

    const cleared = rescueLeakedProcessing(ctx, {
      source: "test",
      requestId: "req-1",
    });

    expect(cleared).toBe(true);
    expect(ctx.isProcessing()).toBe(false);
    expect(ctx.abortController).toBeNull();
    expect(ctx.currentRequestId).toBeUndefined();
    expect(activityEmits).toEqual([
      { phase: "idle", reason: "error_terminal" },
    ]);
    await microtasks();
    expect(drainedBatches.length).toBe(1);
  });

  test("no-ops when the conversation is not processing", () => {
    const { ctx } = makeFakeCtx({ processing: false, requestId: "req-1" });
    const cleared = rescueLeakedProcessing(ctx, {
      source: "test",
      requestId: "req-1",
    });
    expect(cleared).toBe(false);
    expect(ctx.abortController).not.toBeNull();
  });

  test("no-ops when another request already owns the conversation (drained follow-on turn)", () => {
    const { ctx } = makeFakeCtx({ processing: true, requestId: "req-NEW" });
    const cleared = rescueLeakedProcessing(ctx, {
      source: "test",
      requestId: "req-OLD",
    });
    expect(cleared).toBe(false);
    // The live follow-on turn keeps its state untouched.
    expect(ctx.isProcessing()).toBe(true);
    expect(ctx.currentRequestId).toBe("req-NEW");
  });

  test("without a requestId (sweeper path) clears regardless of owner", () => {
    const { ctx } = makeFakeCtx({ processing: true, requestId: "req-1" });
    const cleared = rescueLeakedProcessing(ctx, { source: "sweep" });
    expect(cleared).toBe(true);
    expect(ctx.isProcessing()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composer sends must not stay swallowed once the wedge clears
// ---------------------------------------------------------------------------

describe("composer send after rescue", () => {
  test("sends queue while wedged, drain on rescue, and pass the busy gate afterwards", async () => {
    const { ctx, queued, drainedBatches } = makeFakeCtx({
      processing: true,
      requestId: "req-wedged",
    });
    const messagingCtx = ctx as unknown as MessagingConversationContext;

    // While the flag is wedged true with no live run, a composer send is
    // diverted into the in-memory queue — this is the "swallowed send".
    const swallowed = enqueueMessage(messagingCtx, {
      content: "hello while wedged",
    });
    expect(swallowed.queued).toBe(true);
    expect(queued.length).toBe(1);

    // The sweep/settle rescue clears the flag AND drains the queue so the
    // swallowed send actually runs.
    const cleared = rescueLeakedProcessing(ctx, { source: "sweep" });
    expect(cleared).toBe(true);
    await microtasks();
    expect(drainedBatches.length).toBe(1);
    expect(drainedBatches[0]!.length).toBe(1);

    // A new composer send now passes the busy gate (queued: false → the
    // route takes the direct persist+run path instead of the queue).
    const after = enqueueMessage(messagingCtx, { content: "hello again" });
    expect(after.queued).toBe(false);
  });
});
