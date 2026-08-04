import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

type CallTelegramBotApi = typeof import("./api.js").callTelegramBotApi;

const callTelegramBotApiMock = mock<CallTelegramBotApi>(
  async () => ({}) as never,
);

const actualApi = await import("./api.js");
mock.module("./api.js", () => ({
  ...actualApi,
  callTelegramBotApi: (method: string, body: Record<string, unknown>) =>
    callTelegramBotApiMock(method, body),
}));

const { sendTelegramReply } = await import("./send.js");

const callsTo = (method: string) =>
  callTelegramBotApiMock.mock.calls.filter((call) => call[0] === method);

const approval: ApprovalUIMetadata = {
  requestId: "req-1",
  actions: [
    { id: "approve_once", label: "Approve once" },
    { id: "reject", label: "Reject" },
  ],
  plainTextFallback: 'Reply "yes" to approve',
};

beforeEach(() => {
  callTelegramBotApiMock.mockReset();
  callTelegramBotApiMock.mockImplementation(async () => ({}) as never);
});

describe("sendTelegramReply message id capture", () => {
  test("returns the sent message id so approval cards can be addressed later", async () => {
    callTelegramBotApiMock.mockImplementation(
      async () => ({ message_id: 42 }) as never,
    );

    const result = await sendTelegramReply("123", "Please approve", approval);

    expect(result.lastMessageId).toBe("42");
  });

  test("returns the id of the last chunk for a split message", async () => {
    let nextId = 1;
    callTelegramBotApiMock.mockImplementation(
      async () => ({ message_id: nextId++ }) as never,
    );

    const result = await sendTelegramReply("123", "x".repeat(4500));

    expect(callsTo("sendMessage")).toHaveLength(2);
    expect(result.lastMessageId).toBe("2");
  });

  test("omits the message id when the API response lacks one", async () => {
    const result = await sendTelegramReply("123", "Hello");

    expect(result.lastMessageId).toBeUndefined();
  });

  test("attaches the inline keyboard only to the last chunk", async () => {
    callTelegramBotApiMock.mockImplementation(
      async () => ({ message_id: 7 }) as never,
    );

    await sendTelegramReply("123", "x".repeat(4500), approval);

    const sends = callsTo("sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.[1]).not.toHaveProperty("reply_markup");
    expect(sends[1]?.[1]).toHaveProperty("reply_markup");
  });
});
