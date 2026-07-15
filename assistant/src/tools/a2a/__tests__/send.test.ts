import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../types.js";
import { RiskLevel } from "../../types.js";
import {
  A2A_OUTBOUND_ENV_FLAG,
  A2A_SEND_TIMEOUT_MS,
  a2aSendTool,
  buildA2ASendEnvelope,
  executeA2ASend,
  getA2AOutboundToolsIfEnabled,
  isA2AOutboundEnabled,
  resolveA2AEndpoint,
} from "../send.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-test",
    workingDir: "/tmp",
    trustClass: "guardian",
    ...overrides,
  };
}

/** A fetch mock that records requests and returns a canned response. */
function makeFetchMock(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function submittedTaskResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        id: "task-123",
        context_id: "ctx-456",
        status: { state: "submitted" },
      },
    }),
    { status: 200, headers: { "content-type": "application/a2a+json" } },
  );
}

const savedFlag = process.env[A2A_OUTBOUND_ENV_FLAG];

beforeEach(() => {
  delete process.env[A2A_OUTBOUND_ENV_FLAG];
});

afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env[A2A_OUTBOUND_ENV_FLAG];
  } else {
    process.env[A2A_OUTBOUND_ENV_FLAG] = savedFlag;
  }
});

// ---------------------------------------------------------------------------
// Flag gating
// ---------------------------------------------------------------------------

describe("a2a_send flag gating", () => {
  test("flag absent: not enabled, manifest hook returns no tools", () => {
    expect(isA2AOutboundEnabled()).toBe(false);
    expect(getA2AOutboundToolsIfEnabled()).toEqual([]);
  });

  test("flag set to values other than '1' stays disabled", () => {
    for (const value of ["0", "true", "yes", ""]) {
      process.env[A2A_OUTBOUND_ENV_FLAG] = value;
      expect(isA2AOutboundEnabled()).toBe(false);
      expect(getA2AOutboundToolsIfEnabled()).toEqual([]);
    }
  });

  test("flag=1: manifest hook surfaces exactly the a2a_send tool", () => {
    process.env[A2A_OUTBOUND_ENV_FLAG] = "1";
    const tools = getA2AOutboundToolsIfEnabled();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(a2aSendTool);
    expect(tools[0]?.name).toBe("a2a_send");
  });

  test("execute refuses with a clear disabled error when flag absent", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      { fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled");
    expect(result.content).toContain(A2A_OUTBOUND_ENV_FLAG);
    expect(calls).toHaveLength(0); // nothing left the machine
  });
});

// ---------------------------------------------------------------------------
// Risk / approval class
// ---------------------------------------------------------------------------

describe("a2a_send risk classification", () => {
  test("declares High default risk (outbound send must not auto-run)", () => {
    expect(a2aSendTool.defaultRiskLevel).toBe(RiskLevel.High);
  });

  test("tool name classifies as autonomy class 'send'", async () => {
    const { classifyAutonomy } =
      await import("../../../permissions/autonomy-class.js");
    expect(classifyAutonomy("a2a_send")).toBe("send");
  });
});

// ---------------------------------------------------------------------------
// Wire payload shape — mirrors the inbound validators exactly:
// gateway/src/http/routes/a2a-message-send.ts (JSON-RPC envelope + sender
// identity) and handleCreateA2AInboundTask in
// assistant/src/runtime/routes/integrations/a2a.ts (message shape).
// ---------------------------------------------------------------------------

/**
 * Replicates the gateway's `message/send` validation so any drift in our
 * outbound envelope fails here the same way the peer would reject it.
 */
function assertAcceptedByInboundValidator(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): void {
  // Envelope checks (gateway handler).
  expect(body.jsonrpc).toBe("2.0");
  expect(typeof body.id === "string" || typeof body.id === "number").toBe(true);
  expect(body.method === "message/send" || body.method === "message:send").toBe(
    true,
  );

  const params = body.params as {
    message?: {
      message_id?: unknown;
      role?: unknown;
      parts?: unknown;
      context_id?: unknown;
    };
    metadata?: { senderId?: unknown };
  };
  const message = params.message;
  // params.message must be a valid A2A message (message_id, role, parts).
  expect(message).toBeDefined();
  expect(typeof message?.message_id).toBe("string");
  expect((message?.message_id as string).length).toBeGreaterThan(0);
  expect(message?.role === "user" || message?.role === "agent").toBe(true);
  expect(Array.isArray(message?.parts)).toBe(true);

  // Sender identity: header wins, then params.metadata.senderId — the
  // gateway rejects when neither is present.
  const senderId =
    headers["x-a2a-sender-id"]?.trim() ||
    (typeof params.metadata?.senderId === "string"
      ? params.metadata.senderId.trim()
      : "");
  expect(senderId.length).toBeGreaterThan(0);
}

describe("a2a_send wire payload", () => {
  beforeEach(() => {
    process.env[A2A_OUTBOUND_ENV_FLAG] = "1";
  });

  test("POSTs a message/send envelope the inbound validator accepts", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    const result = await executeA2ASend(
      {
        peer_url: "https://peer.example.com",
        message: "hello peer",
        context_id: "ctx-456",
      },
      makeContext(),
      {
        fetchImpl,
        resolveBearerToken: async () => "peer-token-abc",
        resolveSenderId: () => "https://me.example.com",
      },
    );
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    // Bare origin gets the canonical inbound path appended.
    expect(call.url).toBe("https://peer.example.com/a2a/message:send");
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/a2a+json");
    expect(headers["A2A-Version"]).toBe("1.0");
    expect(headers["x-a2a-sender-id"]).toBe("https://me.example.com");
    expect(headers["Authorization"]).toBe("Bearer peer-token-abc");

    const body = JSON.parse(call.init.body as string) as Record<
      string,
      unknown
    >;
    assertAcceptedByInboundValidator(body, headers);

    const params = body.params as {
      message: {
        message_id: string;
        role: string;
        parts: Array<{ kind: string; text: string }>;
        context_id?: string;
      };
      metadata?: { senderId?: string };
    };
    expect(params.message.role).toBe("user");
    expect(params.message.parts).toEqual([
      { kind: "text", text: "hello peer" },
    ]);
    expect(params.message.context_id).toBe("ctx-456");
    expect(params.metadata?.senderId).toBe("https://me.example.com");

    // Payload carries only the message text + generated ids — no token,
    // no workspace paths.
    expect(call.init.body as string).not.toContain("peer-token-abc");
  });

  test("explicit peer_url path is used verbatim", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    await executeA2ASend(
      {
        peer_url: "https://peer.example.com/custom/a2a-endpoint",
        message: "hi",
      },
      makeContext(),
      { fetchImpl, resolveSenderId: () => "me" },
    );
    expect(calls[0]?.url).toBe("https://peer.example.com/custom/a2a-endpoint");
  });

  test("sends unauthenticated when no peer token is stored", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      {
        fetchImpl,
        resolveBearerToken: async () => undefined,
        resolveSenderId: () => "me",
      },
    );
    expect(result.isError).toBe(false);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("omits context_id and metadata when not provided/resolvable", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      {
        fetchImpl,
        resolveBearerToken: async () => undefined,
        resolveSenderId: () => undefined,
      },
    );
    const body = JSON.parse(calls[0]?.init.body as string) as {
      params: { message: { context_id?: string }; metadata?: unknown };
    };
    expect(body.params.message.context_id).toBeUndefined();
    expect(body.params.metadata).toBeUndefined();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-a2a-sender-id"]).toBeUndefined();
  });

  test("buildA2ASendEnvelope generates unique message ids", () => {
    const a = buildA2ASendEnvelope({ message: "x" });
    const b = buildA2ASendEnvelope({ message: "x" });
    expect(a.params.message.message_id).not.toBe(b.params.message.message_id);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

describe("a2a_send response handling", () => {
  beforeEach(() => {
    process.env[A2A_OUTBOUND_ENV_FLAG] = "1";
  });

  const deps = (fetchImpl: typeof fetch) => ({
    fetchImpl,
    resolveBearerToken: async () => undefined,
    resolveSenderId: () => "me",
  });

  test("returns a compact delivered summary with the peer's task id", async () => {
    const { fetchImpl } = makeFetchMock(submittedTaskResponse);
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      deps(fetchImpl),
    );
    expect(result.isError).toBe(false);
    const summary = JSON.parse(result.content) as Record<string, unknown>;
    expect(summary.delivered).toBe(true);
    expect(summary.peer).toBe("https://peer.example.com");
    expect(summary.taskId).toBe("task-123");
    expect(summary.contextId).toBe("ctx-456");
    expect(summary.taskState).toBe("submitted");
    expect(typeof summary.messageId).toBe("string");
  });

  test("surfaces a JSON-RPC error from the peer", async () => {
    const { fetchImpl } = makeFetchMock(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "rpc-1",
            error: {
              code: -32600,
              message:
                "A2A message rejected: sender is not a trusted A2A contact",
            },
          }),
          { status: 200 },
        ),
    );
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      deps(fetchImpl),
    );
    expect(result.isError).toBe(true);
    const summary = JSON.parse(result.content) as {
      delivered: boolean;
      peerError?: { code?: number; message?: string };
    };
    expect(summary.delivered).toBe(false);
    expect(summary.peerError?.code).toBe(-32600);
    expect(summary.peerError?.message).toContain("not a trusted A2A contact");
  });

  test("surfaces non-2xx HTTP failures with status and truncated body", async () => {
    const { fetchImpl } = makeFetchMock(
      () => new Response("upstream exploded", { status: 502 }),
    );
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      deps(fetchImpl),
    );
    expect(result.isError).toBe(true);
    const summary = JSON.parse(result.content) as Record<string, unknown>;
    expect(summary.delivered).toBe(false);
    expect(summary.httpStatus).toBe(502);
    expect(summary.error).toContain("upstream exploded");
  });

  test("timeout surfaces cleanly and makes exactly one attempt", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      deps(fetchImpl),
    );
    expect(result.isError).toBe(true);
    expect(attempts).toBe(1); // no retry storm
    const summary = JSON.parse(result.content) as Record<string, unknown>;
    expect(summary.delivered).toBe(false);
    expect(summary.error).toContain(`${A2A_SEND_TIMEOUT_MS / 1000}s`);
  });

  test("network errors surface cleanly with one attempt", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi" },
      makeContext(),
      deps(fetchImpl),
    );
    expect(result.isError).toBe(true);
    expect(attempts).toBe(1);
    expect(result.content).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("a2a_send input validation", () => {
  beforeEach(() => {
    process.env[A2A_OUTBOUND_ENV_FLAG] = "1";
  });

  test("rejects missing/empty peer_url and message without any network call", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    const noUrl = await executeA2ASend({ message: "hi" }, makeContext(), {
      fetchImpl,
    });
    expect(noUrl.isError).toBe(true);
    expect(noUrl.content).toContain("peer_url");

    const noMessage = await executeA2ASend(
      { peer_url: "https://peer.example.com" },
      makeContext(),
      { fetchImpl },
    );
    expect(noMessage.isError).toBe(true);
    expect(noMessage.content).toContain("message");

    const badContext = await executeA2ASend(
      { peer_url: "https://peer.example.com", message: "hi", context_id: 5 },
      makeContext(),
      { fetchImpl },
    );
    expect(badContext.isError).toBe(true);
    expect(badContext.content).toContain("context_id");

    expect(calls).toHaveLength(0);
  });

  test("rejects non-http(s) peer_url", async () => {
    const { calls, fetchImpl } = makeFetchMock(submittedTaskResponse);
    const result = await executeA2ASend(
      { peer_url: "ftp://peer.example.com", message: "hi" },
      makeContext(),
      { fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("http");
    expect(calls).toHaveLength(0);
  });

  test("resolveA2AEndpoint appends the default path only for bare origins", () => {
    expect(resolveA2AEndpoint("https://p.example.com").href).toBe(
      "https://p.example.com/a2a/message:send",
    );
    expect(resolveA2AEndpoint("https://p.example.com/").href).toBe(
      "https://p.example.com/a2a/message:send",
    );
    expect(resolveA2AEndpoint("https://p.example.com/x/y").pathname).toBe(
      "/x/y",
    );
  });
});
