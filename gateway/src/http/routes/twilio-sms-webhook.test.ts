/**
 * Unit tests for the Twilio SMS webhook gateway handler.
 *
 * Mirrors the twilio-voice-webhook.test.ts harness: mocks
 * validateTwilioWebhookRequest so form bodies pass straight through, and
 * verifies:
 * - Valid inbound SMS is normalized and forwarded via handleInbound with an
 *   "sms" event and the /deliver/sms reply callback.
 * - Duplicate Message SIDs are deduped.
 * - Routing rejections send a rate-limited SMS notice and do not forward.
 * - Validation failures are propagated as responses.
 * - Empty payloads (no From/MessageSid) are acknowledged without forwarding.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────────

const handleInboundMock = mock(() =>
  Promise.resolve({ forwarded: true, rejected: false }),
);
const sendSmsReplyMock = mock(() => Promise.resolve());
const resetConversationMock = mock(() => Promise.resolve());

mock.module("../../handlers/handle-inbound.js", () => ({
  handleInbound: handleInboundMock,
}));

mock.module("../../twilio/sms-send.js", () => ({
  sendSmsReply: sendSmsReplyMock,
}));

mock.module("../../runtime/client.js", () => ({
  resetConversation: resetConversationMock,
  CircuitBreakerOpenError: class extends Error {
    retryAfterSecs = 5;
  },
}));

mock.module("../../twilio/validate-webhook.js", () => ({
  validateTwilioWebhookRequest: async (req: Request) => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (req.headers.get("x-test-fail-validation")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const rawBody = await req.text();
    const formData = new URLSearchParams(rawBody);
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      params[key] = value;
    }
    return { rawBody, params };
  },
}));

mock.module("../../logger.js", () => ({
  getLogger: () => {
    const noop = () => {};
    const logger: Record<string, unknown> = {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    };
    logger.child = () => logger;
    return logger;
  },
}));

const { createTwilioSmsWebhookHandler } =
  await import("./twilio-sms-webhook.js");
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import type { ConfigFileCache } from "../../config-file-cache.js";

// ── Test config ────────────────────────────────────────────────────────

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
  defaultAssistantId: "assistant-1",
  gatewayInternalBaseUrl: "http://127.0.0.1:7830",
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: {
    telegram: 50 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    default: 50 * 1024 * 1024,
  },
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  unmappedPolicy: "default",
  trustProxy: false,
} as GatewayConfig;

const rejectConfig: GatewayConfig = {
  ...baseConfig,
  defaultAssistantId: undefined,
  unmappedPolicy: "reject",
};

const testCaches = {
  credentials: {} as CredentialCache,
  configFile: {} as ConfigFileCache,
};

let sidCounter = 0;
function uniqueSid(): string {
  sidCounter += 1;
  return `SMtest${String(sidCounter).padStart(6, "0")}`;
}

function makeSmsRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(params).toString();
  return new Request("http://127.0.0.1:7830/webhooks/twilio/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

function smsParams(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    MessageSid: uniqueSid(),
    From: "+14155550101",
    To: "+14155550102",
    Body: "Hello assistant",
    NumMedia: "0",
    ...overrides,
  } as Record<string, string>;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("twilio sms webhook handler", () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    sendSmsReplyMock.mockClear();
    resetConversationMock.mockClear();
  });

  test("forwards a valid inbound SMS as an sms event", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const res = await handler(
      makeSmsRequest(smsParams({ Body: "what's on my calendar?" })),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/xml");
    expect(handleInboundMock).toHaveBeenCalledTimes(1);

    const [, event, options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      {
        sourceChannel: string;
        message: { content: string; conversationExternalId: string };
        actor: { actorExternalId: string };
      },
      { replyCallbackUrl?: string },
    ];
    expect(event.sourceChannel).toBe("sms");
    expect(event.message.content).toBe("what's on my calendar?");
    expect(event.message.conversationExternalId).toBe("+14155550101");
    expect(event.actor.actorExternalId).toBe("+14155550101");
    expect(options.replyCallbackUrl).toBe("http://127.0.0.1:7830/deliver/sms");
  });

  test("dedupes repeated Message SIDs", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const params = smsParams();

    const res1 = await handler(makeSmsRequest(params));
    const res2 = await handler(makeSmsRequest(params));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
  });

  test("routing rejection sends a notice and does not forward", async () => {
    const { handler } = createTwilioSmsWebhookHandler(rejectConfig, testCaches);
    const res = await handler(
      makeSmsRequest(smsParams({ From: "+14155550103" })),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
    expect(sendSmsReplyMock).toHaveBeenCalledTimes(1);
  });

  test("validation failure response is propagated", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const res = await handler(
      makeSmsRequest(smsParams(), { "x-test-fail-validation": "1" }),
    );

    expect(res.status).toBe(403);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  test("payload without From/MessageSid is acknowledged silently", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const res = await handler(
      makeSmsRequest({ SmsStatus: "delivered", MessageStatus: "delivered" }),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  test("/new command resets the conversation instead of forwarding", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const res = await handler(makeSmsRequest(smsParams({ Body: "/new" })));

    expect(res.status).toBe(200);
    expect(handleInboundMock).not.toHaveBeenCalled();
    expect(resetConversationMock).toHaveBeenCalledTimes(1);
  });

  test("forwarding failure returns 500 so Twilio retries", async () => {
    handleInboundMock.mockImplementationOnce(() =>
      Promise.resolve({ forwarded: false, rejected: false }),
    );
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const params = smsParams();

    const res = await handler(makeSmsRequest(params));
    expect(res.status).toBe(500);

    // The dedup entry was unreserved — a retry is processed again.
    const res2 = await handler(makeSmsRequest(params));
    expect(res2.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(2);
  });

  test("MMS media message forwards with an omission notice", async () => {
    const { handler } = createTwilioSmsWebhookHandler(baseConfig, testCaches);
    const res = await handler(
      makeSmsRequest(smsParams({ Body: "", NumMedia: "1" })),
    );

    expect(res.status).toBe(200);
    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [, event] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      { message: { content: string } },
    ];
    expect(event.message.content).toContain("media");
  });
});
