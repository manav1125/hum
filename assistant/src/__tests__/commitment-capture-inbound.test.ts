/**
 * Handler integration: inbound channel messages trigger the deterministic
 * commitment-capture net (fire-and-forget, after the agent turn is
 * dispatched) without depending on the agent calling task_list_add.
 *
 * The LLM extractor and the triage hand-off are injected via the module's
 * test-only override hook so the pipeline is deterministic — no provider,
 * no background run.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { upsertContact } from "../contacts/contact-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  _setCommitmentCaptureOverridesForTests,
  type ExtractedCommitment,
} from "../work-items/commitment-capture.js";
import { listWorkItems } from "../work-items/work-item-store.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
}

function seedTrustedContact(): void {
  upsertContact({
    displayName: "Sarah Chen",
    channels: [
      {
        type: "telegram",
        address: "telegram-user-1",
        externalUserId: "telegram-user-1",
        status: "active",
        policy: "allow",
      },
    ],
  });
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "Can you send me the pitch deck by Friday?",
      actorExternalId: "telegram-user-1",
      actorDisplayName: "Sarah Chen",
      ...overrides,
    }),
  });
}

/** Poll until `cond` returns true or the timeout expires. */
async function waitFor(
  cond: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
}

/** Give the fire-and-forget capture chain a few ticks to (not) run. */
async function flushCaptureChain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("inbound handler → commitment capture integration", () => {
  const savedDisable = process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
  const savedChannels = process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;

  let extractorCalls: Array<{ channel: string; content: string }> = [];
  let triagedIds: string[] = [];
  let extractorResult: ExtractedCommitment[] | null = [];

  beforeEach(() => {
    resetTables();
    seedTrustedContact();
    setAdapterProcessMessage(undefined);
    delete process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
    delete process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;
    extractorCalls = [];
    triagedIds = [];
    extractorResult = [];
    _setCommitmentCaptureOverridesForTests({
      extractor: async (params) => {
        extractorCalls.push({
          channel: params.channel,
          content: params.content,
        });
        return extractorResult;
      },
      triage: async (workItemId: string) => {
        triagedIds.push(workItemId);
        return { autoRunStarted: false, reason: "skipped" as const };
      },
    });
  });

  afterEach(() => {
    _setCommitmentCaptureOverridesForTests({});
  });

  afterAll(() => {
    resetTables();
    if (savedDisable === undefined) {
      delete process.env.CUE_DISABLE_COMMITMENT_CAPTURE;
    } else {
      process.env.CUE_DISABLE_COMMITMENT_CAPTURE = savedDisable;
    }
    if (savedChannels === undefined) {
      delete process.env.CUE_COMMITMENT_CAPTURE_CHANNELS;
    } else {
      process.env.CUE_COMMITMENT_CAPTURE_CHANNELS = savedChannels;
    }
  });

  test("an external ask becomes a work item after the turn is accepted", async () => {
    extractorResult = [
      {
        title: "Send Sarah the pitch deck",
        executionPrompt:
          'Sarah Chen asked via telegram: "Can you send me the pitch deck by Friday?" Send the current pitch deck.',
        dueAt: null,
      },
    ];

    const res = await handleChannelInbound(makeInboundRequest());
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(false);

    // Capture is fire-and-forget after dispatch — poll for the work item.
    expect(await waitFor(() => listWorkItems().length === 1)).toBe(true);
    const item = listWorkItems()[0];
    expect(item.title).toBe("Send Sarah the pitch deck");
    expect(item.sourceType).toBe("telegram");
    expect(item.notes).toContain("From: Sarah Chen via telegram");
    expect(item.status).toBe("queued");
    // The extractor saw the raw (unwrapped) message text.
    expect(extractorCalls).toHaveLength(1);
    expect(extractorCalls[0].content).toBe(
      "Can you send me the pitch deck by Friday?",
    );
    // The existing triage/auto-run pass was invoked on the fresh item.
    expect(await waitFor(() => triagedIds.length === 1)).toBe(true);
    expect(triagedIds).toEqual([item.id]);
  });

  test("chatter passes through without an LLM call or a work item", async () => {
    const res = await handleChannelInbound(
      makeInboundRequest({ content: "haha nice, see you at the party" }),
    );
    expect(res.status).toBe(200);

    await flushCaptureChain();
    expect(extractorCalls).toHaveLength(0);
    expect(listWorkItems()).toHaveLength(0);
  });

  test("the kill switch disables capture on the inbound path", async () => {
    process.env.CUE_DISABLE_COMMITMENT_CAPTURE = "1";
    extractorResult = [
      { title: "Should never exist", executionPrompt: "nope", dueAt: null },
    ];

    const res = await handleChannelInbound(makeInboundRequest());
    expect(res.status).toBe(200);

    await flushCaptureChain();
    expect(extractorCalls).toHaveLength(0);
    expect(listWorkItems()).toHaveLength(0);
  });

  test("duplicate inbound events do not re-run capture", async () => {
    extractorResult = [
      {
        title: "Send Sarah the pitch deck",
        executionPrompt: "send it",
        dueAt: null,
      },
    ];

    const first = await handleChannelInbound(
      makeInboundRequest({ externalMessageId: "msg-dup-1" }),
    );
    expect(first.status).toBe(200);
    expect(await waitFor(() => listWorkItems().length === 1)).toBe(true);

    const second = await handleChannelInbound(
      makeInboundRequest({ externalMessageId: "msg-dup-1" }),
    );
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.duplicate).toBe(true);

    await flushCaptureChain();
    expect(extractorCalls).toHaveLength(1);
    expect(listWorkItems()).toHaveLength(1);
  });
});
