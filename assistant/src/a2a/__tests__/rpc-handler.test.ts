import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { upsertContact } from "../../contacts/contact-store.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { generatePeerToken, storePeerToken } from "../peer-auth.js";
import {
  METHOD_NOT_FOUND,
  TASK_NOT_CANCELABLE,
  TASK_NOT_FOUND,
} from "../protocol-errors.js";
import { handleA2ARpc } from "../rpc-handler.js";
import { createTask, getTask, updateState } from "../task-store.js";

initializeDb();

const SENDER = "assistant-peer";
let PEER_TOKEN: string;

function seedTrustedPeer(): void {
  const contact = upsertContact({
    displayName: "Peer",
    contactType: "assistant",
    role: "contact",
    channels: [
      {
        type: "a2a",
        address: SENDER.toLowerCase(),
        externalUserId: SENDER,
        status: "active",
        policy: "allow",
      },
    ],
  });
  PEER_TOKEN = generatePeerToken();
  storePeerToken({
    contactId: contact.id,
    assistantId: SENDER,
    gatewayUrl: "https://peer.example.com",
    peerToken: PEER_TOKEN,
  });
}

function goodAuth() {
  return {
    senderAssistantId: SENDER,
    authorization: `Bearer ${PEER_TOKEN}`,
  };
}

describe("a2a rpc-handler", () => {
  beforeEach(() => {
    const raw = getSqliteFrom(getDb());
    raw.run("DELETE FROM a2a_tasks");
    raw.run("DELETE FROM assistant_contact_metadata");
    raw.run("DELETE FROM contact_channels");
    raw.run("DELETE FROM contacts");
    seedTrustedPeer();
  });

  // ── Authentication (G1) ──────────────────────────────────────────

  test("rejects a call with no bearer token", () => {
    const { response } = handleA2ARpc(
      { id: 1, method: "tasks/get", params: { id: "x" } },
      { senderAssistantId: SENDER, authorization: null },
    );
    expect(response.error).toBeDefined();
    expect(response.result).toBeUndefined();
  });

  test("rejects a call with a mismatched bearer token (no impersonation)", () => {
    const { response } = handleA2ARpc(
      { id: 1, method: "tasks/get", params: { id: "x" } },
      { senderAssistantId: SENDER, authorization: "Bearer forged" },
    );
    expect(response.error).toBeDefined();
  });

  test("rejects a self-asserted sender that is not a known peer", () => {
    const { response } = handleA2ARpc(
      { id: 1, method: "tasks/get", params: { id: "x" } },
      { senderAssistantId: "impostor", authorization: "Bearer anything" },
    );
    expect(response.error).toBeDefined();
  });

  test("rejects when the peer is untrusted even with a valid-looking call", () => {
    // Block the channel — token check would pass but the allowlist gate fails.
    const raw = getSqliteFrom(getDb());
    raw.run("UPDATE contact_channels SET status = 'blocked', policy = 'deny'");

    const { response } = handleA2ARpc(
      { id: 1, method: "tasks/get", params: { id: "x" } },
      goodAuth(),
    );
    expect(response.error).toBeDefined();
  });

  // ── message/send ─────────────────────────────────────────────────

  test("message/send authenticates, creates a task, and returns camelCase", () => {
    const result = handleA2ARpc(
      {
        id: 7,
        method: "message/send",
        params: {
          message: {
            messageId: "m-1",
            role: "user",
            parts: [{ kind: "text", text: "do a thing" }],
          },
        },
      },
      goodAuth(),
    );

    expect(result.response.error).toBeUndefined();
    const task = (result.response.result as { task: Record<string, unknown> })
      .task;
    expect(task.kind).toBe("task");
    expect(task.id).toBeTruthy();
    const status = task.status as Record<string, unknown>;
    expect(status.state).toBe("submitted");

    // Enqueue directive is emitted for the gateway to drive the agent run.
    expect(result.enqueue?.taskId).toBe(task.id as string);
    expect(result.enqueue?.senderAssistantId).toBe(SENDER);

    // Persisted.
    expect(getTask(task.id as string)).not.toBeNull();
  });

  test("message/send accepts snake_case message (legacy peer)", () => {
    const result = handleA2ARpc(
      {
        id: 8,
        method: "message:send",
        params: {
          message: {
            message_id: "m-2",
            role: "user",
            parts: [{ kind: "text", text: "legacy" }],
          },
        },
      },
      goodAuth(),
    );
    expect(result.response.error).toBeUndefined();
    expect(result.enqueue).toBeDefined();
  });

  test("message/send rejects a malformed message with INVALID_PARAMS", () => {
    const { response } = handleA2ARpc(
      { id: 9, method: "message/send", params: { message: { role: "user" } } },
      goodAuth(),
    );
    expect(response.error).toBeDefined();
  });

  // ── tasks/get ────────────────────────────────────────────────────

  test("tasks/get returns a stored task in camelCase", () => {
    const task = createTask({
      senderAssistantId: SENDER,
      requestMessage: {
        message_id: "m-1",
        role: "user",
        parts: [{ kind: "text", text: "hi" }],
      },
    });

    const { response } = handleA2ARpc(
      { id: 3, method: "tasks/get", params: { id: task.id } },
      goodAuth(),
    );
    const returned = (response.result as { task: Record<string, unknown> })
      .task;
    expect(returned.id).toBe(task.id);
    expect(returned.kind).toBe("task");
  });

  test("tasks/get returns TASK_NOT_FOUND for unknown id", () => {
    const { response } = handleA2ARpc(
      { id: 3, method: "tasks/get", params: { id: "nope" } },
      goodAuth(),
    );
    expect(response.error?.code).toBe(TASK_NOT_FOUND);
  });

  // ── tasks/cancel ─────────────────────────────────────────────────

  test("tasks/cancel cancels a non-terminal task", () => {
    const task = createTask({
      senderAssistantId: SENDER,
      requestMessage: {
        message_id: "m-1",
        role: "user",
        parts: [{ kind: "text", text: "hi" }],
      },
    });

    const { response } = handleA2ARpc(
      { id: 4, method: "tasks/cancel", params: { id: task.id } },
      goodAuth(),
    );
    const returned = (response.result as { task: Record<string, unknown> })
      .task;
    expect((returned.status as Record<string, unknown>).state).toBe("canceled");
  });

  test("tasks/cancel returns TASK_NOT_CANCELABLE for a terminal task", () => {
    const task = createTask({
      senderAssistantId: SENDER,
      requestMessage: {
        message_id: "m-1",
        role: "user",
        parts: [{ kind: "text", text: "hi" }],
      },
    });
    updateState(task.id, "completed");

    const { response } = handleA2ARpc(
      { id: 5, method: "tasks/cancel", params: { id: task.id } },
      goodAuth(),
    );
    expect(response.error?.code).toBe(TASK_NOT_CANCELABLE);
  });

  test("tasks/cancel returns TASK_NOT_FOUND for unknown id", () => {
    const { response } = handleA2ARpc(
      { id: 6, method: "tasks/cancel", params: { id: "nope" } },
      goodAuth(),
    );
    expect(response.error?.code).toBe(TASK_NOT_FOUND);
  });

  // ── unknown method ───────────────────────────────────────────────

  test("unknown method returns METHOD_NOT_FOUND", () => {
    const { response } = handleA2ARpc(
      { id: 10, method: "message/stream", params: {} },
      goodAuth(),
    );
    expect(response.error?.code).toBe(METHOD_NOT_FOUND);
  });
});
