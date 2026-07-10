import { describe, it, expect, mock, beforeEach } from "bun:test";

import type { GatewayConfig } from "../../config.js";

// --- Mocks (registered before importing the handler) -----------------------

let ipcMock = mock(async (_method: string, _params?: unknown) => ({
  taskId: "task-1",
  state: "submitted",
}));
let inboundMock = mock(async (..._args: unknown[]) => ({
  forwarded: true,
  rejected: false,
}));

mock.module("../../ipc/assistant-client.js", () => ({
  ipcCallAssistant: (method: string, params?: unknown) =>
    ipcMock(method, params),
}));
mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: (...args: unknown[]) => inboundMock(...args),
}));

const { createA2AMessageSendHandler } = await import("./a2a-message-send.js");

// --- Helpers ---------------------------------------------------------------

const config = {
  gatewayInternalBaseUrl: "http://internal:7830",
} as unknown as GatewayConfig;

function makeConfigFile(a2aEnabled: boolean) {
  return {
    getBoolean: (section: string, field: string) =>
      section === "a2a" && field === "enabled" ? a2aEnabled : undefined,
    getString: () => undefined,
  } as unknown as import("../../config-file-cache.js").ConfigFileCache;
}

function rpc(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost:7830/a2a/message:send", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validMessage = {
  message_id: "m1",
  role: "user",
  parts: [{ kind: "text", text: "hello there" }],
};

beforeEach(() => {
  ipcMock = mock(async () => ({ taskId: "task-1", state: "submitted" }));
  inboundMock = mock(async () => ({ forwarded: true, rejected: false }));
});

// --- Tests -----------------------------------------------------------------

describe("A2A message:send", () => {
  it("returns 404 when A2A is not enabled", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(false));
    const res = await handler(
      rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
    );
    expect(res.status).toBe(404);
  });

  it("returns a JSON-RPC parse error on invalid JSON", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(rpc("{not json"));
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("rejects an unsupported method", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} }),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("rejects a malformed message", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: {} },
        },
        { "x-a2a-sender-id": "assistant-b" },
      ),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it("requires a sender identity", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: validMessage },
      }),
    );
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("sender");
  });

  it("persists the task, forwards with a taskId callback, and returns the submitted task", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "message/send",
          params: {
            message: validMessage,
            configuration: {
              pushNotificationConfig: { url: "https://peer.example/push" },
            },
          },
        },
        { "x-a2a-sender-id": "assistant-b" },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: { id: string; status: { state: string } };
    };
    expect(body.id).toBe(7);
    expect(body.result.id).toBe("task-1");
    expect(body.result.status.state).toBe("submitted");

    // Task creation was ACL-gated in the assistant with the sender + pushUrl.
    expect(ipcMock).toHaveBeenCalledTimes(1);
    const [method, params] = ipcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("integrations_a2a_inbound_post");
    expect(params.senderAssistantId).toBe("assistant-b");
    expect(params.pushUrl).toBe("https://peer.example/push");

    // The message was forwarded with a /deliver/a2a?taskId=… reply callback.
    expect(inboundMock).toHaveBeenCalledTimes(1);
    const opts = (inboundMock.mock.calls[0] as unknown[])[2] as {
      replyCallbackUrl: string;
    };
    expect(opts.replyCallbackUrl).toContain("/deliver/a2a?taskId=task-1");
  });

  it("returns an error and does not forward when the sender is not a trusted contact", async () => {
    ipcMock = mock(async () => {
      throw new Error("sender is not a trusted A2A contact");
    });
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: validMessage },
        },
        { "x-a2a-sender-id": "stranger" },
      ),
    );
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("trusted");
    expect(inboundMock).not.toHaveBeenCalled();
  });
});
