import { describe, expect, test } from "bun:test";

import { normalizeTwilioSmsWebhook } from "../twilio/sms-normalize.js";

function makeParams(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    MessageSid: "SM1234567890abcdef1234567890abcdef",
    AccountSid: "AC123",
    From: "+14155550101",
    To: "+14155550102",
    Body: "Hello assistant",
    NumMedia: "0",
    ...overrides,
  } as Record<string, string>;
}

describe("normalizeTwilioSmsWebhook", () => {
  test("normalizes a plain text message into an sms GatewayInboundEvent", () => {
    const result = normalizeTwilioSmsWebhook(makeParams());

    expect(result).not.toBeNull();
    expect(result!.messageSid).toBe("SM1234567890abcdef1234567890abcdef");
    expect(result!.numMedia).toBe(0);

    const event = result!.event;
    expect(event.version).toBe("v1");
    expect(event.sourceChannel).toBe("sms");
    expect(event.message.content).toBe("Hello assistant");
    // Both identities are the sender's E.164 number
    expect(event.message.conversationExternalId).toBe("+14155550101");
    expect(event.actor.actorExternalId).toBe("+14155550101");
    expect(event.message.externalMessageId).toBe(
      "SM1234567890abcdef1234567890abcdef",
    );
    expect(event.source.updateId).toBe("SM1234567890abcdef1234567890abcdef");
    expect(event.source.chatType).toBe("private");
    expect(event.raw.To).toBe("+14155550102");
  });

  test("trims whitespace from the body", () => {
    const result = normalizeTwilioSmsWebhook(
      makeParams({ Body: "  spaced out  " }),
    );
    expect(result!.event.message.content).toBe("spaced out");
  });

  test("returns null when From is missing", () => {
    const params = makeParams();
    delete params.From;
    expect(normalizeTwilioSmsWebhook(params)).toBeNull();
  });

  test("returns null when MessageSid is missing", () => {
    const params = makeParams();
    delete params.MessageSid;
    expect(normalizeTwilioSmsWebhook(params)).toBeNull();
  });

  test("returns null for an empty message with no media", () => {
    expect(
      normalizeTwilioSmsWebhook(makeParams({ Body: "   ", NumMedia: "0" })),
    ).toBeNull();
  });

  test("appends an MMS notice when NumMedia > 0", () => {
    const result = normalizeTwilioSmsWebhook(
      makeParams({ Body: "check this out", NumMedia: "2" }),
    );
    expect(result!.numMedia).toBe(2);
    expect(result!.event.message.content).toContain("check this out");
    expect(result!.event.message.content).toContain("2 media item(s)");
  });

  test("media-only message (empty body, NumMedia > 0) still produces an event", () => {
    const result = normalizeTwilioSmsWebhook(
      makeParams({ Body: "", NumMedia: "1" }),
    );
    expect(result).not.toBeNull();
    expect(result!.event.message.content).toContain("1 media item(s)");
  });

  test("tolerates a malformed NumMedia value", () => {
    const result = normalizeTwilioSmsWebhook(
      makeParams({ Body: "hi", NumMedia: "not-a-number" }),
    );
    expect(result!.numMedia).toBe(0);
    expect(result!.event.message.content).toBe("hi");
  });
});
