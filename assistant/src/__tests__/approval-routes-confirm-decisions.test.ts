/**
 * POST /v1/confirm decision-verb handling for temporary approval grants
 * (allow_10m / allow_conversation), recovered from upstream e05896063f /
 * 46d64df40d^.
 *
 * Handler-level tests: pending interactions are registered against the real
 * tracker; the conversation registry is mocked so handleConfirmationResponse
 * calls can be observed.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const handleConfirmationResponseMock = mock(
  (_requestId: string, _decision: string, _options?: unknown) => {},
);

const actualRegistry = await import("../daemon/conversation-registry.js");
mock.module("../daemon/conversation-registry.js", () => ({
  ...actualRegistry,
  findConversation: (conversationId: string) =>
    conversationId === "conv-1"
      ? { handleConfirmationResponse: handleConfirmationResponseMock }
      : undefined,
}));

const { ROUTES } = await import("../runtime/routes/approval-routes.js");
const pendingInteractions = await import("../runtime/pending-interactions.js");
const { DEFAULT_TIMED_DURATION_MS } =
  await import("../runtime/conversation-approval-overrides.js");
const { BadRequestError, NotFoundError } =
  await import("../runtime/routes/errors.js");

const confirmHandler = ROUTES.find((r) => r.operationId === "confirm")!.handler;

let requestCounter = 0;

function registerConfirmation(options?: {
  directResolve?: (decision: string) => void;
}): string {
  const requestId = `req-${++requestCounter}`;
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "confirmation",
    confirmationDetails: {
      toolName: "test_tool",
      input: {},
      riskLevel: "medium",
      allowlistOptions: [],
      scopeOptions: [],
      persistentDecisionsAllowed: true,
    },
    ...(options?.directResolve
      ? { directResolve: options.directResolve as never }
      : {}),
  } as never);
  return requestId;
}

beforeEach(() => {
  handleConfirmationResponseMock.mockClear();
});

describe("POST /v1/confirm decision verbs", () => {
  test("rejects unknown decisions", () => {
    const requestId = registerConfirmation();
    expect(() =>
      confirmHandler({
        body: { requestId, decision: "always_maybe" },
      } as never),
    ).toThrow(BadRequestError);
  });

  test("404s for unknown requestId", () => {
    expect(() =>
      confirmHandler({
        body: { requestId: "nope", decision: "allow" },
      } as never),
    ).toThrow(NotFoundError);
  });

  test("plain allow resolves without an approvalOverride echo", () => {
    const requestId = registerConfirmation();
    const result = confirmHandler({
      body: { requestId, decision: "allow" },
    } as never) as { accepted: boolean; approvalOverride?: unknown };
    expect(result.accepted).toBe(true);
    expect(result.approvalOverride).toBeUndefined();
    expect(handleConfirmationResponseMock).toHaveBeenCalledTimes(1);
    expect(handleConfirmationResponseMock.mock.calls[0]![1]).toBe("allow");
  });

  test("allow_10m passes through and echoes a timed approvalOverride", () => {
    const requestId = registerConfirmation();
    const before = Date.now();
    const result = confirmHandler({
      body: { requestId, decision: "allow_10m" },
    } as never) as {
      accepted: boolean;
      approvalOverride?: {
        kind: string;
        conversationId: string;
        expiresAt: number | null;
      };
    };
    expect(result.accepted).toBe(true);
    expect(result.approvalOverride?.kind).toBe("timed");
    expect(result.approvalOverride?.conversationId).toBe("conv-1");
    expect(result.approvalOverride?.expiresAt).toBeGreaterThanOrEqual(
      before + DEFAULT_TIMED_DURATION_MS,
    );
    expect(handleConfirmationResponseMock.mock.calls[0]![1]).toBe("allow_10m");
  });

  test("allow_conversation passes through and echoes a conversation approvalOverride", () => {
    const requestId = registerConfirmation();
    const result = confirmHandler({
      body: { requestId, decision: "allow_conversation" },
    } as never) as {
      accepted: boolean;
      approvalOverride?: { kind: string; expiresAt: number | null };
    };
    expect(result.accepted).toBe(true);
    expect(result.approvalOverride?.kind).toBe("conversation");
    expect(result.approvalOverride?.expiresAt).toBeNull();
    expect(handleConfirmationResponseMock.mock.calls[0]![1]).toBe(
      "allow_conversation",
    );
  });

  test("deny resolves without an approvalOverride echo", () => {
    const requestId = registerConfirmation();
    const result = confirmHandler({
      body: { requestId, decision: "deny" },
    } as never) as { accepted: boolean; approvalOverride?: unknown };
    expect(result.accepted).toBe(true);
    expect(result.approvalOverride).toBeUndefined();
    expect(handleConfirmationResponseMock.mock.calls[0]![1]).toBe("deny");
  });

  test("direct-resolve (ACP) interactions downgrade grant verbs to a one-shot allow", () => {
    const directResolve = mock((_decision: string) => {});
    const requestId = registerConfirmation({ directResolve });
    const result = confirmHandler({
      body: { requestId, decision: "allow_10m" },
    } as never) as { accepted: boolean; approvalOverride?: unknown };
    expect(result.accepted).toBe(true);
    // No override echo, no conversation resolution — the ACP path degrades
    // to a plain allow because no permission-checker flow backs it.
    expect(result.approvalOverride).toBeUndefined();
    expect(directResolve).toHaveBeenCalledTimes(1);
    expect(directResolve.mock.calls[0]![0]).toBe("allow");
    expect(handleConfirmationResponseMock).not.toHaveBeenCalled();
  });
});
