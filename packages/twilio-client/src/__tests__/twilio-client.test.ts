import { describe, expect, mock, test } from "bun:test";

import {
  lookupIncomingPhoneNumberSid,
  sendSmsMessage,
  twilioAuthHeader,
  twilioBaseUrl,
  TwilioRestError,
  updatePhoneNumberWebhooks,
  type TwilioFetch,
} from "../index.js";

const ACCOUNT_SID = "AC123";
const AUTH_TOKEN = "auth-token";
const PHONE_NUMBER = "+15550100";
const PHONE_NUMBER_SID = "PN123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("twilioAuthHeader", () => {
  test("returns a Basic auth header", () => {
    expect(twilioAuthHeader("AC_test_sid", "test_token")).toBe(
      "Basic " + Buffer.from("AC_test_sid:test_token").toString("base64"),
    );
  });
});

describe("twilioBaseUrl", () => {
  test("constructs the account-scoped REST API URL", () => {
    expect(twilioBaseUrl("AC_abc123")).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC_abc123",
    );
  });
});

describe("lookupIncomingPhoneNumberSid", () => {
  test("returns the matching incoming phone number SID", async () => {
    const fetchImpl = mock<TwilioFetch>(async () =>
      jsonResponse({
        incoming_phone_numbers: [
          { phone_number: "+15550199", sid: "PN_OTHER" },
          { phone_number: PHONE_NUMBER, sid: PHONE_NUMBER_SID },
        ],
      }),
    );

    await expect(
      lookupIncomingPhoneNumberSid({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fetchImpl,
        phoneNumber: PHONE_NUMBER,
      }),
    ).resolves.toBe(PHONE_NUMBER_SID);
  });

  test("throws TwilioRestError for lookup failures", async () => {
    const fetchImpl = mock<TwilioFetch>(
      async () => new Response("unavailable", { status: 503 }),
    );

    await expect(
      lookupIncomingPhoneNumberSid({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fetchImpl,
        phoneNumber: PHONE_NUMBER,
      }),
    ).rejects.toBeInstanceOf(TwilioRestError);
  });
});

describe("updatePhoneNumberWebhooks", () => {
  test("looks up the SID and posts voice webhook settings", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      [];
    const fetchImpl = mock<TwilioFetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input, init });
        if (calls.length === 1) {
          return jsonResponse({
            incoming_phone_numbers: [
              { phone_number: PHONE_NUMBER, sid: PHONE_NUMBER_SID },
            ],
          });
        }
        return jsonResponse({});
      },
    );

    await updatePhoneNumberWebhooks({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetchImpl,
      phoneNumber: PHONE_NUMBER,
      webhooks: {
        statusCallbackUrl: "https://example.test/webhooks/twilio/status",
        voiceUrl: "https://example.test/webhooks/twilio/voice",
        smsUrl: "https://example.test/webhooks/twilio/sms",
      },
    });

    expect(calls).toHaveLength(2);
    expect(String(calls[0].input)).toContain(
      `/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=%2B15550100`,
    );
    expect(String(calls[1].input)).toContain(
      `/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers/${PHONE_NUMBER_SID}.json`,
    );
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].init?.headers).toEqual({
      Authorization:
        "Basic " +
        Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(String(calls[1].init?.body));
    expect(body.get("VoiceUrl")).toBe(
      "https://example.test/webhooks/twilio/voice",
    );
    expect(body.get("StatusCallback")).toBe(
      "https://example.test/webhooks/twilio/status",
    );
    expect(body.get("SmsUrl")).toBe("https://example.test/webhooks/twilio/sms");
    expect(body.get("SmsMethod")).toBe("POST");
  });
});

describe("sendSmsMessage", () => {
  test("posts To/From/Body to the Messages endpoint", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      [];
    const fetchImpl = mock<TwilioFetch>(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input, init });
        return jsonResponse({ sid: "SM123" });
      },
    );

    const result = await sendSmsMessage({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetchImpl,
      to: "+14155550104",
      from: PHONE_NUMBER,
      body: "hello from the assistant",
    });

    expect(result.sid).toBe("SM123");
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("To")).toBe("+14155550104");
    expect(body.get("From")).toBe(PHONE_NUMBER);
    expect(body.get("Body")).toBe("hello from the assistant");
  });

  test("throws TwilioRestError on API failure", async () => {
    const fetchImpl = mock<TwilioFetch>(
      async () => new Response("bad request", { status: 400 }),
    );

    await expect(
      sendSmsMessage({
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fetchImpl,
        to: "+14155550104",
        from: PHONE_NUMBER,
        body: "hello",
      }),
    ).rejects.toBeInstanceOf(TwilioRestError);
  });
});
