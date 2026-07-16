import { describe, it, expect, mock, beforeEach } from "bun:test";

import type { GatewayConfig } from "../../config.js";

// --- Mocks (registered before importing the handler) -----------------------
//
// The gateway handler is a thin transport: it forwards the parsed JSON-RPC +
// asserted sender + Authorization header to the assistant data plane
// (`integrations_a2a_rpc_post`, mocked as `ipcCallAssistant`), then — only for
// a `message/send` that returns an `enqueue` directive — drives the agent run
// through `handleInbound` with a `/deliver/a2a?taskId=…` reply callback.

let ipcResult: unknown = {
  response: {
    jsonrpc: "2.0",
    id: 1,
    result: { task: { kind: "task", id: "task-1" } },
  },
};
let ipcMock = mock(async (_method: string, _params?: unknown) => ipcResult);

let inboundResult: { rejected: boolean; rejectionReason?: string } = {
  rejected: false,
};
let inboundMock = mock(async (..._args: unknown[]) => inboundResult);

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

// The normalized internal message the data plane echoes back in `enqueue`.
const enqueueMessage = {
  message_id: "m1",
  context_id: "ctx-1",
  parts: [{ kind: "text", text: "hello there" }],
};

function sendSuccess(id: number) {
  return {
    response: {
      jsonrpc: "2.0",
      id,
      result: {
        task: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "submitted" },
        },
      },
    },
    enqueue: {
      taskId: "task-1",
      message: enqueueMessage,
      senderAssistantId: "assistant-b",
    },
  };
}

beforeEach(() => {
  ipcResult = {
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: { task: { kind: "task", id: "task-1" } },
    },
  };
  inboundResult = { rejected: false };
  ipcMock = mock(async () => ipcResult);
  inboundMock = mock(async () => inboundResult);
});

// --- Tests -----------------------------------------------------------------

describe("A2A message:send", () => {
  it("returns 404 when A2A is not enabled", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(false));
    const res = await handler(
      rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
    );
    expect(res.status).toBe(404);
    // Dormant: nothing is forwarded to the data plane.
    expect(ipcMock).not.toHaveBeenCalled();
  });

  it("returns a JSON-RPC parse error on invalid JSON", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(rpc("{not json"));
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("rejects a non-2.0 jsonrpc envelope", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc({ jsonrpc: "1.0", id: 1, method: "message/send", params: {} }),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it("rejects a request with no method", async () => {
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(rpc({ jsonrpc: "2.0", id: 1, params: {} }));
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it("forwards message/send to the data plane and drives handleInbound", async () => {
    ipcResult = sendSuccess(7);
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
        { "x-a2a-sender-id": "assistant-b", authorization: "Bearer peer-tok" },
      ),
    );

    expect(res.status).toBe(200);
    // The data plane's spec-camelCase response is relayed verbatim.
    const body = (await res.json()) as {
      id: number;
      result: { task: { id: string; kind: string; contextId: string } };
    };
    expect(body.id).toBe(7);
    expect(body.result.task.id).toBe("task-1");
    expect(body.result.task.kind).toBe("task");
    expect(body.result.task.contextId).toBe("ctx-1");

    // Forwarded to the authenticated data plane with sender + raw Authorization.
    expect(ipcMock).toHaveBeenCalledTimes(1);
    const [method, params] = ipcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("integrations_a2a_rpc_post");
    expect(params.senderAssistantId).toBe("assistant-b");
    expect(params.authorization).toBe("Bearer peer-tok");
    expect((params.rpc as { method: string }).method).toBe("message/send");

    // The agent run is driven with a /deliver/a2a?taskId=… reply callback, and
    // conversation binding is keyed on the contextId (this branch's semantics).
    expect(inboundMock).toHaveBeenCalledTimes(1);
    const inboundArgs = inboundMock.mock.calls[0] as unknown[];
    const event = inboundArgs[1] as {
      message: { conversationExternalId: string };
    };
    expect(event.message.conversationExternalId).toBe("ctx-1");
    const opts = inboundArgs[2] as { replyCallbackUrl: string };
    expect(opts.replyCallbackUrl).toContain("/deliver/a2a?taskId=task-1");
  });

  it("resolves the sender from params.metadata.senderId when no header", async () => {
    ipcResult = sendSuccess(8);
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    await handler(
      rpc({
        jsonrpc: "2.0",
        id: 8,
        method: "message/send",
        params: {
          message: validMessage,
          metadata: { senderId: "assistant-b" },
        },
      }),
    );
    const [, params] = ipcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params.senderAssistantId).toBe("assistant-b");
  });

  it("relays a data-plane auth error and does NOT drive the agent run", async () => {
    ipcResult = {
      response: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Peer authentication failed" },
      },
    };
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: validMessage },
        },
        { "x-a2a-sender-id": "stranger", authorization: "Bearer forged" },
      ),
    );
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("authentication");
    // No enqueue directive ⇒ the inbound pipeline is never invoked.
    expect(inboundMock).not.toHaveBeenCalled();
  });

  it("relays tasks/get without driving the agent run", async () => {
    ipcResult = {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          task: { kind: "task", id: "task-9", status: { state: "working" } },
        },
      },
    };
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tasks/get",
          params: { id: "task-9" },
        },
        { "x-a2a-sender-id": "assistant-b", authorization: "Bearer t" },
      ),
    );
    const body = (await res.json()) as {
      result: { task: { id: string } };
    };
    expect(body.result.task.id).toBe("task-9");
    const [method, params] = ipcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("integrations_a2a_rpc_post");
    expect((params.rpc as { method: string }).method).toBe("tasks/get");
    expect(inboundMock).not.toHaveBeenCalled();
  });

  it("relays tasks/cancel without driving the agent run", async () => {
    ipcResult = {
      response: {
        jsonrpc: "2.0",
        id: 4,
        result: {
          task: { kind: "task", id: "task-9", status: { state: "canceled" } },
        },
      },
    };
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tasks/cancel",
          params: { id: "task-9" },
        },
        { "x-a2a-sender-id": "assistant-b", authorization: "Bearer t" },
      ),
    );
    const body = (await res.json()) as {
      result: { task: { status: { state: string } } };
    };
    expect(body.result.task.status.state).toBe("canceled");
    const [, params] = ipcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect((params.rpc as { method: string }).method).toBe("tasks/cancel");
    expect(inboundMock).not.toHaveBeenCalled();
  });

  it("returns a JSON-RPC error when routing rejects the forwarded message", async () => {
    ipcResult = sendSuccess(5);
    inboundResult = { rejected: true, rejectionReason: "not routable" };
    const handler = createA2AMessageSendHandler(config, makeConfigFile(true));
    const res = await handler(
      rpc(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "message/send",
          params: { message: validMessage },
        },
        { "x-a2a-sender-id": "assistant-b" },
      ),
    );
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("rejected");
  });
});
